/**
 * Shared helpers for VM display names on Proxmox.
 *
 * Proxmox's clone endpoint validates VM `name` against DNS-friendly rules
 * (letters, digits, dots, hyphens; length ≤ 63). We enforce the same shape at
 * order time so the eventual clone doesn't fail deep inside `finalizeProvision`
 * where the user has no easy way to correct it.
 */

const VM_NAME_MAX_LEN = 63;
/** Same character class Proxmox accepts on the clone endpoint. */
const VM_NAME_ALLOWED_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/;

export const VM_DISPLAY_NAME_MAX_LEN = VM_NAME_MAX_LEN;

/**
 * Default VM name we use when the user doesn't pick one — matches
 * `deso-<first 8 of orderId>` (kept for backwards compatibility with existing
 * VMs).
 */
export function defaultVmDisplayName(orderId: string): string {
  const slice = orderId.trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `deso-${slice || "vm"}`;
}

export type VmDisplayNameValidation =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Normalize a caller-supplied VM display name. Returns the trimmed name if it
 * matches Proxmox's naming rules, otherwise a human-readable error message
 * that can go straight into the UI.
 */
export function validateVmDisplayName(
  raw: unknown
): VmDisplayNameValidation {
  if (typeof raw !== "string") {
    return { ok: false, error: "VM name must be text" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "VM name is required" };
  }
  if (trimmed.length > VM_NAME_MAX_LEN) {
    return {
      ok: false,
      error: `VM name must be at most ${VM_NAME_MAX_LEN} characters`,
    };
  }
  if (!VM_NAME_ALLOWED_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        "VM name may only contain letters, digits, dots, or hyphens, and must start and end with a letter or digit.",
    };
  }
  return { ok: true, name: trimmed };
}

/**
 * Resolve the final VM display name for a clone: user-picked (if valid) or
 * the default derived from the orderId.
 */
export function resolveVmDisplayName(
  orderId: string,
  requested?: string | null
): string {
  if (typeof requested === "string") {
    const v = validateVmDisplayName(requested);
    if (v.ok) return v.name;
  }
  return defaultVmDisplayName(orderId);
}
