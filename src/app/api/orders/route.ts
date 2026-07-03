import { NextRequest, NextResponse } from "next/server";
import {
  getOrdersByUser,
  getOrders,
  getSubscriptions,
  getSubscriptionsByUser,
} from "@/lib/db";
import {
  daysPastDue,
  daysRemainingInBillingCycle,
  daysUntilGraceEnds,
  effectiveSubscriptionStatus,
} from "@/lib/billing";
import { fetchDesoUsernamesByPublicKeys } from "@/lib/deso-profile";
import { suspendAfterPastDueDays, runBillingDunningIfDue } from "@/lib/order-lifecycle";
import type { Order, Subscription } from "@/lib/db";
import { requireUser } from "@/lib/api-auth";

export type EnrichedOrderBilling = {
  subscriptionId: string;
  lastPaymentAt: string;
  nextPaymentAt: string;
  subscriptionStatus: Subscription["status"];
  daysRemainingInCycle: number;
  daysPastDue: number;
  daysUntilSuspension: number;
};

function enrichOrder(
  order: Order,
  subByOrderId: Map<string, Subscription>
) {
  const sub = subByOrderId.get(order.id);
  if (!sub || sub.status === "cancelled") {
    return { ...order, billing: null as EnrichedOrderBilling | null };
  }

  const graceDays = suspendAfterPastDueDays();
  const status = effectiveSubscriptionStatus(sub.status, sub.nextPaymentAt);
  const overdue = status === "past_due";

  return {
    ...order,
    billing: {
      subscriptionId: sub.id,
      lastPaymentAt: sub.lastPaymentAt,
      nextPaymentAt: sub.nextPaymentAt,
      subscriptionStatus: status,
      daysRemainingInCycle: daysRemainingInBillingCycle(sub.nextPaymentAt),
      daysPastDue: overdue ? daysPastDue(sub.nextPaymentAt) : 0,
      daysUntilSuspension: overdue
        ? daysUntilGraceEnds(sub.nextPaymentAt, graceDays)
        : graceDays,
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

  const subs = wantAll
    ? await getSubscriptions()
    : await getSubscriptionsByUser(auth.publicKey);
  const subByOrderId = new Map(subs.map((s) => [s.orderId, s]));

  await runBillingDunningIfDue();

  const orders = wantAll
    ? await getOrders()
    : await getOrdersByUser(auth.publicKey);

  const enriched = orders.map((o) => enrichOrder(o, subByOrderId));

  if (wantAll) {
    const usernameByPk = await fetchDesoUsernamesByPublicKeys(
      orders.map((o) => o.userId)
    );
    return NextResponse.json(
      enriched.map((o) => ({
        ...o,
        desoUsername: usernameByPk.get(o.userId) ?? null,
      }))
    );
  }

  return NextResponse.json(enriched);
}
