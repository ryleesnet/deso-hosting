/**
 * PayPal webhook receiver.
 *
 * Register this URL in the PayPal Developer Dashboard (Sandbox + Live) at
 * `${APP_PUBLIC_URL}/api/paypal/webhook` and subscribe to at least:
 *   - BILLING.SUBSCRIPTION.ACTIVATED
 *   - BILLING.SUBSCRIPTION.UPDATED
 *   - BILLING.SUBSCRIPTION.SUSPENDED
 *   - BILLING.SUBSCRIPTION.CANCELLED
 *   - BILLING.SUBSCRIPTION.EXPIRED
 *   - BILLING.SUBSCRIPTION.PAYMENT.FAILED
 *   - PAYMENT.SALE.COMPLETED
 *   - PAYMENT.SALE.REFUNDED
 *
 * Behavior:
 *  - Every request is verified against PayPal's `/verify-webhook-signature`.
 *  - `event.id` is used as the idempotency key (Firestore `paypal_events`).
 *  - PAYMENT.SALE.COMPLETED extends the linked order's Subscription by taking
 *    PayPal's `next_billing_time` as the new `nextPaymentAt` (or +1 month if
 *    PayPal didn't return one), and creates a `renewal_txs/paypal_<sale.id>`
 *    record with the correct DESO-equivalent nanos for reporting.
 *  - Any subscription failure/cancel event marks the Firestore Subscription
 *    `past_due` so the existing dunning cron suspends the VPS after
 *    `BILLING_SUSPEND_AFTER_DAYS_PAST_DUE`.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  commitSubscriptionRenewalWithTxRecord,
  getRenewalTxByHash,
  getService,
  getSubscriptionByOrder,
  recordPaypalEventIfNew,
  updateOrder,
  updateSubscription,
  type Order,
} from "@/lib/db";
import {
  getPaypalSubscription,
  verifyPaypalWebhookSignature,
  type PaypalWebhookEvent,
} from "@/lib/paypal";
import { resumeOrderAfterPayment } from "@/lib/order-lifecycle";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import { usdCentsToNanos } from "@/lib/pricing";

// PayPal webhook payloads occasionally include large stringified data, but
// we keep them tight in memory by reading once as text.

async function findOrderBySubscriptionId(
  subscriptionId: string
): Promise<Order | undefined> {
  // We don't have a Firestore index on paypalSubscriptionId, so scan the
  // caller's orders via the collection group. Volumes are small (per user),
  // and this only runs on webhook — call sites are rare.
  const { getOrders } = await import("@/lib/db");
  const orders = await getOrders();
  return orders.find((o) => o.paypalSubscriptionId === subscriptionId);
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const ok = await verifyPaypalWebhookSignature(req, rawBody);
  if (!ok) {
    console.warn("[paypal webhook] signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: PaypalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PaypalWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!event.id || !event.event_type) {
    return NextResponse.json({ error: "Missing event id" }, { status: 400 });
  }

  // Idempotency: skip work if we already processed this event id.
  const seen = await recordPaypalEventIfNew(event.id, event.event_type);
  if (seen === "duplicate") {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    switch (event.event_type) {
      case "PAYMENT.SALE.COMPLETED":
        await handleSaleCompleted(event);
        break;
      case "PAYMENT.SALE.REFUNDED":
        await handleSaleRefunded(event);
        break;
      case "BILLING.SUBSCRIPTION.ACTIVATED":
        await handleSubscriptionActivated(event);
        break;
      case "BILLING.SUBSCRIPTION.SUSPENDED":
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
        await handleSubscriptionFailure(event);
        break;
      case "BILLING.SUBSCRIPTION.UPDATED":
        // No-op today: we let PAYMENT.SALE.COMPLETED / failures drive state.
        break;
      default:
        // Unknown but signed event — nothing to do. Log and continue.
        console.log("[paypal webhook] unhandled event:", event.event_type);
    }
  } catch (e) {
    // We already stored the event id in `paypal_events`; retries by PayPal
    // will be treated as duplicates. Log so we notice and re-process manually.
    console.error(
      `[paypal webhook] handler failed for ${event.event_type} (${event.id}):`,
      e
    );
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// --------------------------- handlers -----------------------------------

/** Reads `billing_agreement_id` (v1 subs) from a SALE resource. */
function subscriptionIdFromSaleResource(
  resource: Record<string, unknown> | undefined
): string | undefined {
  if (!resource) return undefined;
  const bai = resource["billing_agreement_id"];
  if (typeof bai === "string" && bai.trim()) return bai.trim();
  const sid = resource["subscription_id"];
  if (typeof sid === "string" && sid.trim()) return sid.trim();
  return undefined;
}

function saleIdFromResource(
  resource: Record<string, unknown> | undefined
): string | undefined {
  if (!resource) return undefined;
  const id = resource["id"];
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function amountUsdCentsFromSaleResource(
  resource: Record<string, unknown> | undefined
): number {
  if (!resource) return 0;
  const amount = resource["amount"] as
    | { total?: string; currency?: string; value?: string; currency_code?: string }
    | undefined;
  const raw = amount?.total ?? amount?.value;
  if (typeof raw !== "string") return 0;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

async function handleSaleCompleted(event: PaypalWebhookEvent) {
  const resource = event.resource;
  const subscriptionId = subscriptionIdFromSaleResource(resource);
  const saleId = saleIdFromResource(resource);
  if (!subscriptionId || !saleId) {
    console.warn("[paypal webhook] SALE.COMPLETED missing ids", event.id);
    return;
  }
  const order = await findOrderBySubscriptionId(subscriptionId);
  if (!order) {
    console.warn(
      `[paypal webhook] SALE.COMPLETED subscription ${subscriptionId} not linked to any order`
    );
    return;
  }
  const subscription = await getSubscriptionByOrder(order.id);
  if (!subscription) {
    console.warn(`[paypal webhook] order ${order.id} has no subscription row`);
    return;
  }
  const service = await getService(order.serviceId);
  if (!service) {
    console.warn(`[paypal webhook] service missing for order ${order.id}`);
    return;
  }

  const usdCents = amountUsdCentsFromSaleResource(resource);
  const rate = await getUsdPerDeso().catch(() => null);
  const equivNanos =
    rate && usdCents > 0 ? usdCentsToNanos(usdCents, rate.usdPerDeso) : 0;

  // Idempotency belt-and-braces: `renewal_txs/paypal_<saleId>` is the
  // authoritative record; skip if already applied. `paypal_events` guards
  // us against duplicate deliveries of the same webhook, but a payment can
  // legitimately be represented across multiple event ids (e.g. SALE.COMPLETED
  // then SUBSCRIPTION.UPDATED) that share the same sale.
  const txHashHex = `paypal_${saleId.toLowerCase()}`;
  const alreadyApplied = await getRenewalTxByHash(txHashHex);

  // Pull the canonical next_billing_time from PayPal so our Firestore date
  // stays in sync with PayPal's schedule. Falls back to old+1 month.
  let nextPaymentAtIso = subscription.nextPaymentAt;
  try {
    const pp = await getPaypalSubscription(subscriptionId);
    const nbt = pp.billing_info?.next_billing_time;
    if (typeof nbt === "string" && nbt.trim()) {
      nextPaymentAtIso = nbt;
    } else {
      const t = new Date(subscription.nextPaymentAt);
      const base = Number.isNaN(t.getTime()) ? new Date() : t;
      base.setMonth(base.getMonth() + 1);
      nextPaymentAtIso = base.toISOString();
    }
  } catch (e) {
    console.warn(
      "[paypal webhook] failed to fetch subscription for next_billing_time:",
      e
    );
  }

  const now = new Date().toISOString();

  if (!alreadyApplied) {
    await commitSubscriptionRenewalWithTxRecord({
      txHashHex,
      orderId: order.id,
      subscriptionId: subscription.id,
      totalPaidNanos: equivNanos,
      months: 1,
      subscriptionMonthlyNanos: equivNanos > 0 ? equivNanos : subscription.amountNanos,
      paymentToken: "PAYPAL",
      usdCents,
      lastPaymentAt: now,
      nextPaymentAt: nextPaymentAtIso,
    }).catch((e) => {
      // TX_CONFLICT_ORDER / SUBSCRIPTION_GONE: log but don't abort — the
      // event has already been recorded as processed.
      console.error(
        "[paypal webhook] commitSubscriptionRenewalWithTxRecord:",
        e
      );
    });
  }

  // Always update payment metadata / lift suspension after a completed sale.
  await updateSubscription(subscription.id, {
    paymentProvider: "paypal",
    paypalSubscriptionId: subscriptionId,
  });
  await resumeOrderAfterPayment(order.id).catch((e) =>
    console.error("[paypal webhook] resume after payment:", e)
  );
}

async function handleSaleRefunded(event: PaypalWebhookEvent) {
  const resource = event.resource;
  const subscriptionId = subscriptionIdFromSaleResource(resource);
  if (!subscriptionId) return;
  const order = await findOrderBySubscriptionId(subscriptionId);
  if (!order) return;

  // Full refund → mark subscription past_due so the standard dunning path
  // suspends the VPS after the configured grace window. Admins can still
  // manually record a payment to reactivate if the refund was in error.
  const subscription = await getSubscriptionByOrder(order.id);
  if (subscription && subscription.status !== "cancelled") {
    await updateSubscription(subscription.id, { status: "past_due" });
  }
}

async function handleSubscriptionActivated(event: PaypalWebhookEvent) {
  const resource = event.resource as
    | { id?: string; subscriber?: { email_address?: string } }
    | undefined;
  const subscriptionId = resource?.id;
  if (!subscriptionId) return;
  const order = await findOrderBySubscriptionId(subscriptionId);
  if (!order) return;

  // First payment webhook (PAYMENT.SALE.COMPLETED) will move dates. We just
  // update the payer email if PayPal filled it in post-approval.
  const email = resource?.subscriber?.email_address;
  if (email && !order.paypalPayerEmail) {
    await updateOrder(order.id, { paypalPayerEmail: email });
  }
}

async function handleSubscriptionFailure(event: PaypalWebhookEvent) {
  const resource = event.resource as { id?: string } | undefined;
  const subscriptionId = resource?.id;
  if (!subscriptionId) return;
  const order = await findOrderBySubscriptionId(subscriptionId);
  if (!order) return;
  const subscription = await getSubscriptionByOrder(order.id);
  if (!subscription || subscription.status === "cancelled") return;
  await updateSubscription(subscription.id, { status: "past_due" });
}
