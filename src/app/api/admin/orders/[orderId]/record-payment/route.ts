import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  getSubscriptionByOrder,
  recordManualSubscriptionPayment,
} from "@/lib/db";
import { resumeOrderAfterPayment } from "@/lib/order-lifecycle";
import {
  computeExpirationFromPaymentDate,
  parsePaymentDate,
  parseRenewalMonths,
} from "@/lib/renewal-months";
import { requireAdmin } from "@/lib/api-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      lastPaymentAt?: unknown;
      nextPaymentAt?: unknown;
      months?: unknown;
    };

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.status === "cancelled") {
      return NextResponse.json(
        { error: "Cannot record payment for a cancelled order" },
        { status: 400 }
      );
    }

    const subscription = await getSubscriptionByOrder(orderId);
    if (!subscription || subscription.status === "cancelled") {
      return NextResponse.json(
        { error: "No active subscription for this order" },
        { status: 400 }
      );
    }

    const lastPaymentRaw =
      typeof body.lastPaymentAt === "string" ? body.lastPaymentAt.trim() : "";
    const lastPaymentAt = lastPaymentRaw
      ? parsePaymentDate(lastPaymentRaw)
      : new Date();
    if (!lastPaymentAt) {
      return NextResponse.json(
        { error: "lastPaymentAt must be a valid date (YYYY-MM-DD or ISO datetime)" },
        { status: 400 }
      );
    }

    const nextPaymentRaw =
      typeof body.nextPaymentAt === "string" ? body.nextPaymentAt.trim() : "";
    let nextPaymentAt: Date;
    if (nextPaymentRaw) {
      const parsed = parsePaymentDate(nextPaymentRaw);
      if (!parsed) {
        return NextResponse.json(
          { error: "nextPaymentAt must be a valid date" },
          { status: 400 }
        );
      }
      nextPaymentAt = parsed;
    } else {
      const months = parseRenewalMonths(body.months);
      nextPaymentAt = computeExpirationFromPaymentDate(lastPaymentAt, months);
    }

    if (nextPaymentAt.getTime() <= lastPaymentAt.getTime()) {
      return NextResponse.json(
        { error: "Expiration must be after the payment date" },
        { status: 400 }
      );
    }

    await recordManualSubscriptionPayment({
      subscriptionId: subscription.id,
      lastPaymentAt: lastPaymentAt.toISOString(),
      nextPaymentAt: nextPaymentAt.toISOString(),
    });

    await resumeOrderAfterPayment(orderId).catch((e) =>
      console.error("[admin/record-payment] resume after payment:", e)
    );

    const updated = await getSubscriptionByOrder(orderId);
    return NextResponse.json({
      success: true,
      lastPaymentAt: updated?.lastPaymentAt ?? lastPaymentAt.toISOString(),
      nextPaymentAt: updated?.nextPaymentAt ?? nextPaymentAt.toISOString(),
    });
  } catch (err) {
    console.error("[admin/record-payment]", err);
    const msg = err instanceof Error ? err.message : "Failed to record payment";
    if (msg === "SUBSCRIPTION_GONE") {
      return NextResponse.json(
        { error: "Subscription no longer exists" },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
