/** Full UTC calendar days remaining until renewal (rounded up); 0 when due or overdue. */
export function daysRemainingInBillingCycle(
  nextPaymentIso: string,
  nowMs: number = Date.now()
): number {
  const end = new Date(nextPaymentIso).getTime();
  if (Number.isNaN(end)) return 0;
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(0, Math.ceil((end - nowMs) / msPerDay));
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** True when `nextPaymentAt` is before now (subscription not current). */
export function isPaymentOverdue(
  nextPaymentIso: string,
  nowMs: number = Date.now()
): boolean {
  const end = new Date(nextPaymentIso).getTime();
  return !Number.isNaN(end) && end < nowMs;
}

/** Whole days since renewal date passed (0 when not overdue). */
export function daysPastDue(
  nextPaymentIso: string,
  nowMs: number = Date.now()
): number {
  if (!isPaymentOverdue(nextPaymentIso, nowMs)) return 0;
  const end = new Date(nextPaymentIso).getTime();
  return Math.max(1, Math.ceil((nowMs - end) / MS_PER_DAY));
}

/** Days until auto-suspend after `nextPaymentAt + graceDays` (0 when grace elapsed). */
export function daysUntilGraceEnds(
  nextPaymentIso: string,
  graceDays: number,
  nowMs: number = Date.now()
): number {
  const end = new Date(nextPaymentIso).getTime();
  if (Number.isNaN(end)) return 0;
  const suspendAt = end + graceDays * MS_PER_DAY;
  return Math.max(0, Math.ceil((suspendAt - nowMs) / MS_PER_DAY));
}

export function effectiveSubscriptionStatus(
  storedStatus: "active" | "past_due" | "cancelled",
  nextPaymentIso: string,
  nowMs: number = Date.now()
): "active" | "past_due" | "cancelled" {
  if (storedStatus === "cancelled") return "cancelled";
  if (isPaymentOverdue(nextPaymentIso, nowMs)) return "past_due";
  return "active";
}

/** UTC calendar date `YYYY-MM-DD` for an ISO timestamp. */
export function utcDateKeyFromIso(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function todayUtcDateKey(nowMs: number = Date.now()): string {
  return utcDateKeyFromIso(new Date(nowMs).toISOString());
}

/** Shift a UTC date key by calendar days. */
export function addUtcDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map((x) => parseInt(x, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return "";
  }
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return utcDateKeyFromIso(dt.toISOString());
}

export function formatBillingDateUs(dateKey: string): string {
  const [y, m, d] = dateKey.split("-");
  if (!y || !m || !d) return dateKey;
  return `${m}/${d}/${y}`;
}
