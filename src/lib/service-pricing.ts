import type { VPSService } from "@/lib/db";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import { nanosToUsdCents, usdCentsToNanos } from "@/lib/pricing";
import { extraDisksAddonUsdCents } from "@/lib/extra-disk-pricing";

/** API-ready service: canonical USD cents plus DeSo preview at current rate. */
export type PublicVPSService = VPSService & {
  priceUsdCents: number;
  /** DeSo nanos for this month at `desoRateUsdPerDeso` (display / estimate). */
  pricePreviewNanos: number;
  desoRateUsdPerDeso: number;
  desoRateSource: string;
};

export function effectivePriceUsdCents(
  s: VPSService,
  usdPerDeso: number
): number {
  if (s.priceUsdCents != null && Number.isFinite(s.priceUsdCents) && s.priceUsdCents >= 0) {
    return Math.round(s.priceUsdCents);
  }
  return nanosToUsdCents(s.priceNanos ?? 0, usdPerDeso);
}

export function enrichServiceForPublic(
  s: VPSService,
  rate: { usdPerDeso: number; source: string }
): PublicVPSService {
  const priceUsdCents = effectivePriceUsdCents(s, rate.usdPerDeso);
  const pricePreviewNanos = usdCentsToNanos(priceUsdCents, rate.usdPerDeso);
  return {
    ...s,
    priceUsdCents,
    pricePreviewNanos,
    priceNanos: pricePreviewNanos,
    desoRateUsdPerDeso: rate.usdPerDeso,
    desoRateSource: rate.source,
  };
}

export async function enrichServicesForPublic(
  services: VPSService[]
): Promise<PublicVPSService[]> {
  const rate = await getUsdPerDeso();
  return services.map((s) => enrichServiceForPublic(s, rate));
}

export async function publicServiceById(
  service: VPSService | undefined
): Promise<PublicVPSService | undefined> {
  if (!service) return undefined;
  const rate = await getUsdPerDeso();
  return enrichServiceForPublic(service, rate);
}

/** Monthly recurring total in USD cents: service base + extra-disk add-on (see `extra-disk-pricing`). */
export function monthlyTotalUsdCentsForOrder(
  service: VPSService,
  usdPerDeso: number,
  extraDisksGb?: number[] | null
): number {
  return (
    effectivePriceUsdCents(service, usdPerDeso) +
    extraDisksAddonUsdCents(extraDisksGb)
  );
}

/** Subscription / payment line: nanos for one month at current rate (includes extra disks). */
export async function monthlyAmountNanosForOrder(
  service: VPSService,
  extraDisksGb?: number[] | null
): Promise<number> {
  const rate = await getUsdPerDeso();
  const cents = monthlyTotalUsdCentsForOrder(
    service,
    rate.usdPerDeso,
    extraDisksGb
  );
  return usdCentsToNanos(cents, rate.usdPerDeso);
}

/** Subscription / payment line: nanos for one month at current rate (base plan only, no extra disks). */
export async function monthlyAmountNanosForService(
  service: VPSService
): Promise<number> {
  const rate = await getUsdPerDeso();
  const cents = effectivePriceUsdCents(service, rate.usdPerDeso);
  return usdCentsToNanos(cents, rate.usdPerDeso);
}
