/**
 * DeSo DM reminders for renewal due dates and suspension milestones.
 */

import {
  addUtcDateKey,
  formatBillingDateUs,
  isPaymentOverdue,
  todayUtcDateKey,
  utcDateKeyFromIso,
} from "@/lib/billing";
import {
  getBillingDmNotification,
  getOrder,
  getOrders,
  getSubscriptionByOrder,
  getSubscriptions,
  recordBillingDmNotification,
  type BillingDmNotificationKind,
  type Order,
  type Subscription,
} from "@/lib/db";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";
import { isBillingDmConfigured, sendDesoDirectMessage, getBillingDmConfigError } from "@/lib/deso-dm";
import { getVMStatus } from "@/lib/proxmox";

const NOTIFY_OFFSETS = [-5, 0, 5] as const;

function billingGraceDays(): number {
  const raw = process.env.BILLING_SUSPEND_AFTER_DAYS_PAST_DUE?.trim();
  const n = raw ? parseInt(raw, 10) : 30;
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function dashboardUrl(): string {
  const base =
    process.env.APP_PUBLIC_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "";
  return base ? `${base.replace(/\/$/, "")}/dashboard` : "/dashboard";
}

async function vmDisplayLabel(order: Order): Promise<string> {
  if (order.vmid > 0 && order.node?.trim()) {
    try {
      const status = await getVMStatus(order.node.trim(), order.vmid);
      const name = status.name?.trim();
      if (name) return name;
    } catch (err) {
      console.warn(
        `[billing-dm] Could not load VM name for order ${order.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const login = order.vmLoginUsername?.trim();
  if (login) return login;

  return "your VPS";
}

async function greeting(userId: string): Promise<string> {
  const username = await fetchDesoUsernameByPublicKey(userId);
  if (username) return `@${username.replace(/^@/, "")}`;
  return "there";
}

function buildMessage(
  kind: BillingDmNotificationKind,
  ctx: {
    greet: string;
    vm: string;
    dueDate: string;
    suspendDate: string;
    dashboard: string;
  }
): string {
  const due = formatBillingDateUs(ctx.dueDate);
  const suspend = formatBillingDateUs(ctx.suspendDate);

  switch (kind) {
    case "renewal_minus_5":
      return `Hi ${ctx.greet}, your DeSo Hosting ${ctx.vm} renewal is due on ${due} (5 days). Renew at ${ctx.dashboard} to stay current.`;
    case "renewal_due":
      return `Hi ${ctx.greet}, your DeSo Hosting ${ctx.vm} renewal is due today (${due}). Please renew at ${ctx.dashboard} if you have not paid yet.`;
    case "renewal_plus_5":
      return `Hi ${ctx.greet}, your DeSo Hosting ${ctx.vm} payment is 5 days overdue (due ${due}). Renew at ${ctx.dashboard} to avoid suspension on ${suspend}.`;
    case "suspend_minus_5":
      return `Hi ${ctx.greet}, your DeSo Hosting ${ctx.vm} will be suspended on ${suspend} (5 days) unless payment is received. Renew at ${ctx.dashboard}.`;
    case "suspend_due":
      return `Hi ${ctx.greet}, your DeSo Hosting ${ctx.vm} is being suspended today (${suspend}) for non-payment. Renew at ${ctx.dashboard} to restore service.`;
    case "suspend_plus_5":
      return `Hi ${ctx.greet}, your DeSo Hosting ${ctx.vm} was suspended 5 days ago for non-payment. Renew at ${ctx.dashboard} to restore access.`;
    default:
      return `Hi ${ctx.greet}, please renew your DeSo Hosting ${ctx.vm} at ${ctx.dashboard}.`;
  }
}

function shouldSendRenewalNotice(
  kind: BillingDmNotificationKind,
  sub: Subscription,
  order: Order,
  todayKey: string,
  dueDateKey: string,
  milestoneKey: string
): boolean {
  if (sub.status === "cancelled" || order.status === "cancelled") return false;
  if (todayKey !== milestoneKey) return false;

  const lastPaidKey = utcDateKeyFromIso(sub.lastPaymentAt);

  switch (kind) {
    case "renewal_minus_5":
      return !isPaymentOverdue(sub.nextPaymentAt);
    case "renewal_due":
      return lastPaidKey < dueDateKey || isPaymentOverdue(sub.nextPaymentAt);
    case "renewal_plus_5":
      return isPaymentOverdue(sub.nextPaymentAt);
    default:
      return false;
  }
}

function shouldSendSuspendNotice(
  kind: BillingDmNotificationKind,
  sub: Subscription,
  order: Order,
  todayKey: string,
  suspendDateKey: string,
  milestoneKey: string
): boolean {
  if (sub.status === "cancelled" || order.status === "cancelled") return false;
  if (todayKey !== milestoneKey) return false;
  if (!isPaymentOverdue(sub.nextPaymentAt)) return false;

  switch (kind) {
    case "suspend_minus_5":
    case "suspend_due":
      return order.status === "active";
    case "suspend_plus_5":
      return order.status === "suspended";
    default:
      return false;
  }
}

async function trySendNotice(params: {
  order: Order;
  sub: Subscription;
  kind: BillingDmNotificationKind;
  billingAnchorDate: string;
  message: string;
  skipDuplicateCheck?: boolean;
}): Promise<"sent" | "skipped" | "failed"> {
  if (!params.skipDuplicateCheck) {
    const existing = await getBillingDmNotification(
      params.order.id,
      params.kind,
      params.billingAnchorDate
    );
    if (existing) return "skipped";
  }

  const result = await sendDesoDirectMessage(params.order.userId, params.message);
  if (!result.ok) {
    console.error(
      `[billing-dm] ${params.order.id} ${params.kind}:`,
      result.error
    );
    return "failed";
  }

  await recordBillingDmNotification({
    orderId: params.order.id,
    subscriptionId: params.sub.id,
    userId: params.order.userId,
    kind: params.kind,
    billingAnchorDate: params.billingAnchorDate,
    sentAt: new Date().toISOString(),
  });
  return "sent";
}

/** Evaluate all billing DM milestones and send any that are due (idempotent per cycle). */
export async function sendBillingDmNotifications(): Promise<{
  sent: number;
  skipped: number;
  failed: number;
  disabled: boolean;
}> {
  if (!isBillingDmConfigured()) {
    return { sent: 0, skipped: 0, failed: 0, disabled: true };
  }

  const todayKey = todayUtcDateKey();
  const graceDays = billingGraceDays();
  const orders = await getOrders();
  const subs = await getSubscriptions();
  const subByOrder = new Map(subs.map((s) => [s.orderId, s]));

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const order of orders) {
    const sub = subByOrder.get(order.id);
    if (!sub || sub.status === "cancelled") continue;
    if (!order.userId?.trim()) continue;

    const dueDateKey = utcDateKeyFromIso(sub.nextPaymentAt);
    if (!dueDateKey) continue;

    const billingAnchorDate = dueDateKey;
    const suspendDateKey = addUtcDateKey(dueDateKey, graceDays);
    const greet = await greeting(order.userId);
    const vm = await vmDisplayLabel(order);
    const dashboard = dashboardUrl();

    const renewalKinds: BillingDmNotificationKind[] = [
      "renewal_minus_5",
      "renewal_due",
      "renewal_plus_5",
    ];
    const suspendKinds: BillingDmNotificationKind[] = [
      "suspend_minus_5",
      "suspend_due",
      "suspend_plus_5",
    ];

    for (let i = 0; i < NOTIFY_OFFSETS.length; i += 1) {
      const offset = NOTIFY_OFFSETS[i]!;
      const renewalKind = renewalKinds[i]!;
      const renewalMilestone = addUtcDateKey(dueDateKey, offset);
      if (
        shouldSendRenewalNotice(
          renewalKind,
          sub,
          order,
          todayKey,
          dueDateKey,
          renewalMilestone
        )
      ) {
        const message = buildMessage(renewalKind, {
          greet,
          vm,
          dueDate: dueDateKey,
          suspendDate: suspendDateKey,
          dashboard,
        });
        const outcome = await trySendNotice({
          order,
          sub,
          kind: renewalKind,
          billingAnchorDate,
          message,
        });
        if (outcome === "sent") sent += 1;
        else if (outcome === "failed") failed += 1;
        else skipped += 1;
      }

      const suspendKind = suspendKinds[i]!;
      const suspendMilestone = addUtcDateKey(suspendDateKey, offset);
      if (
        shouldSendSuspendNotice(
          suspendKind,
          sub,
          order,
          todayKey,
          suspendDateKey,
          suspendMilestone
        )
      ) {
        const message = buildMessage(suspendKind, {
          greet,
          vm,
          dueDate: dueDateKey,
          suspendDate: suspendDateKey,
          dashboard,
        });
        const outcome = await trySendNotice({
          order,
          sub,
          kind: suspendKind,
          billingAnchorDate,
          message,
        });
        if (outcome === "sent") sent += 1;
        else if (outcome === "failed") failed += 1;
        else skipped += 1;
      }
    }
  }

  return { sent, skipped, failed, disabled: false };
}

export type ManualPastDueNotifyResult =
  | { ok: true; sent: true }
  | { ok: false; error: string; disabled?: boolean };

/** Admin-triggered DM for an overdue subscription (no milestone date gate). */
export async function sendManualPastDueBillingDm(
  orderId: string
): Promise<ManualPastDueNotifyResult> {
  if (!isBillingDmConfigured()) {
    return {
      ok: false,
      error:
        getBillingDmConfigError() ??
        "DeSo billing DM sender is not configured on the server.",
      disabled: true,
    };
  }

  const order = await getOrder(orderId);
  if (!order) {
    return { ok: false, error: "Order not found." };
  }

  const sub = await getSubscriptionByOrder(orderId);
  if (!sub || sub.status === "cancelled") {
    return { ok: false, error: "No active subscription for this order." };
  }
  if (!isPaymentOverdue(sub.nextPaymentAt)) {
    return { ok: false, error: "This subscription is not past due." };
  }

  const dueDateKey = utcDateKeyFromIso(sub.nextPaymentAt);
  const suspendDateKey = addUtcDateKey(dueDateKey, billingGraceDays());
  const billingAnchorDate = dueDateKey;
  const greet = await greeting(order.userId);
  const vm = await vmDisplayLabel(order);
  const dashboard = dashboardUrl();

  const suspended = order.status === "suspended";
  const due = formatBillingDateUs(dueDateKey);
  const suspend = formatBillingDateUs(suspendDateKey);
  const message = suspended
    ? `Hi ${greet}, your DeSo Hosting ${vm} payment was due ${due} and the VM is suspended. Renew at ${dashboard} to restore service.`
    : `Hi ${greet}, your DeSo Hosting ${vm} payment is overdue (due ${due}). Renew at ${dashboard}. Unpaid service suspends on ${suspend}.`;

  const outcome = await trySendNotice({
    order,
    sub,
    kind: "manual_past_due",
    billingAnchorDate,
    message,
    skipDuplicateCheck: true,
  });

  if (outcome === "sent") {
    return { ok: true, sent: true };
  }
  return {
    ok: false,
    error: "Failed to send DeSo DM. Check server logs and sender wallet balance.",
  };
}
