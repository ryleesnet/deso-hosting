/**
 * Attach a *new* PayPal subscription to an *existing* order/subscription.
 *
 * When to use this:
 *  - The order was originally created with DESO or dUSDC and the user wants to
 *    switch to PayPal auto-renew from now on.
 *  - The order's previous PayPal subscription was cancelled (by PayPal, by the
 *    buyer, or by an admin refund) and the user is starting a fresh one.
 *
 * We do NOT change `nextPaymentAt` here — that will move forward when PayPal
 * fires `PAYMENT.SALE.COMPLETED` for the first real charge (see webhook).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  getService,
  getSubscriptionByOrder,
  updateOrder,
  updateSubscription,
} from "@/lib/db";
import { requireUser } from "@/lib/api-auth";
import {
  cancelPaypalSubscription,
  ensurePaypalPlanForService,
  getPaypalSubscription,
  paypalIsConfigured,
} from "@/lib/paypal";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import { monthlyTotalUsdCentsForOrder } from "@/lib/service-pricing";
import {
  paypalSurchargeCents,
  paypalSurchargeConfig,
} from "@/lib/paypal-surcharge";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    if (!paypalIsConfigured()) {
      return NextResponse.json(
        { error: "PayPal is not configured on this server." },
        { status: 503 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      orderId?: unknown;
      paypalSubscriptionId?: unknown;
    };
    const orderId =
      typeof body.orderId === "string" ? body.orderId.trim() : "";
    const paypalSubscriptionId =
      typeof body.paypalSubscriptionId === "string"
        ? body.paypalSubscriptionId.trim()
        : "";
    if (!orderId || !paypalSubscriptionId) {
      return NextResponse.json(
        { error: "orderId and paypalSubscriptionId are required" },
        { status: 400 }
      );
    }

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (order.userId !== auth.publicKey && !auth.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (order.status === "cancelled") {
      return NextResponse.json(
        { error: "This order is cancelled" },
        { status: 400 }
      );
    }

    const subscription = await getSubscriptionByOrder(orderId);
    if (!subscription || subscription.status === "cancelled") {
      return NextResponse.json(
        { error: "No active subscription to link" },
        { status: 400 }
      );
    }

    const service = await getService(order.serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    // Verify the PayPal subscription belongs to this DeSo user and is on the
    // expected plan for the current price snapshot.
    const pp = await getPaypalSubscription(paypalSubscriptionId);
    const okStatus = pp.status === "APPROVED" || pp.status === "ACTIVE";
    if (!okStatus) {
      return NextResponse.json(
        { error: `PayPal subscription status is ${pp.status}` },
        { status: 400 }
      );
    }
    if (
      typeof pp.custom_id === "string" &&
      pp.custom_id.length > 0 &&
      !pp.custom_id.includes(auth.publicKey)
    ) {
      await cancelPaypalSubscription(
        paypalSubscriptionId,
        "Bound to different DeSoHosting user"
      ).catch(() => undefined);
      return NextResponse.json(
        { error: "This PayPal subscription belongs to a different account." },
        { status: 403 }
      );
    }

    const rate = await getUsdPerDeso();
    const baseUsdCents = monthlyTotalUsdCentsForOrder(
      service,
      rate.usdPerDeso,
      order.extraDisksGb
    );
    const surchargeCfg = paypalSurchargeConfig();
    const paypalMonthlyUsdCents =
      baseUsdCents + paypalSurchargeCents(baseUsdCents, surchargeCfg);
    const expected = await ensurePaypalPlanForService(
      service,
      paypalMonthlyUsdCents
    );
    if (pp.plan_id !== expected.paypalPlanId) {
      await cancelPaypalSubscription(
        paypalSubscriptionId,
        "Plan mismatch on renewal"
      ).catch(() => undefined);
      return NextResponse.json(
        {
          error:
            "PayPal subscription is on a different plan than the current price. Please retry.",
        },
        { status: 409 }
      );
    }

    // If the order already has a PayPal subscription attached, cancel the
    // old one so PayPal doesn't keep billing on two subscriptions at once.
    if (
      order.paypalSubscriptionId &&
      order.paypalSubscriptionId !== paypalSubscriptionId
    ) {
      await cancelPaypalSubscription(
        order.paypalSubscriptionId,
        "Replaced by new subscription"
      ).catch((e) =>
        console.warn(
          "[paypal renew] could not cancel previous subscription:",
          e
        )
      );
    }

    await updateOrder(orderId, {
      paymentProvider: "paypal",
      paypalSubscriptionId,
      paypalPlanId: expected.paypalPlanId,
      paypalMonthlyUsdCents,
      ...(pp.subscriber?.email_address
        ? { paypalPayerEmail: pp.subscriber.email_address }
        : {}),
    });
    await updateSubscription(subscription.id, {
      paymentProvider: "paypal",
      paypalSubscriptionId,
    });

    return NextResponse.json({
      success: true,
      paypalSubscriptionId,
      paypalPlanId: expected.paypalPlanId,
      message:
        "PayPal auto-renew linked. You'll see the next billing date update once PayPal processes the first payment.",
    });
  } catch (err) {
    console.error("[paypal renew]", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "PayPal renewal setup failed",
      },
      { status: 500 }
    );
  }
}
