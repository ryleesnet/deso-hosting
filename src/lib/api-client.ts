"use client";

/**
 * Browser fetch wrapper that authenticates every API call with:
 *   - Authorization: Bearer <JWT minted by identity.jwt()>
 *   - X-DeSo-Public-Key: <main user public key>
 *
 * Routes that need the verified caller use {@link requireUser} / {@link requireAdmin} on
 * the server and read `auth.publicKey` from there. Plain `fetch()` to API routes is now
 * unauthenticated by design — use these helpers from anything inside the dashboard / admin
 * area that hits an authenticated endpoint.
 */

import { identity } from "deso-protocol";
import { getCurrentUser } from "@/lib/deso";
import { PUBLIC_KEY_HEADER } from "@/lib/api-auth-headers";

let cachedJwt: { token: string; mintedAt: number } | null = null;
/** JWT lifetime in deso-protocol is 30 minutes; refresh well before to avoid races. */
const JWT_REUSE_MS = 25 * 60 * 1000;

async function getFreshJwt(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedJwt && now - cachedJwt.mintedAt < JWT_REUSE_MS) {
    return cachedJwt.token;
  }
  const token = await identity.jwt();
  if (!token || typeof token !== "string") {
    throw new Error(
      "Could not mint a DeSo JWT. Reconnect your DeSo Identity to continue."
    );
  }
  cachedJwt = { token, mintedAt: now };
  return token;
}

/** Force the next call to mint a new JWT (e.g. on logout / login). */
export function clearJwtCache(): void {
  cachedJwt = null;
}

export interface ApiFetchOptions extends RequestInit {
  /** Skip the JWT and identity headers (e.g. for public catalog calls). */
  skipAuth?: boolean;
  /** Override the public key (rare; defaults to currently logged-in user). */
  asPublicKey?: string;
}

async function injectAuthHeaders(
  headers: Headers,
  asPublicKey?: string,
  forceRefresh = false
): Promise<void> {
  const user = getCurrentUser();
  const pk = asPublicKey?.trim() || user?.publicKey;
  if (!pk) {
    throw new Error("Not logged in");
  }
  if (!headers.has(PUBLIC_KEY_HEADER)) {
    headers.set(PUBLIC_KEY_HEADER, pk);
  }
  if (!headers.has("Authorization")) {
    const jwt = await getFreshJwt(forceRefresh);
    headers.set("Authorization", `Bearer ${jwt}`);
  }
}

/**
 * Authenticated fetch. On 401, retries once with a freshly minted JWT to handle expiry.
 *
 * Throws if the user is not logged in (no public key + JWT to attach). If you intend to
 * call a public endpoint, pass `{ skipAuth: true }`.
 */
export async function apiFetch(
  input: string,
  init: ApiFetchOptions = {}
): Promise<Response> {
  const { skipAuth, asPublicKey, ...rest } = init;
  const headers = new Headers(rest.headers);

  if (!skipAuth) {
    await injectAuthHeaders(headers, asPublicKey, false);
  }

  const res = await fetch(input, { ...rest, headers });
  if (skipAuth || res.status !== 401) return res;

  // JWT may have expired — refresh and retry once.
  const retryHeaders = new Headers(rest.headers);
  retryHeaders.delete("Authorization");
  await injectAuthHeaders(retryHeaders, asPublicKey, true);
  return fetch(input, { ...rest, headers: retryHeaders });
}

export async function apiJson<T = unknown>(
  input: string,
  init: ApiFetchOptions = {}
): Promise<T> {
  const res = await apiFetch(input, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "error" in (data as Record<string, unknown>)
        ? String((data as { error?: unknown }).error)
        : null) ?? `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export async function apiPostJson<T = unknown>(
  input: string,
  body: unknown,
  init: Omit<ApiFetchOptions, "method" | "body"> = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return apiJson<T>(input, {
    ...init,
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
}
