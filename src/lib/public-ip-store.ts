/**
 * Firestore-backed public IPv4 inventory: each address is a document so you can
 * see assignment (user / order / VM) in the Firebase console or future admin UI.
 */

import { FieldValue } from "firebase-admin/firestore";
import { randomInt } from "crypto";
import { getFirestoreDb } from "@/lib/firebase-admin";

const COL_PUBLIC_IPS = "public_ips";

export type PublicIpStatus = "available" | "assigned" | "reserved";

export interface PublicIpRecord {
  address: string;
  status: PublicIpStatus;
  /** DeSo public key */
  userId?: string;
  orderId?: string;
  vmid?: number;
  /** Proxmox node name */
  node?: string;
  notes?: string;
  assignedAt?: string;
  createdAt: string;
  updatedAt: string;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}

export async function isFirestorePublicIpPoolSeeded(): Promise<boolean> {
  const agg = await getFirestoreDb().collection(COL_PUBLIC_IPS).count().get();
  return agg.data().count > 0;
}

/**
 * Atomically pick a free address and mark it assigned.
 */
export async function allocatePublicIpAssignment(params: {
  userId: string;
  orderId: string;
  vmid?: number;
  node?: string;
}): Promise<string> {
  const db = getFirestoreDb();
  const now = new Date().toISOString();

  return db.runTransaction(async (tx) => {
    const q = db
      .collection(COL_PUBLIC_IPS)
      .where("status", "==", "available")
      .limit(48);
    const snap = await tx.get(q);
    if (snap.empty) {
      throw new Error(
        "Public IPv4 pool exhausted (no addresses with status=available in Firestore). Add or seed addresses."
      );
    }
    const docs = [...snap.docs];
    shuffleInPlace(docs);
    const chosen = docs[0]!;
    const data = chosen.data() as PublicIpRecord;
    const addr = data.address?.trim() || chosen.id;
    const patch: Record<string, unknown> = {
      status: "assigned",
      userId: params.userId,
      orderId: params.orderId,
      assignedAt: now,
      updatedAt: now,
    };
    if (params.vmid != null && params.vmid > 0) {
      patch.vmid = params.vmid;
    }
    if (params.node?.trim()) {
      patch.node = params.node.trim();
    }
    tx.update(chosen.ref, patch);
    return addr;
  });
}

/**
 * Clear assignment for any row tied to this order (returns addresses to the pool).
 */
export async function releasePublicIpAssignmentByOrderId(
  orderId: string
): Promise<void> {
  const db = getFirestoreDb();
  const snap = await db
    .collection(COL_PUBLIC_IPS)
    .where("orderId", "==", orderId)
    .get();
  if (snap.empty) return;

  const now = new Date().toISOString();
  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      status: "available",
      userId: FieldValue.delete(),
      orderId: FieldValue.delete(),
      vmid: FieldValue.delete(),
      node: FieldValue.delete(),
      assignedAt: FieldValue.delete(),
      updatedAt: now,
    });
  }
  await batch.commit();
}

/**
 * After provisioning, attach Proxmox vmid/node to the IP row for this order.
 */
export async function updatePublicIpMachineForOrder(
  orderId: string,
  vmid: number,
  node: string
): Promise<void> {
  const db = getFirestoreDb();
  const snap = await db
    .collection(COL_PUBLIC_IPS)
    .where("orderId", "==", orderId)
    .get();
  if (snap.empty) return;

  const now = new Date().toISOString();
  const batch = db.batch();
  for (const doc of snap.docs) {
    batch.update(doc.ref, {
      vmid,
      node: node.trim(),
      updatedAt: now,
    });
  }
  await batch.commit();
}

export async function listPublicIpRecords(): Promise<PublicIpRecord[]> {
  const snap = await getFirestoreDb().collection(COL_PUBLIC_IPS).get();
  return snap.docs.map((d) => {
    const x = d.data() as Partial<PublicIpRecord>;
    return { ...x, address: x.address ?? d.id } as PublicIpRecord;
  });
}

const VALID_STATUSES: PublicIpStatus[] = ["available", "assigned", "reserved"];

/**
 * Admin: patch assignment fields on a pool row (document id = IPv4 string).
 */
export async function adminPatchPublicIpRecord(params: {
  address: string;
  status: PublicIpStatus;
  userId?: string;
  orderId?: string;
  vmid?: number | null;
}): Promise<void> {
  const addr = params.address.trim();
  if (!addr) throw new Error("address required");

  if (!VALID_STATUSES.includes(params.status)) {
    throw new Error(`status must be one of: ${VALID_STATUSES.join(", ")}`);
  }

  const db = getFirestoreDb();
  const ref = db.collection(COL_PUBLIC_IPS).doc(addr);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`No public_ips document for ${addr}`);
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: params.status,
    address: addr,
    updatedAt: now,
  };

  const uid = params.userId?.trim();
  if (uid) patch.userId = uid;
  else patch.userId = FieldValue.delete();

  const oid = params.orderId?.trim();
  if (oid) patch.orderId = oid;
  else patch.orderId = FieldValue.delete();

  const vm = params.vmid;
  if (vm != null && Number.isFinite(vm) && Number(vm) > 0) {
    patch.vmid = Number(vm);
  } else {
    patch.vmid = FieldValue.delete();
  }

  await ref.update(patch);
}

export const PUBLIC_IPS_COLLECTION = COL_PUBLIC_IPS;
