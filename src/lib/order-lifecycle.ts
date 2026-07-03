/**
 * Subscription dunning: mark past-due, auto-suspend orders, resume after payment.
 */

import {
  effectiveSubscriptionStatus,
  isPaymentOverdue,
} from "@/lib/billing";
import { sendBillingDmNotifications } from "@/lib/billing-notifications";
import {
  getOrder,
  getOrders,
  getSubscriptions,
  getSubscriptionByOrder,
  updateOrder,
  updateSubscription,
} from "@/lib/db";
import { getVMStatus, shutdownVM, startVM } from "@/lib/proxmox";

/** Days after `nextPaymentAt` before an active VPS is auto-suspended (order status + guest shutdown). */
export function suspendAfterPastDueDays(): number {
  const raw = process.env.BILLING_SUSPEND_AFTER_DAYS_PAST_DUE?.trim();
  const n = raw ? parseInt(raw, 10) : 30;
  return Number.isFinite(n) && n > 0 ? n : 30;
}

let lastDunningRunAt = 0;

function dunningMinIntervalMs(): number {
  const raw = process.env.BILLING_DUNNING_MIN_INTERVAL_MS?.trim();
  const n = raw ? parseInt(raw, 10) : 300_000; // 5 min default
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

/** Mark overdue subs past_due, suspend VPS past grace, and send billing DMs. */
export async function runBillingDunning(): Promise<{
  markedPastDue: number;
  suspendedOrderIds: string[];
  billingDms: Awaited<ReturnType<typeof sendBillingDmNotifications>>;
}> {
  const markedPastDue = await markPastDueSubscriptions();
  const { suspended } = await autoSuspendDelinquentOrders();
  const billingDms = await sendBillingDmNotifications();
  lastDunningRunAt = Date.now();
  return { markedPastDue, suspendedOrderIds: suspended, billingDms };
}

/** Throttled dunning for request paths (dashboard load, etc.). */
export async function runBillingDunningIfDue(): Promise<void> {
  const now = Date.now();
  if (now - lastDunningRunAt < dunningMinIntervalMs()) return;
  await runBillingDunning();
}

export { effectiveSubscriptionStatus, isPaymentOverdue };

/** Set subscription to `past_due` when `nextPaymentAt` is in the past and status was `active`. */
export async function markPastDueSubscriptions(): Promise<number> {
  const subs = await getSubscriptions();
  let count = 0;
  const now = Date.now();
  for (const s of subs) {
    if (s.status !== "active") continue;
    const due = new Date(s.nextPaymentAt).getTime();
    if (Number.isNaN(due) || due >= now) continue;
    await updateSubscription(s.id, { status: "past_due" });
    count += 1;
  }
  return count;
}

/** ACPI shutdown when running/paused; no-op when already stopped. */
export async function shutdownGuestForSuspension(
  node: string,
  vmid: number
): Promise<void> {
  const st = await getVMStatus(node, vmid);
  if (st.status === "running" || st.status === "paused") {
    await shutdownVM(node, vmid);
  }
}

/**
 * Active order → `suspended` + graceful guest shutdown (if provisioned).
 * Idempotent when already suspended. No-op when order is not `active`.
 */
export async function suspendOrderById(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error("Order not found");
  }
  if (order.status === "suspended") {
    return;
  }
  if (order.status !== "active") {
    throw new Error("Only active orders can be suspended");
  }
  if (order.node?.trim() && order.vmid && order.vmid > 0) {
    await shutdownGuestForSuspension(order.node, order.vmid);
  }
  await updateOrder(orderId, { status: "suspended" });
}

/** Orders that are `active` with a non-cancelled subscription past the grace window. */
export async function autoSuspendDelinquentOrders(): Promise<{
  suspended: string[];
}> {
  const days = suspendAfterPastDueDays();
  const thresholdMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const orders = await getOrders();
  const suspended: string[] = [];

  for (const order of orders) {
    if (order.status !== "active") continue;

    const sub = await getSubscriptionByOrder(order.id);
    if (!sub || sub.status === "cancelled") continue;
    if (sub.status !== "active" && sub.status !== "past_due") continue;

    const due = new Date(sub.nextPaymentAt).getTime();
    if (Number.isNaN(due)) continue;
    if (now < due + thresholdMs) continue;

    try {
      await suspendOrderById(order.id);
      suspended.push(order.id);
    } catch (e) {
      console.error(`[auto-suspend] ${order.id}`, e);
    }
  }

  return { suspended };
}

/**
 * After successful payment, lift `suspended` and boot the guest (best effort).
 */
export async function resumeOrderAfterPayment(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order || order.status !== "suspended") return;

  await updateOrder(orderId, { status: "active" });

  if (order.node?.trim() && order.vmid && order.vmid > 0) {
    try {
      await startVM(order.node, order.vmid);
    } catch (e) {
      console.error("[resumeOrderAfterPayment] startVM", orderId, e);
    }
  }
}
