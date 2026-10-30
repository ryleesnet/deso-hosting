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
  updateOrder,
  updateSubscription,
  type Order,
  type Subscription,
} from "@/lib/db";
import { getVMStatus, shutdownVM, startVM } from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";

/** Days after `nextPaymentAt` before an active VPS is auto-suspended (order status + guest shutdown). */
export function suspendAfterPastDueDays(): number {
  const raw = process.env.BILLING_SUSPEND_AFTER_DAYS_PAST_DUE?.trim();
  const n = raw ? parseInt(raw, 10) : 30;
  return Number.isFinite(n) && n > 0 ? n : 30;
}

let lastDunningRunAt = 0;
let dunningInFlight: Promise<DunningResult> | null = null;

type DunningResult = {
  markedPastDue: number;
  suspendedOrderIds: string[];
  billingDms: Awaited<ReturnType<typeof sendBillingDmNotifications>>;
};

function dunningMinIntervalMs(): number {
  const raw = process.env.BILLING_DUNNING_MIN_INTERVAL_MS?.trim();
  const n = raw ? parseInt(raw, 10) : 300_000; // 5 min default
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

/**
 * Mark overdue subs past_due, suspend VPS past grace, and send billing DMs.
 * Overlapping callers share one in-flight run.
 */
export function runBillingDunning(): Promise<DunningResult> {
  if (dunningInFlight) return dunningInFlight;
  const run = runBillingDunningOnce().then((result) => {
    lastDunningRunAt = Date.now();
    return result;
  });
  dunningInFlight = run;
  void run
    .finally(() => {
      if (dunningInFlight === run) dunningInFlight = null;
    })
    .catch(() => undefined);
  return run;
}

async function runBillingDunningOnce(): Promise<DunningResult> {
  const [orders, subs] = await Promise.all([getOrders(), getSubscriptions()]);
  const markedPastDue = await markPastDueSubscriptions(subs);
  const { suspended } = await autoSuspendDelinquentOrders(orders, subs);
  const billingDms = await sendBillingDmNotifications(orders, subs);
  return { markedPastDue, suspendedOrderIds: suspended, billingDms };
}

/**
 * Schedule dunning without blocking the caller. Page loads use this so a
 * Proxmox/DeSo scan never sits on the dashboard or admin response.
 */
export function runBillingDunningIfDue(): void {
  if (dunningInFlight) return;
  if (Date.now() - lastDunningRunAt < dunningMinIntervalMs()) return;
  lastDunningRunAt = Date.now();
  void runBillingDunning().catch((err) => {
    console.error("[billing-dunning]", err);
  });
}

export { effectiveSubscriptionStatus, isPaymentOverdue };

/** Set subscription to `past_due` when `nextPaymentAt` is in the past and status was `active`. */
export async function markPastDueSubscriptions(
  existing?: Subscription[]
): Promise<number> {
  const subs = existing ?? (await getSubscriptions());
  const now = Date.now();
  const overdue = subs.filter((s) => {
    if (s.status !== "active") return false;
    const due = new Date(s.nextPaymentAt).getTime();
    return !Number.isNaN(due) && due < now;
  });
  await Promise.all(
    overdue.map((s) => updateSubscription(s.id, { status: "past_due" }))
  );
  return overdue.length;
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
    const { node } = await resolveOrderVmLocation(order);
    await shutdownGuestForSuspension(node, order.vmid);
  }
  await updateOrder(orderId, { status: "suspended" });
}

/** Orders that are `active` with a non-cancelled subscription past the grace window. */
export async function autoSuspendDelinquentOrders(
  existingOrders?: Order[],
  existingSubs?: Subscription[]
): Promise<{
  suspended: string[];
}> {
  const days = suspendAfterPastDueDays();
  const thresholdMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const [orders, subs] = await Promise.all([
    existingOrders ?? getOrders(),
    existingSubs ?? getSubscriptions(),
  ]);
  const subByOrderId = new Map(subs.map((s) => [s.orderId, s]));
  const suspended: string[] = [];

  for (const order of orders) {
    if (order.status !== "active") continue;

    const sub = subByOrderId.get(order.id);
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
      const { node } = await resolveOrderVmLocation(order);
      await startVM(node, order.vmid);
    } catch (e) {
      console.error("[resumeOrderAfterPayment] startVM", orderId, e);
    }
  }
}
