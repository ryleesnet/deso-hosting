/**
 * Public IPv4 pool for Proxmox cloud-init (ipconfig0).
 *
 * Address inventory lives in Firestore (`public_ips` collection); see `public-ip-store.ts`.
 * Routing config (gateway / prefix / DNS) lives in Firestore (`public_ips_config/default`);
 * see `public-ip-config.ts`. Env vars (PUBLIC_IP_GATEWAY / PUBLIC_IP_PREFIX_LEN / PUBLIC_IP_DNS)
 * remain as a backwards-compatible fallback when the Firestore config doc is absent.
 *
 * Seeding the IP list (from optional CIDR) → `npm run db:seed-public-ips`.
 */

import {
  allocatePublicIpAssignment,
  isFirestorePublicIpPoolSeeded,
} from "@/lib/public-ip-store";
import { getPublicIpPoolConfig } from "@/lib/public-ip-config";

function ipv4ToInt(ip: string): number {
  const parts = ip.trim().split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIpv4(n: number): string {
  const u = n >>> 0;
  return `${(u >>> 24) & 255}.${(u >>> 16) & 255}.${(u >>> 8) & 255}.${u & 255}`;
}

function parseCidr(cidr: string): { base: number; prefix: number } {
  const [addr, bits] = cidr.trim().split("/");
  if (!addr || bits === undefined) throw new Error(`Invalid CIDR: ${cidr}`);
  const prefix = parseInt(bits, 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix in CIDR: ${cidr}`);
  }
  const base = ipv4ToInt(addr);
  return { base, prefix };
}

function networkRange(cidr: string): { firstHost: number; lastHost: number } {
  const { base, prefix } = parseCidr(cidr);
  if (prefix === 32) {
    return { firstHost: base, lastHost: base };
  }
  const mask = (~0 << (32 - prefix)) >>> 0;
  const network = base & mask;
  const broadcast = network | (~mask >>> 0);
  return { firstHost: network + 1, lastHost: broadcast - 1 };
}

function parseExcludeList(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * True when both:
 *   - At least one row exists in Firestore `public_ips`.
 *   - A gateway is resolvable (Firestore `public_ips_config/default` or env `PUBLIC_IP_GATEWAY`).
 *
 * Without a gateway we cannot build a usable cloud-init `ipconfig0`, so we skip allocation.
 * If you have IPs seeded but allocation isn't happening, check that the Firestore config doc
 * has `gateway` set (or that `PUBLIC_IP_GATEWAY` is set in env).
 */
export async function isPublicIpPoolConfigured(): Promise<boolean> {
  const seeded = await isFirestorePublicIpPoolSeeded();
  if (!seeded) return false;
  const cfg = await getPublicIpPoolConfig();
  if (!cfg.gateway) {
    console.warn(
      "[public-ip-pool] Firestore has IP rows but no gateway is configured. " +
        "Set `gateway` in `public_ips_config/default` (Firestore) or PUBLIC_IP_GATEWAY in env."
    );
    return false;
  }
  return true;
}

/**
 * Allocate a free address from Firestore and mark it for this user/order (optional vmid/node).
 */
export async function allocatePublicIpForOrder(params: {
  userId: string;
  orderId: string;
  vmid?: number;
  node?: string;
}): Promise<string> {
  return allocatePublicIpAssignment(params);
}

export async function getPublicIpPrefixLen(): Promise<number> {
  const cfg = await getPublicIpPoolConfig();
  return cfg.prefixLen ?? 32;
}

export async function getPublicIpGateway(): Promise<string | undefined> {
  const cfg = await getPublicIpPoolConfig();
  return cfg.gateway;
}

/**
 * Proxmox `nameserver` field: space-separated is typical for multiple entries.
 * Reads from Firestore config first, falling back to PUBLIC_IP_DNS env.
 */
export async function getPublicIpNameserverParam(): Promise<string | undefined> {
  const cfg = await getPublicIpPoolConfig();
  if (!cfg.dns) return undefined;
  const parts = cfg.dns.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

export interface CloudInitPublicNetwork {
  ip: string;
  prefixLen: number;
  gateway: string;
}

export async function cloudInitNetworkForIp(
  ip: string
): Promise<CloudInitPublicNetwork> {
  const cfg = await getPublicIpPoolConfig();
  if (!cfg.gateway) {
    throw new Error(
      "Public IP gateway is not configured. Set `gateway` in Firestore `public_ips_config/default` or PUBLIC_IP_GATEWAY in env."
    );
  }
  return {
    ip,
    prefixLen: cfg.prefixLen ?? 32,
    gateway: cfg.gateway,
  };
}

/** Used by `db:seed-public-ips` to expand PUBLIC_IP_POOL_CIDR into candidate host IPs. */
export function listPoolCandidateIpsFromEnv(): string[] {
  const cidr = process.env.PUBLIC_IP_POOL_CIDR?.trim();
  const gateway = process.env.PUBLIC_IP_GATEWAY?.trim();
  if (!cidr || !gateway) {
    return [];
  }

  const { firstHost, lastHost } = networkRange(cidr);
  if (firstHost > lastHost) {
    throw new Error(`No assignable hosts in pool CIDR ${cidr}`);
  }

  const gatewayInt = ipv4ToInt(gateway);
  const extraExclude = parseExcludeList(process.env.PUBLIC_IP_EXTRA_EXCLUDE);

  const candidates: string[] = [];
  for (let x = firstHost; x <= lastHost; x++) {
    if (x === gatewayInt) continue;
    const ip = intToIpv4(x);
    if (extraExclude.has(ip)) continue;
    candidates.push(ip);
  }
  return candidates;
}
