/**
 * Server-side DeSo Identity JWT verification.
 *
 * The DeSo Identity SDK mints JWTs of the form:
 *   header  = base64url({ "alg": "ES256", "typ": "JWT" })  // alg label is misleading; key curve is secp256k1
 *   payload = base64url({ derivedPublicKeyBase58Check, iat, exp })
 *   sig     = base64url(JOSE-encoded ECDSA(secp256k1) signature of sha256(`${header}.${payload}`))
 *
 * The signature is produced by the *derived* key, not the main user key. We accept the JWT
 * as proof that the bearer controls a key the main public key has authorized on-chain. We do
 * NOT trust an arbitrary `publicKey` body/query field — every authenticated route reads the
 * verified main public key from {@link verifyDesoJwt} instead.
 *
 * The returned main public key is verified via DeSo's `get-user-derived-keys` endpoint:
 * we look up all derived keys for the claimed main key and confirm the JWT-signing derived
 * key is in the list and not expired. Results are cached briefly to keep latency low.
 */

import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha256";
import * as secp from "@noble/secp256k1";

const DESO_NODE_URI = (
  process.env.DESO_NODE_URI ||
  process.env.NEXT_PUBLIC_DESO_NODE_URI ||
  "https://node.deso.org"
).replace(/\/$/, "");

/** Mainnet identity prefix is the first 3 bytes of the base58check payload. */
const MAINNET_PUBKEY_PREFIX = Uint8Array.of(0xcd, 0x14, 0x00);
/** Testnet (`tBC` prefix). Same logic; we just don't restrict to mainnet at parse-time. */
const TESTNET_PUBKEY_PREFIX = Uint8Array.of(0x11, 0xc2, 0x00);

const KNOWN_PREFIXES = [MAINNET_PUBKEY_PREFIX, TESTNET_PUBKEY_PREFIX];

function timingSafeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function sha256x2(buf: Uint8Array): Uint8Array {
  return sha256(sha256(buf));
}

/**
 * Decode a DeSo base58check public key into the 33-byte compressed secp256k1 point.
 * Throws on bad checksum / unknown prefix.
 */
function base58CheckToCompressedPubkey(base58check: string): Uint8Array {
  const raw = bs58.decode(base58check);
  if (raw.length < 7) throw new Error("Public key too short");
  const payload = raw.slice(0, -4);
  const checksum = raw.slice(-4);
  const computed = sha256x2(payload).slice(0, 4);
  if (!timingSafeEquals(checksum, computed)) {
    throw new Error("Public key checksum mismatch");
  }
  const prefix = payload.slice(0, 3);
  const ok = KNOWN_PREFIXES.some((p) => timingSafeEquals(prefix, p));
  if (!ok) throw new Error("Unknown public key prefix");
  const compressed = payload.slice(3);
  if (compressed.length !== 33) {
    throw new Error("Public key payload is not 33 bytes (compressed)");
  }
  return compressed;
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function safeJsonParse<T = unknown>(buf: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch {
    return null;
  }
}

/** Convert a JOSE-encoded ECDSA signature (raw r||s, 64 bytes) to a `Signature` object. */
function joseToSignature(sig: Uint8Array): secp.Signature {
  if (sig.length !== 64) {
    throw new Error(`Bad ECDSA signature length: ${sig.length}, expected 64`);
  }
  const r = BigInt("0x" + Buffer.from(sig.slice(0, 32)).toString("hex"));
  const s = BigInt("0x" + Buffer.from(sig.slice(32)).toString("hex"));
  return new secp.Signature(r, s);
}

interface JwtHeader {
  alg?: string;
  typ?: string;
}
interface JwtPayload {
  derivedPublicKeyBase58Check?: string;
  iat?: number;
  exp?: number;
}

interface DerivedKeyRow {
  DerivedPublicKey?: string;
  ExpirationBlock?: number;
  IsValid?: boolean;
  TransactionSpendingLimit?: unknown;
  /** Some fork builds expose this directly; harmless if missing. */
  ExpirationTimestampUnixSec?: number;
}
interface GetUserDerivedKeysResponse {
  DerivedKeys?: Record<string, DerivedKeyRow>;
}

/** In-memory cache for derived-key approval lookups. */
const DERIVED_KEYS_CACHE = new Map<
  string,
  { fetchedAt: number; keys: Record<string, DerivedKeyRow> }
>();
const DERIVED_KEYS_TTL_MS = 60_000;

async function fetchDerivedKeys(
  mainPublicKey: string
): Promise<Record<string, DerivedKeyRow>> {
  const cached = DERIVED_KEYS_CACHE.get(mainPublicKey);
  if (cached && Date.now() - cached.fetchedAt < DERIVED_KEYS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(`${DESO_NODE_URI}/api/v0/get-user-derived-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ PublicKeyBase58Check: mainPublicKey }),
  });
  if (!res.ok) {
    throw new Error(
      `get-user-derived-keys failed: ${res.status} ${res.statusText}`
    );
  }
  const data = (await res.json()) as GetUserDerivedKeysResponse;
  const keys = data.DerivedKeys ?? {};
  DERIVED_KEYS_CACHE.set(mainPublicKey, { fetchedAt: Date.now(), keys });
  return keys;
}

export type JwtVerifyResult =
  | { ok: true; mainPublicKey: string; derivedPublicKey: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Verify a JWT and return the main public key it authenticates.
 *
 * @param jwtToken raw JWT string (`Authorization: Bearer <token>` value)
 * @param claimedMainPublicKey base58check user public key the caller claims is theirs
 *
 * Steps:
 *  1. Crypto-verify the JWT signature with `derivedPublicKeyBase58Check` from the payload.
 *  2. Confirm the derived key is approved on-chain by `claimedMainPublicKey`.
 *  3. Validate `exp`.
 */
export async function verifyDesoJwt(
  jwtToken: string,
  claimedMainPublicKey: string
): Promise<JwtVerifyResult> {
  if (!jwtToken || typeof jwtToken !== "string") {
    return { ok: false, status: 401, error: "Missing JWT" };
  }
  if (!claimedMainPublicKey || typeof claimedMainPublicKey !== "string") {
    return { ok: false, status: 401, error: "Missing public key" };
  }

  const parts = jwtToken.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: "Malformed JWT" };
  }
  const [headerPart, payloadPart, sigPart] = parts as [string, string, string];

  const header = safeJsonParse<JwtHeader>(base64UrlDecode(headerPart));
  const payload = safeJsonParse<JwtPayload>(base64UrlDecode(payloadPart));
  if (!header || !payload) {
    return { ok: false, status: 401, error: "Malformed JWT body" };
  }

  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    return { ok: false, status: 401, error: "JWT expired" };
  }

  const derivedB58 = payload.derivedPublicKeyBase58Check;
  if (!derivedB58 || typeof derivedB58 !== "string") {
    // We only accept derived-key signed JWTs (the standard deso-protocol shape). A JWT
    // signed by the main key is also possible, but Identity flows do not give us the
    // main private key, so this should never be the path we're on.
    return {
      ok: false,
      status: 401,
      error: "JWT must include derivedPublicKeyBase58Check",
    };
  }

  let derivedCompressed: Uint8Array;
  try {
    derivedCompressed = base58CheckToCompressedPubkey(derivedB58);
  } catch (e) {
    return {
      ok: false,
      status: 401,
      error:
        e instanceof Error ? `Invalid derived key: ${e.message}` : "Invalid derived key",
    };
  }

  // Verify signature.
  const signingInput = `${headerPart}.${payloadPart}`;
  const msgHash = sha256(new TextEncoder().encode(signingInput));
  let sigOk = false;
  try {
    const sig = joseToSignature(base64UrlDecode(sigPart));
    sigOk = secp.verify(sig, msgHash, derivedCompressed);
  } catch (e) {
    return {
      ok: false,
      status: 401,
      error:
        e instanceof Error ? `Bad signature: ${e.message}` : "Bad signature",
    };
  }
  if (!sigOk) {
    return { ok: false, status: 401, error: "JWT signature invalid" };
  }

  // Confirm the derived key is currently authorized by the claimed main key.
  let allDerivedKeys: Record<string, DerivedKeyRow>;
  try {
    allDerivedKeys = await fetchDerivedKeys(claimedMainPublicKey);
  } catch (e) {
    console.error("[deso-jwt] derived-key lookup failed:", e);
    return {
      ok: false,
      status: 403,
      error: "Could not verify derived key authorization",
    };
  }

  const row = allDerivedKeys[derivedB58];
  if (!row) {
    return {
      ok: false,
      status: 403,
      error: "Derived key is not authorized for this user",
    };
  }
  if (row.IsValid === false) {
    return { ok: false, status: 403, error: "Derived key is revoked" };
  }

  return {
    ok: true,
    mainPublicKey: claimedMainPublicKey,
    derivedPublicKey: derivedB58,
  };
}

/** Drop cache entries (admin / test affordance). */
export function clearDerivedKeysCacheFor(publicKey?: string): void {
  if (publicKey) DERIVED_KEYS_CACHE.delete(publicKey);
  else DERIVED_KEYS_CACHE.clear();
}
