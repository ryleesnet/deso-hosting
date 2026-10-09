/**
 * Admin checklist of payments to enter in Akaunting.
 *
 * Rows are derived from orders (the initial charge), renewal transactions, and
 * manually recorded payments. A separate mark document hides a row from the
 * open queue without deleting the payment.
 */

import { getFirestoreDb } from "@/lib/firebase-admin";
import { fetchDesoUsernamesByPublicKeys } from "@/lib/deso-profile";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import { extraDisksAddonUsdCents } from "@/lib/extra-disk-pricing";
import { logApp } from "@/lib/app-log";
import { monthlyTotalUsdCentsForOrder } from "@/lib/service-pricing";
import {
  getOrders,
  getServices,
  listRenewalTxs,
  type Order,
  type RenewalTxRecord,
  type VPSService,
} from "@/lib/db";

const COL_MARKS = "accounting_marks";
const COL_MANUAL = "accounting_manual_payments";

export type AccountingKind = "order" | "renewal" | "manual";

export interface AccountingEntry {
  id: string;
  kind: AccountingKind;
  paidAt: string;
  orderId: string;
  userId: string;
  username?: string;
  vmid?: number;
  node?: string;
  publicIpv4?: string;
  vmDisplayName?: string;
  serviceName?: string;
  orderStatus?: Order["status"];
  rail: string;
  months: number;
  /** Receipt amount in USD cents when we can estimate or recorded it. */
  usdCents?: number;
  /** On-chain tx hash or PayPal sale id, when this row is a renewal. */
  reference?: string;
  enteredAt?: string;
}

export interface AccountingQueueResult {
  entries: AccountingEntry[];
  openCount: number;
}

interface ManualPaymentDoc {
  orderId: string;
  userId: string;
  paidAt: string;
  nextPaymentAt: string;
  months: number;
  usdCents?: number;
  recordedBy: string;
  createdAt: string;
}

interface MarkDoc {
  enteredAt?: string;
  enteredBy?: string;
}

function manualEntryId(
  orderId: string,
  paidAtMs: number,
  nextPaymentAtMs: number
): string {
  return `manual:${orderId}:${paidAtMs}:${nextPaymentAtMs}`;
}

function renewalEntryId(txHash: string, orderId: string): string {
  return `renewal:${txHash}:${orderId}`;
}

function orderEntryId(orderId: string): string {
  return `order:${orderId}`;
}

function railLabel(order: Order): string {
  return order.paymentProvider === "paypal" ? "PayPal" : "DeSo";
}

function renewalRail(tx: RenewalTxRecord): string {
  if (tx.paymentToken === "PAYPAL" || tx.txHashHex.startsWith("paypal_")) {
    return "PayPal";
  }
  if (tx.paymentToken === "DUSDC") return "dUSDC";
  return "DeSo";
}

function orderIdsForRenewal(tx: RenewalTxRecord): string[] {
  if (tx.orderIds && tx.orderIds.length > 0) return tx.orderIds;
  if (tx.orderId) return [tx.orderId];
  return [];
}

function monthlyCentsForOrder(
  order: Order,
  service: VPSService | undefined,
  usdPerDeso: number
): number | undefined {
  if (
    order.paymentProvider === "paypal" &&
    typeof order.paypalMonthlyUsdCents === "number" &&
    order.paypalMonthlyUsdCents >= 0
  ) {
    return Math.round(order.paypalMonthlyUsdCents);
  }
  if (!service || !(usdPerDeso > 0)) {
    if (!service) return undefined;
    const addon = extraDisksAddonUsdCents(order.extraDisksGb);
    if (service.priceUsdCents != null && service.priceUsdCents >= 0) {
      return Math.round(service.priceUsdCents) + addon;
    }
    return undefined;
  }
  return monthlyTotalUsdCentsForOrder(service, usdPerDeso, order.extraDisksGb);
}

function orderFields(
  order: Order | undefined,
  services: Map<string, VPSService>
): Pick<
  AccountingEntry,
  | "userId"
  | "vmid"
  | "node"
  | "publicIpv4"
  | "vmDisplayName"
  | "serviceName"
  | "orderStatus"
> {
  if (!order) {
    return { userId: "" };
  }
  const service = services.get(order.serviceId);
  return {
    userId: order.userId,
    vmid: order.vmid > 0 ? order.vmid : undefined,
    node: order.node && order.node !== "pending" ? order.node : undefined,
    publicIpv4: order.publicIpv4,
    vmDisplayName: order.vmDisplayName,
    serviceName: service?.name,
    orderStatus: order.status,
  };
}

async function readMarks(): Promise<Map<string, string>> {
  const snap = await getFirestoreDb().collection(COL_MARKS).get();
  const marks = new Map<string, string>();
  for (const doc of snap.docs) {
    const enteredAt = (doc.data() as MarkDoc).enteredAt;
    if (typeof enteredAt === "string" && enteredAt) marks.set(doc.id, enteredAt);
  }
  return marks;
}

async function readManualPayments(): Promise<
  Array<ManualPaymentDoc & { id: string }>
> {
  const snap = await getFirestoreDb().collection(COL_MANUAL).get();
  return snap.docs.map((doc) => {
    const data = doc.data() as ManualPaymentDoc;
    return { ...data, id: doc.id };
  });
}

export async function listAccountingEntries(): Promise<AccountingEntry[]> {
  const [orders, services, renewals, manuals, marks, rate] = await Promise.all([
    getOrders(),
    getServices(),
    listRenewalTxs(),
    readManualPayments(),
    readMarks(),
    getUsdPerDeso().catch(() => null),
  ]);

  const usdPerDeso = rate?.usdPerDeso ?? 0;
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const entries: AccountingEntry[] = [];

  for (const order of orders) {
    const service = serviceById.get(order.serviceId);
    const monthly = monthlyCentsForOrder(order, service, usdPerDeso);
    const id = orderEntryId(order.id);
    entries.push({
      id,
      kind: "order",
      paidAt: order.createdAt,
      orderId: order.id,
      ...orderFields(order, serviceById),
      rail: railLabel(order),
      months: 1,
      usdCents: monthly,
      enteredAt: marks.get(id),
    });
  }

  for (const tx of renewals) {
    const ids = orderIdsForRenewal(tx);
    const months = tx.months && tx.months > 0 ? tx.months : 1;
    const single = ids.length === 1;
    for (const orderId of ids) {
      const order = orderById.get(orderId);
      const service = order ? serviceById.get(order.serviceId) : undefined;
      const monthly = order
        ? monthlyCentsForOrder(order, service, usdPerDeso)
        : undefined;
      const recorded =
        single && typeof tx.usdCents === "number" && tx.usdCents >= 0
          ? Math.round(tx.usdCents)
          : monthly != null
            ? monthly * months
            : undefined;
      const id = renewalEntryId(tx.txHashHex, orderId);
      entries.push({
        id,
        kind: "renewal",
        paidAt: tx.processedAt,
        orderId,
        ...orderFields(order, serviceById),
        userId: order?.userId ?? "",
        rail: renewalRail(tx),
        months,
        usdCents: recorded,
        reference: tx.txHashHex,
        enteredAt: marks.get(id),
      });
    }
  }

  for (const manual of manuals) {
    const order = orderById.get(manual.orderId);
    const fields = orderFields(order, serviceById);
    entries.push({
      id: manual.id,
      kind: "manual",
      paidAt: manual.paidAt,
      orderId: manual.orderId,
      ...fields,
      userId: order?.userId || manual.userId,
      rail: "Manual",
      months: manual.months > 0 ? manual.months : 1,
      usdCents:
        typeof manual.usdCents === "number" && manual.usdCents >= 0
          ? Math.round(manual.usdCents)
          : undefined,
      enteredAt: marks.get(manual.id),
    });
  }

  const usernames = await fetchDesoUsernamesByPublicKeys(
    entries.map((e) => e.userId)
  );
  for (const entry of entries) {
    const name = usernames.get(entry.userId);
    if (name) entry.username = name;
  }

  entries.sort((a, b) => (a.paidAt < b.paidAt ? 1 : a.paidAt > b.paidAt ? -1 : 0));
  return entries;
}

export function filterAccountingEntries(
  entries: AccountingEntry[],
  query: string
): AccountingQueueResult {
  const openCount = entries.reduce((n, e) => n + (e.enteredAt ? 0 : 1), 0);
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) {
    return {
      openCount,
      entries: entries.filter((e) => !e.enteredAt),
    };
  }
  const matched = entries.filter((e) => {
    const hay = [
      e.username,
      e.userId,
      e.orderId,
      e.vmid != null ? String(e.vmid) : "",
      e.publicIpv4,
      e.node,
      e.vmDisplayName,
      e.serviceName,
      e.reference,
      e.rail,
      e.kind,
      e.orderStatus,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
  return { openCount, entries: matched };
}

export async function setAccountingEntryEntered(params: {
  id: string;
  entered: boolean;
  actorId: string;
}): Promise<AccountingEntry> {
  const id = params.id.trim();
  const entries = await listAccountingEntries();
  const found = entries.find((e) => e.id === id);
  if (!found) {
    throw new Error("Payment not found");
  }

  const ref = getFirestoreDb().collection(COL_MARKS).doc(id);
  if (!params.entered) {
    await ref.delete();
    logApp("info", `Akaunting mark cleared for ${found.kind} ${found.orderId}`, {
      category: "admin",
      context: { actorId: params.actorId, orderId: found.orderId, userId: found.userId },
    });
    return { ...found, enteredAt: undefined };
  }

  const enteredAt = new Date().toISOString();
  await ref.set({
    enteredAt,
    enteredBy: params.actorId,
    orderId: found.orderId,
    kind: found.kind,
  });
  logApp("info", `Marked ${found.kind} ${found.orderId} entered in Akaunting`, {
    category: "admin",
    context: { actorId: params.actorId, orderId: found.orderId, userId: found.userId },
  });
  return { ...found, enteredAt };
}

/**
 * Remember an admin-recorded off-chain payment so it shows up in the Akaunting
 * queue even after the original order row was already marked entered.
 */
export async function recordManualAccountingPayment(params: {
  orderId: string;
  userId: string;
  paidAt: string;
  nextPaymentAt: string;
  months: number;
  usdCents?: number;
  recordedBy: string;
}): Promise<void> {
  const paidMs = Date.parse(params.paidAt);
  const nextMs = Date.parse(params.nextPaymentAt);
  if (!Number.isFinite(paidMs) || !Number.isFinite(nextMs)) return;
  const id = manualEntryId(params.orderId, paidMs, nextMs);
  const doc: ManualPaymentDoc = {
    orderId: params.orderId,
    userId: params.userId,
    paidAt: new Date(paidMs).toISOString(),
    nextPaymentAt: new Date(nextMs).toISOString(),
    months: Math.max(1, Math.floor(params.months) || 1),
    recordedBy: params.recordedBy,
    createdAt: new Date().toISOString(),
  };
  if (typeof params.usdCents === "number" && Number.isFinite(params.usdCents)) {
    doc.usdCents = Math.max(0, Math.round(params.usdCents));
  }
  await getFirestoreDb()
    .collection(COL_MANUAL)
    .doc(id)
    .set(doc, { merge: true });
}
