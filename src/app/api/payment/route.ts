import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  getService,
  getSubscriptionByOrder,
  updateSubscription,
} from "@/lib/db";
import { resumeOrderAfterPayment } from "@/lib/order-lifecycle";
import { requireUser } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await req.json();
    if (!orderId) {
      return NextResponse.json(
        { error: "Missing orderId" },
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

    const service = await getService(order.serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    // In production: verify txHash on DeSo blockchain that payment was sent to PAYMENT_PUBLIC_KEY
    // For now we accept the payment and extend subscription
    const subscription = await getSubscriptionByOrder(orderId);
    if (!subscription) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 }
      );
    }

    const nextPayment = new Date();
    nextPayment.setMonth(nextPayment.getMonth() + 1);

    await updateSubscription(subscription.id, {
      lastPaymentAt: new Date().toISOString(),
      nextPaymentAt: nextPayment.toISOString(),
      status: "active",
    });

    await resumeOrderAfterPayment(orderId).catch((e) =>
      console.error("[payment] resume after payment:", e)
    );

    return NextResponse.json({
      success: true,
      nextPaymentAt: nextPayment.toISOString(),
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Payment verification failed" },
      { status: 500 }
    );
  }
}
