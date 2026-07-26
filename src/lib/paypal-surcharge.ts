/**
 * PayPal surcharge helpers.
 *
 * PayPal's US business rate is ~3.49% + $0.49 per transaction. We add that on
 * top of the catalog USD price for every PayPal charge (initial + auto-renew)
 * so the merchant nets ≈ the advertised amount. Set both env vars to `0` to
 * absorb the fee instead of surcharging.
 *
 * Isomorphic: no server-only imports so components can call these too.
 */

const DEFAULT_PERCENT = 3.49;
const DEFAULT_FIXED_CENTS = 49;

function readPercent(): number {
  const raw = process.env.PAYPAL_SURCHARGE_PERCENT?.trim();
  if (!raw) return DEFAULT_PERCENT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PERCENT;
}

function readFixedCents(): number {
  const raw = process.env.PAYPAL_SURCHARGE_FIXED_CENTS?.trim();
  if (!raw) return DEFAULT_FIXED_CENTS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FIXED_CENTS;
}

export interface PaypalSurchargeConfig {
  /** Percentage, e.g. `3.49` for 3.49%. */
  percent: number;
  /** Fixed component in USD cents, e.g. `49` for $0.49. */
  fixedCents: number;
}

export function paypalSurchargeConfig(): PaypalSurchargeConfig {
  return { percent: readPercent(), fixedCents: readFixedCents() };
}

/**
 * Given the catalog / plan USD cents, return the PayPal surcharge in USD cents
 * (rounded to the nearest cent).
 *
 * `surcharge = round(baseCents × percent/100 + fixedCents)`
 */
export function paypalSurchargeCents(
  baseCents: number,
  cfg?: PaypalSurchargeConfig
): number {
  const c = cfg ?? paypalSurchargeConfig();
  const base = Math.max(0, Math.floor(Number(baseCents) || 0));
  if (base === 0 && c.fixedCents === 0) return 0;
  const pctPart = base * (c.percent / 100);
  return Math.max(0, Math.round(pctPart + c.fixedCents));
}

/** Convenience: total cents charged for the given base including surcharge. */
export function totalCentsWithPaypalSurcharge(
  baseCents: number,
  cfg?: PaypalSurchargeConfig
): number {
  const base = Math.max(0, Math.floor(Number(baseCents) || 0));
  return base + paypalSurchargeCents(base, cfg);
}
