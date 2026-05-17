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
