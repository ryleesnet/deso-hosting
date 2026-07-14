"use client";

/**
 * DeSo Identity & Payments
 * Docs: https://docs.deso.org/deso-identity/window-api/basics
 */

import { configure, identity, sendDeso, transferDeSoToken } from "deso-protocol";
import { DUSDC, usdCentsToDusdcHex } from "@/lib/deso-tokens";

// Must match deso-protocol's storage key (see node_modules/deso-protocol/src/identity/constants.js)
const IDENTITY_USERS_KEY = "desoIdentityUsers";
const IDENTITY_ACTIVE_PUBLIC_KEY = "desoActivePublicKey";
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

/** 12× monthly nanos — for quoting / admin use; not used for Identity login cap anymore. */
export function paymentGlobalDesoLimitNanos(amountNanos: number): number {
  const n = Math.max(0, Math.floor(Number(amountNanos) || 0));
  if (n <= 0) return 0;
  return n * 12;
}

/** ~0.01 DESO — Identity `GlobalDESOLimit` at login / first `configure()`. */
const LOGIN_GLOBAL_DESO_LIMIT_NANOS = 10_000_000;

/**
 * GlobalDESOLimit (nanos) passed to Identity `configure()` (drives the initial derived-key
 * approval at login). We keep this minimal so users only grant ~0.01 DESO up front.
 *
 * When someone pays for a VPS or renewal, `sendDeso` runs `guardTxPermission`, which
 * calls `identity.requestPermissions` if the on-chain cap is too low for that transfer.
 *
 * Override (nanos):
 * - NEXT_PUBLIC_IDENTITY_GLOBAL_DESO_LIMIT_NANOS
 * - NEXT_PUBLIC_IDENTITY_LOGIN_SPENDING_CAP_NANOS (legacy alias)
 */
function defaultLoginGlobalDesoLimitNanos(): number {
  const explicit =
    process.env.NEXT_PUBLIC_IDENTITY_GLOBAL_DESO_LIMIT_NANOS ||
    process.env.NEXT_PUBLIC_IDENTITY_LOGIN_SPENDING_CAP_NANOS;
  if (explicit) {
    const n = parseInt(String(explicit).trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return LOGIN_GLOBAL_DESO_LIMIT_NANOS;
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

function normalizeDesoUsername(
  raw: string | undefined | null
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().replace(/^@/, "");
  return t || undefined;
}

/**
 * Username DeSo Identity may merge into `desoIdentityUsers` (not always on the
 * typed login payload). Read after `identity.login()` resolves.
 */
export function getStoredDesoUsername(publicKey: string): string | undefined {
  if (typeof window === "undefined" || !publicKey.trim()) return undefined;
  try {
    const users = localStorage.getItem(IDENTITY_USERS_KEY);
    if (!users) return undefined;
    const parsed = JSON.parse(users) as Record<
      string,
      Record<string, unknown>
    >;
    const row = parsed[publicKey];
    if (!row || typeof row !== "object") return undefined;
    const u = row["username"];
    return normalizeDesoUsername(typeof u === "string" ? u : undefined);
  } catch {
    return undefined;
  }
}

/** Client-side profile lookup (same as AuthContext mount). */
export async function fetchClientDesoUsername(
  publicKey: string
): Promise<string | undefined> {
  if (typeof window === "undefined" || !publicKey.trim()) return undefined;
  try {
    const res = await fetch("/api/profile/username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey }),
    });
    const data = (await res.json()) as { username?: string | null };
    return normalizeDesoUsername(data.username);
  } catch {
    return undefined;
  }
}

export async function loginWithDeSo(): Promise<{
  publicKey: string;
  username?: string;
} | null> {
  initDeSo();
  try {
    const payload = await identity.login();
    if (!payload?.publicKeyAdded) return null;

    const pk = payload.publicKeyAdded;
    // Identity iframe sometimes omits username on the payload; it may still be in storage.
    const users = (payload as { users?: Record<string, { username?: string }> })
      .users;
    const fromPayload = normalizeDesoUsername(
      users?.[pk] ? users[pk]!.username : undefined
    );
    const fromStorage = getStoredDesoUsername(pk);
    const username =
      fromPayload ||
      fromStorage ||
      (await fetchClientDesoUsername(pk));

    return { publicKey: pk, username };
  } catch (err) {
    console.error("DeSo login failed:", err);
    return null;
  }
}

export async function logoutDeSo(): Promise<boolean> {
  initDeSo();
  try {
    await identity.logout();
  } catch (err) {
    if (isIdentityFlowCancelled(err)) return false;
    throw err;
  }
  if (typeof window !== "undefined") {
    localStorage.removeItem(IDENTITY_USERS_KEY);
    localStorage.removeItem(IDENTITY_ACTIVE_PUBLIC_KEY);
    sessionStorage.removeItem(SESSION_DESO_USERNAME_KEY);
    // Drop any cached JWT so the next session can mint its own.
    const { clearJwtCache } = await import("@/lib/api-client");
    clearJwtCache();
  }
  return true;
}

/** User closed or dismissed the Identity popup without completing the flow. */
function isIdentityFlowCancelled(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: string; name?: string; message?: string };
  return (
    e.type === "IDENTITY_WINDOW_CLOSED" ||
    (e.name === "DeSoCoreError" &&
      typeof e.message === "string" &&
      e.message.includes("Identity window was closed"))
  );
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
    const parsed = JSON.parse(users) as Record<string, unknown>;
    const active = localStorage.getItem(IDENTITY_ACTIVE_PUBLIC_KEY)?.trim();
    if (active && parsed[active] != null) {
      return { publicKey: active };
    }
    const keys = Object.keys(parsed);
    if (keys.length === 0) return null;
    return { publicKey: keys[0]! };
  } catch {
    return null;
  }
}

export async function payWithDeSo(
  recipientPublicKey: string,
  amountNanos: number,
  memo?: string
) {
  // `sendDeso` → `guardTxPermission` prompts via Identity when the transfer exceeds
  // the user’s approved GlobalDESOLimit (login only approves ~0.01 DESO).
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

/**
 * Pay with dUSDC (the wrapped-USDC DeSo Token). Since dUSDC is USD-pegged, the
 * caller supplies the price in cents and we send exactly `usdCents / 100` dUSDC.
 *
 * `transferDeSoToken` guards the transaction against the user's current
 * DAOCoinOperationLimitMap and will trigger an Identity permission prompt if
 * the current derived-key spending limit doesn't cover the transfer.
 */
export async function payWithDUSDC(
  recipientPublicKey: string,
  usdCents: number,
  memo?: string
) {
  initDeSo();
  const user = getCurrentUser();
  if (!user) throw new Error("Not logged in");

  const amountHex = usdCentsToDusdcHex(usdCents);
  if (amountHex === "0x0") {
    throw new Error("Payment amount must be greater than zero");
  }

  const result = await transferDeSoToken({
    SenderPublicKeyBase58Check: user.publicKey,
    ProfilePublicKeyBase58CheckOrUsername: DUSDC.creatorPublicKey,
    ReceiverPublicKeyBase58CheckOrUsername: recipientPublicKey,
    DAOCoinToTransferNanos: amountHex,
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
