import { randomBytes } from "crypto";

/** Strong initial login password for the guest OS (shown once in dashboard). */
export function generateVmPassword(): string {
  return randomBytes(18).toString("hex");
}

/**
 * Map DeSo profile Username to a valid Linux/cloud-init username.
 * Prefixes `u` when the handle does not start with [a-z_] (e.g. leading digit).
 */
export function sanitizeLinuxUsername(
  desoUsername: string | undefined,
  publicKeyBase58: string
): string {
  let raw = (desoUsername ?? "").trim().toLowerCase().replace(/^@/, "");
  raw = raw.replace(/[^a-z0-9_-]/g, "_");
  raw = raw.replace(/_+/g, "_").replace(/^_|_$/g, "");

  if (raw.length === 0) {
    const slug = publicKeyBase58
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase()
      .slice(0, 24);
    const fallback = `deso_${slug}`.slice(0, 32);
    return fallback.length > 0 ? fallback : `u${randomBytes(4).toString("hex")}`;
  }

  let s = /^[a-z_]/.test(raw) ? raw : `u${raw}`;
  if (s.length > 32) s = s.slice(0, 32);
  return /^[a-z_]/.test(s) ? s : `u${randomBytes(4).toString("hex")}`;
}

export function vmCredentialsFromDesoLogin(
  publicKeyBase58: string,
  desoUsername: unknown
): {
  vmLoginUsername: string;
  vmLoginPassword: string;
} {
  const uname =
    typeof desoUsername === "string" && desoUsername.trim()
      ? desoUsername.trim()
      : undefined;
  return {
    vmLoginUsername: sanitizeLinuxUsername(uname, publicKeyBase58),
    vmLoginPassword: generateVmPassword(),
  };
}
