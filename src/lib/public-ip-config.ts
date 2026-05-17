/**
 * Firestore-backed routing config for the public IPv4 pool: gateway, prefix length, DNS.
 *
 * Pairs with the `public_ips` collection (per-address inventory) so that the entire pool —
 * addresses + their L3 routing — is configurable from Firestore (or the admin UI), with env
 * vars retained as a backwards-compatible fallback for callers that still set them.
 *
 * Doc path: `public_ips_config/default`.
 */

import { getFirestoreDb } from "@/lib/firebase-admin";

const COL = "public_ips_config";
const DEFAULT_DOC_ID = "default";

export interface PublicIpPoolConfig {
  /** IPv4 gateway used for cloud-init `ipconfig0`. Required to actually assign a public IP. */
  gateway?: string;
  /** Prefix length for cloud-init `ipconfig0` (defaults to 32 for /32 routed pools). */
  prefixLen?: number;
  /** Comma-separated resolvers; mapped to Proxmox `nameserver` (space-separated). */
  dns?: string;
  updatedAt?: string;
}

interface RawConfigDoc {
  gateway?: unknown;
  prefixLen?: unknown;
  dns?: unknown;
  updatedAt?: unknown;
}

function asTrimmedString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function asPrefixLen(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isInteger(n) || n < 0 || n > 32) return undefined;
  return n;
}

let cached: { value: PublicIpPoolConfig; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

/** Read the Firestore config doc once, with a tiny in-process cache to avoid hot-path reads. */
async function readFirestoreConfig(): Promise<PublicIpPoolConfig> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  let value: PublicIpPoolConfig = {};
  try {
    const snap = await getFirestoreDb().collection(COL).doc(DEFAULT_DOC_ID).get();
    if (snap.exists) {
      const raw = (snap.data() ?? {}) as RawConfigDoc;
      value = {
        gateway: asTrimmedString(raw.gateway),
        prefixLen: asPrefixLen(raw.prefixLen),
        dns: asTrimmedString(raw.dns),
        updatedAt: asTrimmedString(raw.updatedAt),
      };
    }
  } catch (err) {
    console.warn(
      "[public-ip-config] failed to read Firestore config; falling back to env:",
      err
    );
  }

  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Force the next call to refetch from Firestore (use after admin writes). */
export function invalidatePublicIpPoolConfigCache(): void {
  cached = null;
}

/**
 * Effective config: Firestore values win over env. Env stays as a fallback so existing
 * deployments that set PUBLIC_IP_* in `.env` keep working without any Firestore seeding.
 */
export async function getPublicIpPoolConfig(): Promise<PublicIpPoolConfig> {
  const fromStore = await readFirestoreConfig();
  const envGateway = asTrimmedString(process.env.PUBLIC_IP_GATEWAY);
  const envPrefixLen = asPrefixLen(process.env.PUBLIC_IP_PREFIX_LEN);
  const envDns = asTrimmedString(process.env.PUBLIC_IP_DNS);

  return {
    gateway: fromStore.gateway ?? envGateway,
    prefixLen: fromStore.prefixLen ?? envPrefixLen ?? 32,
    dns: fromStore.dns ?? envDns,
    updatedAt: fromStore.updatedAt,
  };
}

/** Admin write — patches only the provided fields. Pass `null` to clear a field. */
export async function setPublicIpPoolConfig(patch: {
  gateway?: string | null;
  prefixLen?: number | null;
  dns?: string | null;
}): Promise<PublicIpPoolConfig> {
  const ref = getFirestoreDb().collection(COL).doc(DEFAULT_DOC_ID);
  const update: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };

  if (patch.gateway !== undefined) {
    update.gateway = patch.gateway === null ? null : patch.gateway.trim();
  }
  if (patch.prefixLen !== undefined) {
    if (patch.prefixLen === null) {
      update.prefixLen = null;
    } else {
      const n = asPrefixLen(patch.prefixLen);
      if (n == null) {
        throw new Error("prefixLen must be an integer between 0 and 32");
      }
      update.prefixLen = n;
    }
  }
  if (patch.dns !== undefined) {
    update.dns = patch.dns === null ? null : patch.dns.trim();
  }

  await ref.set(update, { merge: true });
  invalidatePublicIpPoolConfigCache();
  return getPublicIpPoolConfig();
}
