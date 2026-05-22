/**
 * Extra data-disk add-on: USD per month for customer-ordered volumes (beyond plan root disk).
 *
 * Default: **$1.00 / month per 50 GB** per volume (rounded; e.g. 100 GB → $2/mo).
 * **1 TB (1024 GB)** and **2 TB (2048 GB)** tiers are flat **$20/mo** and **$40/mo** respectively.
 */

import { labelExtraDiskTierGb } from "@/lib/extra-disks";

const EXTRA_DISK_FLAT_MONTHLY_USD_CENTS_BY_TIER_GB = new Map<number, number>([
  [1024, 2000], // 1 TB
  [2048, 4000], // 2 TB
]);

function formatUsdMenu(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export const EXTRA_DISK_ADDON_USD_CENTS_PER_50_GB = 100;
export const EXTRA_DISK_ADDON_BILLING_GB_STEP = 50;

/** Total provisioned extra disk size in GB (sum of ordered sizes). */
export function extraDisksProvisionedGbTotal(
  extraDisksGb: number[] | null | undefined
): number {
  if (!extraDisksGb?.length) return 0;
  return extraDisksGb.reduce((sum, gb) => sum + Math.max(0, gb), 0);
}

function monthlyUsdCentsForOneExtraDiskGb(gbRaw: number): number {
  const gb = Math.max(0, Math.floor(Number(gbRaw)));
  if (gb <= 0) return 0;
  const flat = EXTRA_DISK_FLAT_MONTHLY_USD_CENTS_BY_TIER_GB.get(gb);
  if (flat != null) return flat;
  return Math.round(
    (gb * EXTRA_DISK_ADDON_USD_CENTS_PER_50_GB) / EXTRA_DISK_ADDON_BILLING_GB_STEP
  );
}

/**
 * Monthly add-on in USD cents for all extra disks on the order (sum of per-volume charges).
 * Zero when no extra disks.
 */
export function extraDisksAddonUsdCents(
  extraDisksGb: number[] | null | undefined
): number {
  if (!extraDisksGb?.length) return 0;
  let total = 0;
  for (const gb of extraDisksGb) {
    total += monthlyUsdCentsForOneExtraDiskGb(gb);
  }
  return total;
}

/** One-line label for tier `<select>` options (size + monthly add-on for that disk alone). */
export function extraDiskTierMenuLabel(sizeGb: number): string {
  const mo = extraDisksAddonUsdCents([sizeGb]);
  return `${labelExtraDiskTierGb(sizeGb)} — ${formatUsdMenu(mo)}/mo`;
}
