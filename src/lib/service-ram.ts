/**
 * Plan memory is stored as MiB in Firestore / Proxmox `memory` (MB-equivalent).
 * Admin UI edits whole GB; values are always normalized to a multiple of 1024.
 */

/** Accept MB from API/clients; snap to whole GB (minimum 1 GB = 1024 MB). */
export function normalizeRamMb(mb: number): number {
  const n = Number(mb);
  if (!Number.isFinite(n) || n < 1024) {
    return 1024;
  }
  return Math.max(1024, Math.round(n / 1024) * 1024);
}

export function memoryGbToRamMb(gb: number): number {
  const g = Math.max(1, Math.round(Number(gb) || 0));
  return g * 1024;
}

/** Whole GB for admin form initial state (from stored MB). */
export function ramMbToMemoryGb(ramMb: number): number {
  return Math.max(1, Math.round(Number(ramMb) / 1024));
}
