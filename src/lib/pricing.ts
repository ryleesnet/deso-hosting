/** USD ↔ DeSo conversion (isomorphic; rates passed in from server). */

export function usdCentsToDesoAmount(usdCents: number, usdPerDeso: number): number {
  if (!Number.isFinite(usdCents) || !Number.isFinite(usdPerDeso) || usdPerDeso <= 0) {
    return 0;
  }
  const usd = usdCents / 100;
  return usd / usdPerDeso;
}

/** Floor to whole nanos; non-zero USD charges get at least 1 nano. */
export function usdCentsToNanos(usdCents: number, usdPerDeso: number): number {
  const deso = usdCentsToDesoAmount(usdCents, usdPerDeso);
  const n = Math.floor(deso * 1e9);
  if (usdCents <= 0) return 0;
  return Math.max(1, n);
}

export function nanosToUsdCents(nanos: number, usdPerDeso: number): number {
  if (!Number.isFinite(nanos) || !Number.isFinite(usdPerDeso) || usdPerDeso <= 0) {
    return 0;
  }
  return Math.round((nanos / 1e9) * usdPerDeso * 100);
}

export function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

/** Human-readable DESO string for tiny amounts (matches client `formatDesoDisplay`). */
export function formatDesoFromNanos(nanos: number): string {
  const d = nanos / 1e9;
  if (!Number.isFinite(d)) return "0";
  const t = d.toFixed(10).replace(/\.?0+$/, "");
  return t === "" ? "0" : t;
}
