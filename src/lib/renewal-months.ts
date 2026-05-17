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
