/**
 * Firestore persistence via Firebase Admin SDK (server-side only).
 * Configure credentials in `.env` (see `.env.example`).
 */

import { getFirestoreDb } from "@/lib/firebase-admin";

const COL_SERVICES = "services";
const COL_ORDERS = "orders";
const COL_SUBSCRIPTIONS = "subscriptions";
const COL_RENEWAL_TXS = "renewal_txs";
/** Global QEMU templates (label → Proxmox template VMID) shown at checkout and reinstall. */
const COL_OS_TEMPLATES = "os_templates";

const OS_TEMPLATE_ID_RE = /^[a-z][a-z0-9_-]{0,62}$/i;
const MAX_HOSTED_OS_TEMPLATES = 100;

/** Assignable QEMU template (clone source) for checkout / reinstall; stored per plan or per order. */
export type ServiceImageProfile = {
  /** Stable slug for APIs (Firestore-safe id). */
  id: string;
  /** Display name for checkout / dashboard / reinstall. */
  label: string;
  /** Source QEMU VMID (template guest) on Proxmox. */
  templateVmid: number;
};

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
  /** @deprecated Prefer `TEMPLATE_CATALOG_JSON` or OS templates on individual orders (`orders.imageProfiles`). */
  proxmoxTemplate?: number;
  proxmoxNode?: string;
  /**
   * @deprecated Prefer storing OS templates per order (`orders.imageProfiles`)
   * or defining `TEMPLATE_CATALOG_JSON` in the environment instead of catalogue plans.
   */
  imageProfiles?: ServiceImageProfile[];
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
  /**
   * Proxmox template VMID this guest was cloned from after the last successful provision or reinstall.
   */
  cloneTemplateVmid?: number;
  /** Matches `cloneTemplateVmid` / `orders.imageProfiles[].id`, when known. */
  cloneImageProfileId?: string;
  /**
   * Per-VPS override for clone/reinstall catalogue. When empty/absent the host uses the global list
   * in Firestore `os_templates`, then `TEMPLATE_CATALOG_JSON`, then legacy plan fields on the SKU.
   */
  imageProfiles?: ServiceImageProfile[];
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
  /**
   * Set while upgrade/downgrade (halt → resize CPU/RAM/disk → start) runs on the hypervisor so
   * the dashboard can poll and disable overlapping actions.
   */
  adjustingPlan?: boolean;
  /**
   * Set while extra-disk attach/detach runs (guest stopped briefly).
   */
  hardwareMaintenance?: boolean;
  /** Set while a vzdump backup restore runs (stop → restore → start). */
  backupRestoreInProgress?: boolean;
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

// --- Global OS templates (Firestore `os_templates`) — checkout / reinstall catalogue

/** Admin row plus {@link ServiceImageProfile} shaped fields (document id == `id`). */
export type HostedOsTemplateRecord = ServiceImageProfile & {
  active: boolean;
  sortOrder: number;
  createdAt: string;
};

let hostedOsTemplatesCache: {
  at: number;
  data: ServiceImageProfile[];
} | null = null;

const HOSTED_OS_TEMPLATES_CACHE_MS = 30_000;

function invalidateHostedOsTemplatesCache(): void {
  hostedOsTemplatesCache = null;
}

function parseHostedTemplateDoc(
  docId: string,
  raw: Record<string, unknown>
): HostedOsTemplateRecord | null {
  if (!OS_TEMPLATE_ID_RE.test(docId)) return null;
  const label =
    typeof raw.label === "string"
      ? raw.label.trim().slice(0, 160)
      : "";
  const tvmidRaw = raw.templateVmid;
  const templateVmid =
    typeof tvmidRaw === "number"
      ? Math.floor(tvmidRaw)
      : parseInt(String(tvmidRaw ?? "").trim(), 10);
  if (!label || !Number.isFinite(templateVmid) || templateVmid <= 0)
    return null;
  const active = raw.active !== false;
  const sortOrderRaw = raw.sortOrder;
  const sortOrder =
    typeof sortOrderRaw === "number" && Number.isFinite(sortOrderRaw)
      ? sortOrderRaw
      : typeof sortOrderRaw === "string"
        ? parseInt(sortOrderRaw, 10)
        : 0;
  const sortOrderSan = Number.isFinite(sortOrder) ? sortOrder : 0;
  const createdAt =
    typeof raw.createdAt === "string"
      ? raw.createdAt
      : new Date().toISOString();
  return {
    id: docId,
    label,
    templateVmid,
    active,
    sortOrder: sortOrderSan,
    createdAt,
  };
}

/** Active profiles for checkout/API (sorted). Short-TTL memoized inside this process. */
export async function readActiveOsTemplateProfiles(): Promise<ServiceImageProfile[]> {
  const now = Date.now();
  if (
    hostedOsTemplatesCache &&
    now - hostedOsTemplatesCache.at < HOSTED_OS_TEMPLATES_CACHE_MS
  ) {
    return hostedOsTemplatesCache.data;
  }
  const snap = await db().collection(COL_OS_TEMPLATES).get();
  const rows = snap.docs
    .map((d) => parseHostedTemplateDoc(d.id, d.data() as Record<string, unknown>))
    .filter((r): r is HostedOsTemplateRecord => r !== null && r.active)
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id)
    )
    .map(({ id, label, templateVmid }) => ({ id, label, templateVmid }));

  hostedOsTemplatesCache = { at: now, data: rows };
  return rows;
}

/** Full list including inactive templates (Admin UI). */
export async function listHostedOsTemplatesAdmin(): Promise<
  HostedOsTemplateRecord[]
> {
  const snap = await db().collection(COL_OS_TEMPLATES).get();
  const rows = snap.docs
    .map((d) => parseHostedTemplateDoc(d.id, d.data() as Record<string, unknown>))
    .filter((r): r is HostedOsTemplateRecord => r !== null)
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id)
    );
  return rows;
}

async function vmidTakenInHostedTemplates(
  templateVmid: number,
  excludeDocId?: string
): Promise<boolean> {
  const snap = await db().collection(COL_OS_TEMPLATES).get();
  const t = Math.floor(templateVmid);
  for (const d of snap.docs) {
    if (excludeDocId && d.id === excludeDocId) continue;
    const row = parseHostedTemplateDoc(d.id, d.data() as Record<string, unknown>);
    if (!row) continue;
    if (row.templateVmid === t) return true;
  }
  return false;
}

export async function createHostedOsTemplate(params: {
  id: string;
  label: string;
  templateVmid: number;
  active?: boolean;
  sortOrder?: number;
}): Promise<HostedOsTemplateRecord | { error: string }> {
  const id = params.id.trim().toLowerCase();
  if (!OS_TEMPLATE_ID_RE.test(id)) {
    return {
      error:
        'Template id must start with a letter and use only letters, numbers, underscores, and hyphens (max 63 chars after the first letter).',
    };
  }
  const label = params.label.trim().slice(0, 160);
  const tvmid = Math.floor(Number(params.templateVmid));
  if (!label || !Number.isFinite(tvmid) || tvmid <= 0) {
    return { error: "Label and positive template VMID are required." };
  }
  const ref = db().collection(COL_OS_TEMPLATES).doc(id);
  const exists = await ref.get();
  if (exists.exists) return { error: `Template id "${id}" already exists.` };

  const countSnap = await db()
    .collection(COL_OS_TEMPLATES)
    .limit(MAX_HOSTED_OS_TEMPLATES + 1)
    .get();
  if (countSnap.docs.length >= MAX_HOSTED_OS_TEMPLATES) {
    return {
      error: `At most ${MAX_HOSTED_OS_TEMPLATES} global OS templates are allowed.`,
    };
  }

  const active = params.active !== false;
  const sortOrder =
    params.sortOrder != null && Number.isFinite(Number(params.sortOrder))
      ? Math.floor(Number(params.sortOrder))
      : 0;
  const createdAt = new Date().toISOString();

  if (await vmidTakenInHostedTemplates(tvmid)) {
    return { error: "Another OS template already uses this Proxmox VMID." };
  }

  await ref.set(
    forFirestore({
      label,
      templateVmid: tvmid,
      active,
      sortOrder,
      createdAt,
    })
  );
  invalidateHostedOsTemplatesCache();
  return {
    id,
    label,
    templateVmid: tvmid,
    active,
    sortOrder,
    createdAt,
  };
}

export async function updateHostedOsTemplate(
  id: string,
  updates: Partial<{
    label: string;
    templateVmid: number;
    active: boolean;
    sortOrder: number;
  }>
): Promise<HostedOsTemplateRecord | { error: string } | undefined> {
  const docId = id.trim().toLowerCase();
  if (!OS_TEMPLATE_ID_RE.test(docId)) return { error: "Invalid template id." };
  const ref = db().collection(COL_OS_TEMPLATES).doc(docId);
  const cur = await ref.get();
  if (!cur.exists) return undefined;
  const curRow = parseHostedTemplateDoc(docId, cur.data() as Record<string, unknown>);
  if (!curRow) return { error: "Corrupt OS template row." };

  let label = curRow.label;
  if (typeof updates.label === "string") {
    label = updates.label.trim().slice(0, 160);
  }
  let templateVmid = curRow.templateVmid;
  if (updates.templateVmid != null) {
    const tvmid = Math.floor(Number(updates.templateVmid));
    if (!Number.isFinite(tvmid) || tvmid <= 0) {
      return { error: "templateVmid must be a positive integer." };
    }
    templateVmid = tvmid;
  }
  const active =
    typeof updates.active === "boolean" ? updates.active : curRow.active;
  const sortOrder =
    updates.sortOrder != null && Number.isFinite(Number(updates.sortOrder))
      ? Math.floor(Number(updates.sortOrder))
      : curRow.sortOrder;

  if (!label) return { error: "Label cannot be empty." };

  if (await vmidTakenInHostedTemplates(templateVmid, docId)) {
    return { error: "Another OS template already uses this Proxmox VMID." };
  }

  const merged: HostedOsTemplateRecord = {
    id: docId,
    label,
    templateVmid,
    active,
    sortOrder,
    createdAt: curRow.createdAt,
  };

  await ref.set(
    forFirestore({
      label,
      templateVmid,
      active,
      sortOrder,
      createdAt: curRow.createdAt,
    }),
    { merge: true }
  );
  invalidateHostedOsTemplatesCache();
  return merged;
}

export async function deleteHostedOsTemplate(
  id: string
): Promise<boolean> {
  const docId = id.trim().toLowerCase();
  if (!OS_TEMPLATE_ID_RE.test(docId)) return false;
  const ref = db().collection(COL_OS_TEMPLATES).doc(docId);
  const cur = await ref.get();
  if (!cur.exists) return false;
  await ref.delete();
  invalidateHostedOsTemplatesCache();
  return true;
}
