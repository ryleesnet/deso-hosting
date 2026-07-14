import { NextRequest, NextResponse } from "next/server";
import {
  commitBatchSubscriptionRenewalWithTxRecord,
  getOrder,
  getRenewalTxByHash,
  getService,
  getSubscriptionByOrder,
  normalizeRenewalTxHashHex,
} from "@/lib/db";
import {
  monthlyAmountNanosForOrder,
  monthlyTotalUsdCentsForOrder,
} from "@/lib/service-pricing";
import {
  verifyBasicTransferPaymentToRecipient,
  verifyDaoCoinTransferToRecipient,
} from "@/lib/deso-tx-verify";
import { getDesoPaymentRecipientPublicKey } from "@/lib/payment-public-key";
import {
  MAX_BATCH_RENEWAL_ORDERS,
  computeNextPaymentAfterRenewal,
  parseRenewalMonths,
  renewBatchOrderMarker,
  sortRenewBatchItems,
  type RenewBatchItem,
} from "@/lib/renewal-months";
import { resumeOrderAfterPayment } from "@/lib/order-lifecycle";
import { requireUser } from "@/lib/api-auth";
import { DUSDC, parsePaymentToken } from "@/lib/deso-tokens";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";

function skipTxVerify(): boolean {
  const v = process.env.BILLING_SKIP_TX_VERIFY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseBatchItems(raw: unknown): RenewBatchItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: RenewBatchItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") return null;
    const orderId =
      typeof (row as { orderId?: unknown }).orderId === "string"
        ? ((row as { orderId: string }).orderId).trim()
        : "";
    if (!orderId) return null;
    items.push({
      orderId,
      months: parseRenewalMonths((row as { months?: unknown }).months),
    });
  }
  return items;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;
    const publicKey = auth.publicKey;

    const body = await req.json();
    const txHashRaw =
      typeof body.txHash === "string" ? body.txHash.trim() : "";
    const items = parseBatchItems(body.items);
    const paymentToken = parsePaymentToken(body.paymentToken);

    if (!txHashRaw || !items || items.length === 0) {
      return NextResponse.json(
        { error: "txHash and items[] are required" },
        { status: 400 }
      );
    }
    if (items.length > MAX_BATCH_RENEWAL_ORDERS) {
      return NextResponse.json(
        { error: `Too many orders (max ${MAX_BATCH_RENEWAL_ORDERS} per batch).` },
        { status: 400 }
      );
    }
    const uniqueOrderIds = new Set(items.map((i) => i.orderId));
    if (uniqueOrderIds.size !== items.length) {
      return NextResponse.json(
        { error: "Duplicate orderId in batch" },
        { status: 400 }
      );
    }

    const normalizedHash = normalizeRenewalTxHashHex(txHashRaw);
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      return NextResponse.json(
        {
          error:
            "txHash must be a 64-character hex transaction id (TxnHashHex from DeSo Identity)",
        },
        { status: 400 }
      );
    }

    const payee = getDesoPaymentRecipientPublicKey();
    if (!payee) {
      return NextResponse.json(
        { error: "Payment recipient not configured (DESO_PAYMENT_PUBLIC_KEY)" },
        { status: 503 }
      );
    }

    // Load every order + subscription + service and precompute per-order sums
    // BEFORE consulting the idempotency record so that we can compare
    // apples-to-apples if a repeat POST arrives.
    type Prepared = {
      item: RenewBatchItem;
      subscriptionId: string;
      monthlyNanos: number;
      monthlyUsdCents: number;
      perOrderPaidNanos: number;
      perOrderUsdCents: number;
      nextPaymentAt: string;
    };
    const rate = await getUsdPerDeso();
    const prepared: Prepared[] = [];
    let totalRequiredNanos = 0;
    let totalRequiredUsdCents = 0;

    for (const item of items) {
      const order = await getOrder(item.orderId);
      if (!order) {
        return NextResponse.json(
          { error: `Order ${item.orderId} not found` },
          { status: 404 }
        );
      }
      if (order.userId !== publicKey && !auth.isAdmin) {
        return NextResponse.json(
          { error: `Not authorized for order ${item.orderId}` },
          { status: 403 }
        );
      }
      if (order.status === "cancelled") {
        return NextResponse.json(
          { error: `Order ${item.orderId} is cancelled` },
          { status: 400 }
        );
      }
      const subscription = await getSubscriptionByOrder(item.orderId);
      if (
        !subscription ||
        (subscription.status !== "active" && subscription.status !== "past_due")
      ) {
        return NextResponse.json(
          { error: `Order ${item.orderId} has no active subscription to renew` },
          { status: 400 }
        );
      }
      const service = await getService(order.serviceId);
      if (!service) {
        return NextResponse.json(
          { error: `Service missing for order ${item.orderId}` },
          { status: 404 }
        );
      }
      const monthlyNanos = await monthlyAmountNanosForOrder(
        service,
        order.extraDisksGb
      );
      const monthlyUsdCents = monthlyTotalUsdCentsForOrder(
        service,
        rate.usdPerDeso,
        order.extraDisksGb
      );
      const perOrderPaidNanos = monthlyNanos * item.months;
      const perOrderUsdCents = monthlyUsdCents * item.months;
      totalRequiredNanos += perOrderPaidNanos;
      totalRequiredUsdCents += perOrderUsdCents;
      prepared.push({
        item,
        subscriptionId: subscription.id,
        monthlyNanos,
        monthlyUsdCents,
        perOrderPaidNanos,
        perOrderUsdCents,
        nextPaymentAt: computeNextPaymentAfterRenewal(
          subscription.nextPaymentAt,
          item.months
        ),
      });
    }

    const sortedItems = sortRenewBatchItems(items);

    // If this tx has already been processed, honor idempotency (and still
    // resume orders in case a previous crash left them past_due).
    const existing = await getRenewalTxByHash(normalizedHash);
    if (existing) {
      const recorded =
        existing.orderIds && existing.orderIds.length
          ? existing.orderIds
          : existing.orderId
            ? [existing.orderId]
            : [];
      const recordedSorted = [...recorded].sort((a, b) => a.localeCompare(b));
      const requestedSorted = sortedItems.map((i) => i.orderId);
      const same =
        recordedSorted.length === requestedSorted.length &&
        recordedSorted.every((id, idx) => id === requestedSorted[idx]);
      if (!same) {
        return NextResponse.json(
          {
            error:
              "This transaction was already used for a different set of orders",
          },
          { status: 409 }
        );
      }
      for (const p of prepared) {
        await resumeOrderAfterPayment(p.item.orderId).catch((e) =>
          console.error("[billing/renew-batch] resume (idempotent):", e)
        );
      }
      return NextResponse.json({
        success: true,
        idempotent: true,
        count: prepared.length,
        items: prepared.map((p) => ({
          orderId: p.item.orderId,
          months: p.item.months,
          nextPaymentAt: p.nextPaymentAt,
        })),
      });
    }

    if (!skipTxVerify()) {
      // Every per-order marker MUST appear in the memo so a payer can't quietly
      // point a smaller tx at more orders than they actually covered.
      const memoMarkers = sortedItems.map((i) =>
        renewBatchOrderMarker(i.orderId, i.months)
      );

      if (paymentToken === "DUSDC") {
        const requiredBaseUnits =
          BigInt(totalRequiredUsdCents) * 10n ** 16n;
        for (const marker of memoMarkers) {
          const v = await verifyDaoCoinTransferToRecipient({
            transactionIdHexOrBase58: txHashRaw,
            senderPublicKeyBase58: publicKey,
            recipientPublicKeyBase58: payee,
            tokenCreatorPublicKeyBase58: DUSDC.creatorPublicKey,
            minAmountBaseUnits: requiredBaseUnits,
            memoIncludesSubstring: marker,
          });
          if (!v.ok) {
            return NextResponse.json({ error: v.reason }, { status: 400 });
          }
        }
      } else {
        for (const marker of memoMarkers) {
          const v = await verifyBasicTransferPaymentToRecipient({
            transactionIdHexOrBase58: txHashRaw,
            senderPublicKeyBase58: publicKey,
            recipientPublicKeyBase58: payee,
            minAmountNanosToRecipient: totalRequiredNanos,
            memoIncludesSubstring: marker,
          });
          if (!v.ok) {
            return NextResponse.json({ error: v.reason }, { status: 400 });
          }
        }
      }
    } else {
      console.warn(
        "BILLING_SKIP_TX_VERIFY: accepted batch renewal without on-chain verification (dev only)"
      );
    }

    const now = new Date().toISOString();

    try {
      const outcome = await commitBatchSubscriptionRenewalWithTxRecord({
        txHashHex: normalizedHash,
        items: prepared.map((p) => ({
          orderId: p.item.orderId,
          subscriptionId: p.subscriptionId,
          months: p.item.months,
          subscriptionMonthlyNanos: p.monthlyNanos,
          perOrderPaidNanos: p.perOrderPaidNanos,
          nextPaymentAt: p.nextPaymentAt,
        })),
        totalPaidNanos: totalRequiredNanos,
        paymentToken,
        lastPaymentAt: now,
      });

      for (const p of prepared) {
        await resumeOrderAfterPayment(p.item.orderId).catch((e) =>
          console.error("[billing/renew-batch] resume after payment:", e)
        );
      }

      return NextResponse.json({
        success: true,
        idempotent: outcome === "idempotent",
        count: prepared.length,
        items: prepared.map((p) => ({
          orderId: p.item.orderId,
          months: p.item.months,
          nextPaymentAt: p.nextPaymentAt,
        })),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "TX_CONFLICT_ORDER") {
        return NextResponse.json(
          {
            error:
              "This transaction was already used for a different set of orders",
          },
          { status: 409 }
        );
      }
      if (msg === "SUBSCRIPTION_GONE") {
        return NextResponse.json(
          { error: "One of the subscriptions no longer exists" },
          { status: 400 }
        );
      }
      throw e;
    }
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Batch renewal processing failed" },
      { status: 500 }
    );
  }
}
