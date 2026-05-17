import { NextRequest, NextResponse } from "next/server";
import {
  getOrdersByUser,
  getOrders,
  getSubscriptions,
} from "@/lib/db";
import { daysRemainingInBillingCycle } from "@/lib/billing";
import type { Order, Subscription } from "@/lib/db";
import { requireUser } from "@/lib/api-auth";

function enrichOrder(
  order: Order,
  subByOrderId: Map<string, Subscription>
) {
  const sub = subByOrderId.get(order.id);
  if (!sub || sub.status === "cancelled") {
    return { ...order, billing: null };
  }
  return {
    ...order,
    billing: {
      nextPaymentAt: sub.nextPaymentAt,
      subscriptionStatus: sub.status,
      daysRemainingInCycle: daysRemainingInBillingCycle(sub.nextPaymentAt),
    },
  };
}

/**
 * Returns the caller's orders. Admins can pass `?as=all` to get every order in the system.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const wantAll = searchParams.get("as") === "all";
  if (wantAll && !auth.isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const subs = await getSubscriptions();
  const subByOrderId = new Map(subs.map((s) => [s.orderId, s]));

  const orders = wantAll
    ? await getOrders()
    : await getOrdersByUser(auth.publicKey);
  return NextResponse.json(orders.map((o) => enrichOrder(o, subByOrderId)));
}
