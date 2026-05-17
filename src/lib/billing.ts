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
