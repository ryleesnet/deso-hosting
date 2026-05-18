/**
 * Per-user isolated private LAN: one VLAN tag per DeSo user (shared across their VMs)
 * and addresses from 10.200.0.0/24 (L2 only between that user's guests on the same trunk).
 */

import { createHash } from "crypto";
import { getFirestoreDb } from "@/lib/firebase-admin";
import { getOrdersByUser } from "@/lib/db";

const COL = "user_private_networks";

export const PRIVATE_LAN_SUBNET_PREFIX = "10.200.0";

/** /24 on 10.200.0.0/24 */
export function privateLanPrefixLen(): number {
  const raw = process.env.PRIVATE_LAN_PREFIX_LEN?.trim();
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 8 && n <= 30) return n;
  }
  return 24;
}

function hashUserDocId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex");
}

function randomVlanTag(): number {
  return 100 + Math.floor(Math.random() * (4094 - 100 + 1));
}

/**
 * Returns an existing VLAN for this user or allocates a new one (not used by any other user).
 */
export async function getOrCreatePrivateVlanForUser(userId: string): Promise<number> {
  if (!userId.trim()) {
    throw new Error("userId required");
  }

  const db = getFirestoreDb();
  const docId = hashUserDocId(userId);
  const ref = db.collection(COL).doc(docId);

  const existing = await ref.get();
  if (existing.exists) {
    const v = existing.data()?.vlanTag;
    if (typeof v === "number" && v >= 1 && v <= 4094) {
      return v;
    }
  }

  for (let attempt = 0; attempt < 80; attempt++) {
    const vlan = randomVlanTag();
    const clash = await db
      .collection(COL)
      .where("vlanTag", "==", vlan)
      .limit(1)
      .get();
    if (!clash.empty) continue;

    try {
      await ref.create({
        userId,
        vlanTag: vlan,
        createdAt: new Date().toISOString(),
      });
      return vlan;
    } catch {
      const again = await ref.get();
      if (again.exists) {
        const v = again.data()?.vlanTag;
        if (typeof v === "number" && v >= 1 && v <= 4094) return v;
      }
    }
  }

  throw new Error(
    "Could not allocate a private VLAN after many attempts. Try again later."
  );
}

function parseLastOctet(ip: string | undefined): number | null {
  if (!ip?.trim()) return null;
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const last = parseInt(parts[3]!, 10);
  if (!Number.isInteger(last) || last < 0 || last > 255) return null;
  return last;
}

/**
 * Pick a free host address in 10.200.0.2–10.200.0.254 for this user.
 * Reuses `existingIpOnOrder` if it is still unique among the user's other VMs.
 */
export async function allocatePrivateLanIpv4ForOrder(
  userId: string,
  orderId: string,
  existingIpOnOrder?: string | null
): Promise<string> {
  const orders = await getOrdersByUser(userId);
  const used = new Set<number>();
  for (const o of orders) {
    if (o.id === orderId) continue;
    const lo = parseLastOctet(o.privateLanIp);
    if (lo != null) used.add(lo);
  }

  if (existingIpOnOrder?.trim()) {
    const keep = parseLastOctet(existingIpOnOrder);
    if (keep != null && keep >= 2 && keep <= 254 && !used.has(keep)) {
      return `${PRIVATE_LAN_SUBNET_PREFIX}.${keep}`;
    }
  }

  for (let h = 2; h <= 254; h++) {
    if (!used.has(h)) {
      return `${PRIVATE_LAN_SUBNET_PREFIX}.${h}`;
    }
  }
  throw new Error(
    "No free IPv4 addresses left in the private LAN pool for your account."
  );
}
