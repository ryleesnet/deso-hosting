/**
 * Firestore persistence via Firebase Admin SDK (server-side only).
 * Configure credentials in `.env` (see `.env.example`).
 */

import { getFirestoreDb } from "@/lib/firebase-admin";

const COL_SERVICES = "services";
const COL_ORDERS = "orders";
const COL_SUBSCRIPTIONS = "subscriptions";
const COL_RENEWAL_TXS = "renewal_txs";

export interface VPSService {
  id: string;
  name: string;
  description: string;
  vcpu: number;
  ram: number; // MB (MiB for Proxmox); admin uses GB → always multiple of 1024
  storage: number; // GB
  /** Monthly price in USD cents (e.g. 999 = $9.99). Primary catalogue price. */
  priceUsdCents?: number;
  /** @deprecated Legacy: DeSo nanos/mo when priceUsdCents was not used. */
  priceNanos?: number;
  proxmoxTemplate?: number; // VM template ID to clone
  proxmoxNode?: string;
  active: boolean;
  createdAt: string;
}

export interface Order {
  id: string;
  userId: string; // DeSo public key
  serviceId: string;
  vmid: number;
  node: string;
  status: "pending" | "provisioning" | "active" | "suspended" | "cancelled";
  createdAt: string;
  /** Set when status becomes `cancelled`; used for retention before Firestore order doc is purged. */
  cancelledAt?: string;
  expiresAt?: string;
  /** Guest login name from DeSo username — applied via Proxmox cloud-init (ciuser). */
  vmLoginUsername?: string;
  /** Plaintext initial password; restrict Firestore access in production. */
  vmLoginPassword?: string;
  /** Additional data disks beyond the plan root disk, sizes in GB (Proxmox). */
  extraDisksGb?: number[];
  /** Static public IPv4 from the pool (Proxmox cloud-init ipconfig0). */
  publicIpv4?: string;
  /**
   * OpenSSH public key lines for cloud-init `sshkeys` on Proxmox (newline-separated).
   * Private keys are never stored; use paste-at-order or one-time download for generated pairs.
   */
  cloudInitSshKeys?: string;
  /**
   * Last failure surfaced from the auto-provision/configure flow (clone, hardware, cloud-init).
   * Cleared on a successful retry. Populated when the VM was cloned but post-clone configuration
   * failed, so the dashboard can show the user *why* the order is stuck and offer a retry.
   */
  provisionError?: string;
  /** Optional second NIC on an isolated per-user VLAN for private VM-to-VM traffic (10.200.0.0/24). */
  privateLanEnabled?: boolean;
  /** Proxmox bridge tag; same value for all of this user's VMs that use private LAN. */
  privateLanVlan?: number;
  /** Assigned host address, e.g. 10.200.0.7 */
  privateLanIp?: string;
}

export interface Subscription {
  id: string;
  orderId: string;
  userId: string;
  lastPaymentAt: string;
  nextPaymentAt: string;
  amountNanos: number;
  status: "active" | "past_due" | "cancelled";
}

function db() {
  return getFirestoreDb();
}

/** Removes undefined (Firestore rejects undefined field values). */
function forFirestore(obj: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

// Services (short TTL cache: catalog is small and changes rarely; cuts repeated reads from dashboard polling, etc.)

let servicesCache: { at: number; data: VPSService[] } | null = null;
const SERVICES_CACHE_MS = 60_000;

function invalidateServicesCache() {
  servicesCache = null;
}

export async function getServices(): Promise<VPSService[]> {
  const now = Date.now();
  if (servicesCache && now - servicesCache.at < SERVICES_CACHE_MS) {
    return servicesCache.data;
  }
  const snap = await db().collection(COL_SERVICES).get();
  const list = snap.docs.map(
    (d) => ({ id: d.id, ...d.data() }) as VPSService
  );
  const sorted = list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  servicesCache = { at: now, data: sorted };
  return sorted;
}

export async function getService(id: string): Promise<VPSService | undefined> {
  const doc = await db().collection(COL_SERVICES).doc(id).get();
  if (!doc.exists) return undefined;
  return { id: doc.id, ...doc.data() } as VPSService;
}

export async function addService(
  service: Omit<VPSService, "id" | "createdAt">
): Promise<VPSService> {
  const newService: VPSService = {
    ...service,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await db()
    .collection(COL_SERVICES)
    .doc(newService.id)
    .set(forFirestore(newService));
  invalidateServicesCache();
  return newService;
}

export async function updateService(
  id: string,
  updates: Partial<Omit<VPSService, "id" | "createdAt">>
): Promise<VPSService | undefined> {
  const ref = db().collection(COL_SERVICES).doc(id);
  const cur = await ref.get();
  if (!cur.exists) return undefined;
  const merged = { ...cur.data(), ...updates };
  await ref.set(forFirestore(merged), { merge: true });
  const after = await ref.get();
  invalidateServicesCache();
  return { id: after.id, ...after.data() } as VPSService;
}

export async function deleteService(id: string): Promise<void> {
  await db().collection(COL_SERVICES).doc(id).delete();
  invalidateServicesCache();
}

// Orders

export async function getOrders(): Promise<Order[]> {
  const snap = await db().collection(COL_ORDERS).get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Order);
  return list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function getOrdersByUser(userId: string): Promise<Order[]> {
  const snap = await db()
    .collection(COL_ORDERS)
    .where("userId", "==", userId)
    .get();
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Order);
  return list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function getOrder(id: string): Promise<Order | undefined> {
  const doc = await db().collection(COL_ORDERS).doc(id).get();
  if (!doc.exists) return undefined;
  return { id: doc.id, ...doc.data() } as Order;
}

export async function addOrder(
  order: Omit<Order, "id" | "createdAt">
): Promise<Order> {
  const newOrder: Order = {
    ...order,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await db()
    .collection(COL_ORDERS)
    .doc(newOrder.id)
    .set(forFirestore(newOrder));
  return newOrder;
}

export async function updateOrder(
  id: string,
  updates: Partial<Omit<Order, "id" | "createdAt">>
): Promise<Order | undefined> {
  const ref = db().collection(COL_ORDERS).doc(id);
  const cur = await ref.get();
  if (!cur.exists) return undefined;
  await ref.set(
    forFirestore({ ...cur.data(), ...updates }),
    { merge: true }
  );
  const after = await ref.get();
  return { id: after.id, ...after.data() } as Order;
}

// Subscriptions

export async function getSubscriptions(): Promise<Subscription[]> {
  const snap = await db().collection(COL_SUBSCRIPTIONS).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Subscription);
}

/** All subscriptions for a user (dashboard / billing); avoids reading every subscription in the project. */
export async function getSubscriptionsByUser(
  userId: string
): Promise<Subscription[]> {
  const snap = await db()
    .collection(COL_SUBSCRIPTIONS)
    .where("userId", "==", userId)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Subscription);
}

export async function getSubscriptionByOrder(
  orderId: string
): Promise<Subscription | undefined> {
  const snap = await db()
    .collection(COL_SUBSCRIPTIONS)
    .where("orderId", "==", orderId)
    .limit(1)
    .get();
  if (snap.empty) return undefined;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as Subscription;
}

export async function addSubscription(
  sub: Omit<Subscription, "id">
): Promise<Subscription> {
  const newSub: Subscription = {
    ...sub,
    id: crypto.randomUUID(),
  };
  await db()
    .collection(COL_SUBSCRIPTIONS)
    .doc(newSub.id)
    .set(forFirestore(newSub));
  return newSub;
}

export async function updateSubscription(
  id: string,
  updates: Partial<Omit<Subscription, "id">>
): Promise<Subscription | undefined> {
  const ref = db().collection(COL_SUBSCRIPTIONS).doc(id);
  const cur = await ref.get();
  if (!cur.exists) return undefined;
  await ref.set(
    forFirestore({ ...cur.data(), ...updates }),
    { merge: true }
  );
  const after = await ref.get();
  return { id: after.id, ...after.data() } as Subscription;
}

export async function deleteSubscription(id: string): Promise<void> {
  await db().collection(COL_SUBSCRIPTIONS).doc(id).delete();
}

export async function deleteOrder(id: string): Promise<void> {
  await db().collection(COL_ORDERS).doc(id).delete();
}

/** Processed on-chain renewal payments (idempotency: doc id = tx hash hex, lowercased). */
export interface RenewalTxRecord {
  txHashHex: string;
  orderId: string;
  subscriptionId: string;
  /** Total nanos paid in this renewal transaction. */
  amountNanos: number;
  /** Number of billing months covered (1–3). Omit on legacy records. */
  months?: number;
  processedAt: string;
}

export function normalizeRenewalTxHashHex(raw: string): string {
  return raw.trim().toLowerCase().replace(/^0x/, "");
}

export async function getRenewalTxByHash(
  txHashHex: string
): Promise<RenewalTxRecord | undefined> {
  const id = normalizeRenewalTxHashHex(txHashHex);
  if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
  const doc = await db().collection(COL_RENEWAL_TXS).doc(id).get();
  if (!doc.exists) return undefined;
  return doc.data() as RenewalTxRecord;
}

export async function commitSubscriptionRenewalWithTxRecord(params: {
  txHashHex: string;
  orderId: string;
  subscriptionId: string;
  /** Total nanos for this payment (sum of months). */
  totalPaidNanos: number;
  /** Months of coverage (1–3). */
  months: number;
  /** Snapshot: one month in nanos written to the subscription row. */
  subscriptionMonthlyNanos: number;
  lastPaymentAt: string;
  nextPaymentAt: string;
}): Promise<"applied" | "idempotent"> {
  const id = normalizeRenewalTxHashHex(params.txHashHex);
  const renewalRef = db().collection(COL_RENEWAL_TXS).doc(id);
  const subRef = db().collection(COL_SUBSCRIPTIONS).doc(params.subscriptionId);

  return db().runTransaction(async (transaction) => {
    const renewalSnap = await transaction.get(renewalRef);
    if (renewalSnap.exists) {
      const d = renewalSnap.data() as RenewalTxRecord;
      if (d.orderId !== params.orderId) {
        throw new Error("TX_CONFLICT_ORDER");
      }
      return "idempotent";
    }

    const subSnap = await transaction.get(subRef);
    if (!subSnap.exists) {
      throw new Error("SUBSCRIPTION_GONE");
    }

    const record: RenewalTxRecord = {
      txHashHex: id,
      orderId: params.orderId,
      subscriptionId: params.subscriptionId,
      amountNanos: params.totalPaidNanos,
      months: params.months,
      processedAt: params.lastPaymentAt,
    };
    transaction.set(renewalRef, forFirestore(record));

    transaction.update(subRef, {
      lastPaymentAt: params.lastPaymentAt,
      nextPaymentAt: params.nextPaymentAt,
      status: "active",
      amountNanos: params.subscriptionMonthlyNanos,
    });

    return "applied";
  });
}
