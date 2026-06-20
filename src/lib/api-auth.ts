/**
 * Auth helpers for Next.js API routes.
 *
 * Replaces the old "trust the publicKey field" model with a real DeSo Identity JWT check.
 * Every authenticated route should `const auth = await requireUser(req)` (or `requireAdmin`)
 * at the top, and use `auth.publicKey` from then on. The wire format is:
 *
 *   Authorization: Bearer <jwt-from-identity.jwt()>
 *   X-DeSo-Public-Key: <main user public key>
 *
 * Both are required: the JWT proves the caller controls a derived key, and the public-key
 * header is the claimed main user. {@link verifyDesoJwt} ties them together by confirming
 * on-chain that the derived key is approved for that main key.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyDesoJwt } from "@/lib/deso-jwt";
import { PUBLIC_KEY_HEADER } from "@/lib/api-auth-headers";
import {
  allAdminPublicKeys,
  envAdminPublicKeys,
  publicKeyIsAdminAsync,
} from "@/lib/admin-access";

export { PUBLIC_KEY_HEADER };

export interface AuthSuccess {
  ok: true;
  publicKey: string;
  isAdmin: boolean;
}
export interface AuthFailure {
  ok: false;
  /** Plug into `return auth.response;` */
  response: NextResponse;
}
export type AuthResult = AuthSuccess | AuthFailure;

function extractCredentials(req: NextRequest): {
  jwt: string;
  publicKey: string;
} {
  const authHeader = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  const jwt = m ? m[1]!.trim() : "";
  const publicKey = (req.headers.get(PUBLIC_KEY_HEADER) ?? "").trim();
  return { jwt, publicKey };
}

function unauthorized(message: string, status: 401 | 403 = 401): AuthFailure {
  return {
    ok: false,
    response: NextResponse.json({ error: message }, { status }),
  };
}

/**
 * Verify a logged-in DeSo user. Returns `{ ok: true, publicKey, isAdmin }` on success or
 * a ready-to-return JSON 401/403 on failure.
 *
 * `requireAdmin: true` rejects non-admin users with 403.
 */
export async function requireUser(
  req: NextRequest,
  opts?: { requireAdmin?: boolean }
): Promise<AuthResult> {
  const { jwt, publicKey } = extractCredentials(req);
  if (!jwt || !publicKey) {
    return unauthorized("Authentication required");
  }

  const result = await verifyDesoJwt(jwt, publicKey);
  if (!result.ok) {
    return unauthorized(result.error, result.status);
  }

  const admin = await publicKeyIsAdminAsync(result.mainPublicKey);
  if (opts?.requireAdmin && !admin) {
    return unauthorized("Admin access required", 403);
  }

  return { ok: true, publicKey: result.mainPublicKey, isAdmin: admin };
}

/** Convenience: require an admin caller. */
export async function requireAdmin(req: NextRequest): Promise<AuthResult> {
  return requireUser(req, { requireAdmin: true });
}

/** Pure check (used in routes that already loaded the order). */
export async function publicKeyIsAdmin(publicKey: string): Promise<boolean> {
  return publicKeyIsAdminAsync(publicKey);
}

export async function adminKeyList(): Promise<string[]> {
  return allAdminPublicKeys();
}

/** Env-only admins (for diagnostics / UI labels). */
export function adminKeysFromEnvironment(): string[] {
  return envAdminPublicKeys();
}
