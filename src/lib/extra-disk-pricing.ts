/**
 * Extra data-disk add-on: USD per month for customer-ordered volumes (beyond plan root disk).
 *
 * Rate: **$1.00 / month per 50 GB** of provisioned extra capacity (sum of ordered disk sizes), **prorated**
 * (each GB adds 2¢/month; e.g. 100 GB extra → $2/mo).
 */

export const EXTRA_DISK_ADDON_USD_CENTS_PER_50_GB = 100;
export const EXTRA_DISK_ADDON_BILLING_GB_STEP = 50;

/** Total provisioned extra disk size in GB (sum of ordered sizes). */
export function extraDisksProvisionedGbTotal(
  extraDisksGb: number[] | null | undefined
): number {
  if (!extraDisksGb?.length) return 0;
  return extraDisksGb.reduce((sum, gb) => sum + Math.max(0, gb), 0);
}

/**
 * Monthly add-on in USD cents for all extra disks on the order.
 * Zero when no extra disks or total GB is 0.
 */
export function extraDisksAddonUsdCents(
  extraDisksGb: number[] | null | undefined
): number {
  const gb = extraDisksProvisionedGbTotal(extraDisksGb);
  if (gb <= 0) return 0;
  return Math.round(
    (gb * EXTRA_DISK_ADDON_USD_CENTS_PER_50_GB) / EXTRA_DISK_ADDON_BILLING_GB_STEP
  );
}
