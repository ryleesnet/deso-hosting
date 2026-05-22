/** Server-side limits for additional data disks ordered with a VPS. */

export function provisioningExtraDiskLimits(): {
  maxCount: number;
  maxGbEach: number;
} {
  const maxCount = parseInt(process.env.PROVISION_MAX_EXTRA_DISKS || "8", 10);
  const maxGbEach = parseInt(
    process.env.PROVISION_MAX_EXTRA_DISK_GB_EACH || "2048",
    10
  );
  return {
    maxCount:
      Number.isFinite(maxCount) && maxCount > 0 ? Math.min(maxCount, 26) : 8,
    maxGbEach:
      Number.isFinite(maxGbEach) && maxGbEach > 0 ? Math.min(maxGbEach, 16384) : 2048,
  };
}

/** Fixed catalogue tiers for ordering or adding extra data disks (GB). TB = 1024 GB. */
export const EXTRA_DISK_TIER_SIZES_GB = [100, 200, 500, 1024, 2048] as const;
export type ExtraDiskTierGb = (typeof EXTRA_DISK_TIER_SIZES_GB)[number];

const TIER_GB_SET = new Set<number>(EXTRA_DISK_TIER_SIZES_GB);

export function isAllowedExtraDiskTierGb(gb: number): gb is ExtraDiskTierGb {
  return TIER_GB_SET.has(gb);
}

/** Human-readable label for checkout / dashboard. */
export function labelExtraDiskTierGb(gb: number): string {
  switch (gb) {
    case 1024:
      return "1 TB";
    case 2048:
      return "2 TB";
    default:
      return `${gb} GB`;
  }
}

/** Normalize checkout / dashboard `extraDisksGb` to allowed tiers only; respects max count. */
export function normalizeTieredExtraDisksGb(input: unknown): number[] {
  const { maxCount } = provisioningExtraDiskLimits();
  if (!Array.isArray(input)) return [];

  const out: number[] = [];
  for (const item of input) {
    if (out.length >= maxCount) break;
    const n =
      typeof item === "number" ? item : parseInt(String(item).trim(), 10);
    if (!Number.isFinite(n)) continue;
    const gb = Math.floor(n);
    if (!isAllowedExtraDiskTierGb(gb)) continue;
    out.push(gb);
  }
  return out;
}

/** Normalize client input to a capped list of extra disk sizes (GB). */
export function normalizeExtraDisksGb(input: unknown): number[] {
  const { maxCount, maxGbEach } = provisioningExtraDiskLimits();
  if (!Array.isArray(input)) return [];

  const out: number[] = [];
  for (const item of input) {
    if (out.length >= maxCount) break;
    const n =
      typeof item === "number" ? item : parseInt(String(item).trim(), 10);
    if (!Number.isFinite(n)) continue;
    const gb = Math.floor(n);
    if (gb < 1) continue;
    out.push(Math.min(gb, maxGbEach));
  }
  return out;
}
