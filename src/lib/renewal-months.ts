export const MAX_RENEWAL_MONTHS = 3;

/** Parses `months` from query/body: integer in [1, MAX_RENEWAL_MONTHS], default 1. */
export function parseRenewalMonths(value: unknown): number {
  let n: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    n = Math.floor(value);
  } else if (typeof value === "string" && value.trim()) {
    n = parseInt(value.trim(), 10);
  } else {
    return 1;
  }
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_RENEWAL_MONTHS, n);
}

/** Fragment inside ExtraData.memo after the DeSoHosting prefix (server + client must match). */
export function renewMemoPayload(orderId: string, months: number): string {
  return `renew order=${orderId} months=${months}`;
}

export function renewMemoFull(orderId: string, months: number): string {
  return `DeSoHosting ${renewMemoPayload(orderId, months)}`;
}

/** Max servers renewable together in a single wallet transaction. */
export const MAX_BATCH_RENEWAL_ORDERS = 20;

export interface RenewBatchItem {
  orderId: string;
  months: number;
}

/**
 * Deterministic order used both when building the memo and when applying the
 * batch server-side. Prevents "same set, different order" mismatches when the
 * client and server independently sort.
 */
export function sortRenewBatchItems(
  items: RenewBatchItem[]
): RenewBatchItem[] {
  return [...items].sort((a, b) => a.orderId.localeCompare(b.orderId));
}

/**
 * Per-order marker embedded in the batch memo. The renewal endpoint checks the
 * memo contains this substring for every order in the request, so a payer
 * can't accidentally over-declare which orders a single tx covers.
 */
export function renewBatchOrderMarker(
  orderId: string,
  months: number
): string {
  return `${orderId}:${months}m`;
}

/** Memo written to ExtraData.memo for a multi-server renewal tx (server + client must match). */
export function renewBatchMemoPayload(items: RenewBatchItem[]): string {
  const sorted = sortRenewBatchItems(items);
  const body = sorted.map((i) => renewBatchOrderMarker(i.orderId, i.months)).join(",");
  return `renew batch=${body}`;
}

export function renewBatchMemoFull(items: RenewBatchItem[]): string {
  return `DeSoHosting ${renewBatchMemoPayload(items)}`;
}

/** Extend billing anchor by N months (calendar months, same semantics as single-month renewal). */
export function computeNextPaymentAfterRenewal(
  currentNextPaymentAtIso: string,
  months: number
): string {
  const m = Math.min(MAX_RENEWAL_MONTHS, Math.max(1, Math.floor(months)));
  const prevDue = new Date(currentNextPaymentAtIso).getTime();
  if (Number.isNaN(prevDue)) {
    const next = new Date();
    next.setMonth(next.getMonth() + m);
    return next.toISOString();
  }
  const t = Math.max(prevDue, Date.now());
  const next = new Date(t);
  next.setMonth(next.getMonth() + m);
  return next.toISOString();
}

/** Manual payment: expiration = payment date + N calendar months. */
export function computeExpirationFromPaymentDate(
  paymentDate: Date,
  months: number
): Date {
  const m = Math.min(MAX_RENEWAL_MONTHS, Math.max(1, Math.floor(months)));
  const next = new Date(paymentDate.getTime());
  next.setUTCMonth(next.getUTCMonth() + m);
  return next;
}

/** `YYYY-MM-DD` → noon UTC avoids timezone day shifts; otherwise parse as ISO/datetime. */
export function parsePaymentDate(raw: string): Date | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return new Date(`${t}T12:00:00.000Z`);
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}
