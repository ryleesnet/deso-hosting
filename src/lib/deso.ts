"use client";

/**
 * DeSo Identity & Payments
 * Docs: https://docs.deso.org/deso-identity/window-api/basics
 */

import { configure, identity, sendDeso } from "deso-protocol";

// Must match deso-protocol's storage key (see node_modules/deso-protocol/src/identity/constants.js)
const IDENTITY_USERS_KEY = "desoIdentityUsers";
const SESSION_DESO_USERNAME_KEY = "desoHostingSessionDesoUsername";

/** Persist DeSo username in sessionStorage for VPS ordering cloud-init Linux name across refreshes. */
export function rememberSessionDesoUsername(username: string | undefined): void {
  if (typeof window === "undefined") return;
  if (username?.trim()) sessionStorage.setItem(SESSION_DESO_USERNAME_KEY, username.trim());
  else sessionStorage.removeItem(SESSION_DESO_USERNAME_KEY);
}

export function getRememberedSessionDesoUsername(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const v = sessionStorage.getItem(SESSION_DESO_USERNAME_KEY);
  return v?.trim() ? v.trim() : undefined;
}

/** 12× monthly nanos — total GlobalDESOLimit runway for recurring subscription payments. */
export function paymentGlobalDesoLimitNanos(amountNanos: number): number {
  const n = Math.max(0, Math.floor(Number(amountNanos) || 0));
  if (n <= 0) return 0;
  return n * 12;
}

/**
 * GlobalDESOLimit (nanos) requested at Identity login. If this is too low, every
 * `sendDeso` looks like a new authorization. Identity prompts again only when the
 * on-chain derived key needs more headroom (`requestPermissions`).
 *
 * - NEXT_PUBLIC_IDENTITY_GLOBAL_DESO_LIMIT_NANOS — exact total-cap override
 * - NEXT_PUBLIC_IDENTITY_LOGIN_SPENDING_CAP_NANOS — legacy alias
 * - NEXT_PUBLIC_MAX_MONTHLY_PAYMENT_NANOS — uses 12× this (match your priciest plan)
 * - Else — 12× 0.1 DESO/month (~1.2 DESO total)
 */
function defaultLoginGlobalDesoLimitNanos(): number {
  const explicit =
    process.env.NEXT_PUBLIC_IDENTITY_GLOBAL_DESO_LIMIT_NANOS ||
    process.env.NEXT_PUBLIC_IDENTITY_LOGIN_SPENDING_CAP_NANOS;
  if (explicit) {
    const n = parseInt(String(explicit).trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const monthlyMax = process.env.NEXT_PUBLIC_MAX_MONTHLY_PAYMENT_NANOS;
  if (monthlyMax) {
    const m = parseInt(String(monthlyMax).trim(), 10);
    if (Number.isFinite(m) && m > 0) return paymentGlobalDesoLimitNanos(m);
  }

  return paymentGlobalDesoLimitNanos(100_000_000);
}

type InitOptions = {
  /** Identity GlobalDESOLimit (nanos). Defaults to login runway from env / defaultLoginGlobalDesoLimitNanos. */
  globalDesoLimitNanos?: number;
};

export function initDeSo(opts?: InitOptions) {
  const limitNanos = opts?.globalDesoLimitNanos ?? defaultLoginGlobalDesoLimitNanos();
  configure({
    spendingLimitOptions: {
      GlobalDESOLimit: limitNanos,
      TransactionCountLimitMap: {
        BASIC_TRANSFER: 1000,
      },
    },
    appName: "DeSoHosting",
    nodeURI: process.env.NEXT_PUBLIC_DESO_NODE_URI || "https://node.deso.org",
  });
}

export async function loginWithDeSo(): Promise<{
  publicKey: string;
  username?: string;
} | null> {
  initDeSo();
  try {
    const payload = await identity.login();
    if (payload?.publicKeyAdded) {
      const users = (payload as { users?: Record<string, { username?: string }> }).users;
      return {
        publicKey: payload.publicKeyAdded,
        username: users?.[payload.publicKeyAdded]?.username,
      };
    }
    return null;
  } catch (err) {
    console.error("DeSo login failed:", err);
    return null;
  }
}

export async function logoutDeSo() {
  initDeSo();
  await identity.logout();
  if (typeof window !== "undefined") {
    localStorage.removeItem(IDENTITY_USERS_KEY);
    sessionStorage.removeItem(SESSION_DESO_USERNAME_KEY);
    // Drop any cached JWT so the next session can mint its own.
    const { clearJwtCache } = await import("@/lib/api-client");
    clearJwtCache();
  }
}

/**
 * Image URL for a user's DeSo profile picture via the configured node.
 * Uses the node's `fallback` redirect when no on-chain picture is set.
 */
export function desoProfilePictureUrl(
  publicKeyBase58Check: string,
  options?: { fallbackDisplayName?: string }
): string {
  const node = (
    process.env.NEXT_PUBLIC_DESO_NODE_URI || "https://node.deso.org"
  ).replace(/\/$/, "");
  const name =
    options?.fallbackDisplayName?.trim() ||
    publicKeyBase58Check.slice(0, 8);
  const fallback = encodeURIComponent(
    `https://ui-avatars.com/api/?size=128&background=1f2937&color=34d399&bold=true&name=${encodeURIComponent(name)}`
  );
  return `${node}/api/v0/get-single-profile-picture/${encodeURIComponent(
    publicKeyBase58Check
  )}?fallback=${fallback}`;
}

export function getCurrentUser(): { publicKey: string } | null {
  if (typeof window === "undefined") return null;
  const users = localStorage.getItem(IDENTITY_USERS_KEY);
  if (!users) return null;
  try {
    const parsed = JSON.parse(users);
    const keys = Object.keys(parsed);
    if (keys.length === 0) return null;
    return { publicKey: keys[0] };
  } catch {
    return null;
  }
}

export async function payWithDeSo(
  recipientPublicKey: string,
  amountNanos: number,
  memo?: string
) {
  // Keep configure() aligned with login. Re-configuring a higher limit here does not
  // increase the user's approved derived key and caused unnecessary permission popups.
  initDeSo();
  const user = getCurrentUser();
  if (!user) throw new Error("Not logged in");

  const result = await sendDeso({
    SenderPublicKeyBase58Check: user.publicKey,
    RecipientPublicKeyOrUsername: recipientPublicKey,
    AmountNanos: amountNanos,
    MinFeeRateNanosPerKB: 1000,
    ...(memo && { ExtraData: { memo: memo } }),
  });

  return result;
}

export function nanosToDeso(nanos: number): number {
  return nanos / 1e9;
}

/** Human-readable DESO string for tiny prices (e.g. 0.0001 instead of "0.00"). */
export function formatDesoDisplay(nanos: number): string {
  const d = nanosToDeso(nanos);
  if (!Number.isFinite(d)) return "0";
  const t = d.toFixed(10).replace(/\.?0+$/, "");
  return t === "" ? "0" : t;
}

export function desoToNanos(deso: number): number {
  return Math.floor(deso * 1e9);
}
