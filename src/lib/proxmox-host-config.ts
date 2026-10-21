/**
 * Firestore-backed defaults for new VM creation (placement, storage, network).
 *
 * Doc path: `proxmox_host_config/default`.
 * Env vars remain fallbacks when Firestore fields are blank.
 */

import { getFirestoreDb } from "@/lib/firebase-admin";

const COL = "proxmox_host_config";
const DEFAULT_DOC_ID = "default";
const DEFAULT_DISK_STORAGE = "SAN_HDD";

/** Proxmox storage IDs: letter-first, then letters, digits, underscore, hyphen. */
const DISK_STORAGE_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/;
/** Proxmox node names (hostname-style). */
const NODE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
/** Linux bridge names used for net0 / net1 (IFNAMSIZ is 16 including NUL). */
const BRIDGE_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/;
const DEFAULT_PUBLIC_VLAN_TAG = 888;
const DEFAULT_BRIDGE = "vmbr0";

export interface ProxmoxHostConfig {
  /** Default Proxmox node for new clones when a service plan has no `proxmoxNode`. */
  defaultCloneNode?: string;
  /**
   * When false, new VMs stay on `defaultCloneNode` / template node instead of auto-balancing
   * across the cluster. Unset = enabled (legacy behaviour).
   */
  autoPlaceNewVms?: boolean;
  /** Target storage for full VM clones and new extra data disks. */
  defaultDiskStorage?: string;
  /** Proxmox storage pool where vzdump backups are listed for restore. */
  backupStorage?: string;
  /** Bridge for the public NIC (`net0`) on new guests. */
  publicBridge?: string;
  /**
   * VLAN tag on `net0`. `0` omits the tag. Unset falls through to env, then 888.
   */
  publicVlanTag?: number;
  /** Bridge for the per-user private NIC (`net1`). */
  privateLanBridge?: string;
  updatedAt?: string;
}

export type ProxmoxHostConfigEffective = ProxmoxHostConfig & {
  effectiveDefaultCloneNode: string;
  effectiveDefaultDiskStorage: string;
  effectiveBackupStorage: string;
  effectiveAutoPlaceNewVms: boolean;
  effectivePublicBridge: string;
  /** `null` means the public NIC is untagged. */
  effectivePublicVlanTag: number | null;
  effectivePrivateLanBridge: string;
};

interface RawConfigDoc {
  defaultCloneNode?: unknown;
  autoPlaceNewVms?: unknown;
  defaultDiskStorage?: unknown;
  backupStorage?: unknown;
  publicBridge?: unknown;
  publicVlanTag?: unknown;
  privateLanBridge?: unknown;
  updatedAt?: unknown;
}

function asTrimmedString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

/** `0`–`4094` are stored values (`0` omits the tag). Anything else is unset. */
function asVlanTag(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isInteger(n) || n < 0 || n > 4094) return undefined;
  return n;
}

export function validateProxmoxDiskStorageId(raw: string): string | { error: string } {
  const s = raw.trim();
  if (!s) return { error: "Storage ID cannot be empty." };
  if (s.length > 63) return { error: "Storage ID is too long (max 63 characters)." };
  if (!DISK_STORAGE_RE.test(s)) {
    return {
      error:
        "Storage ID must start with a letter and contain only letters, digits, underscores, or hyphens.",
    };
  }
  return s;
}

export function validateProxmoxBridgeName(raw: string): string | { error: string } {
  const s = raw.trim();
  if (!s) return { error: "Bridge name cannot be empty." };
  if (!BRIDGE_RE.test(s)) {
    return {
      error:
        "Bridge name must start with a letter and contain only letters, digits, underscores, or hyphens (max 15 characters).",
    };
  }
  return s;
}

/** `0` omits the public VLAN tag. */
export function validatePublicVlanTag(raw: number): number | { error: string } {
  if (!Number.isInteger(raw) || raw < 0 || raw > 4094) {
    return {
      error: "Public VLAN must be an integer from 0 to 4094. Use 0 to omit the tag.",
    };
  }
  return raw;
}

export function validateProxmoxNodeName(raw: string): string | { error: string } {
  const s = raw.trim();
  if (!s) return { error: "Node name cannot be empty." };
  if (s.length > 63) return { error: "Node name is too long (max 63 characters)." };
  if (!NODE_NAME_RE.test(s)) {
    return {
      error:
        "Node name must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens.",
    };
  }
  return s;
}

let cached: { value: ProxmoxHostConfig; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

async function readFirestoreConfig(): Promise<ProxmoxHostConfig> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  let value: ProxmoxHostConfig = {};
  try {
    const snap = await getFirestoreDb().collection(COL).doc(DEFAULT_DOC_ID).get();
    if (snap.exists) {
      const raw = (snap.data() ?? {}) as RawConfigDoc;
      value = {
        defaultCloneNode: asTrimmedString(raw.defaultCloneNode),
        autoPlaceNewVms: asBoolean(raw.autoPlaceNewVms),
        defaultDiskStorage: asTrimmedString(raw.defaultDiskStorage),
        backupStorage: asTrimmedString(raw.backupStorage),
        publicBridge: asTrimmedString(raw.publicBridge),
        publicVlanTag: asVlanTag(raw.publicVlanTag),
        privateLanBridge: asTrimmedString(raw.privateLanBridge),
        updatedAt: asTrimmedString(raw.updatedAt),
      };
    }
  } catch (err) {
    console.warn(
      "[proxmox-host-config] failed to read Firestore config; falling back to env:",
      err
    );
  }

  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export function invalidateProxmoxHostConfigCache(): void {
  cached = null;
}

function envPublicVlanTag(): number | null {
  const raw = process.env.PROXMOX_PUBLIC_VLAN_TAG;
  if (raw == null) return DEFAULT_PUBLIC_VLAN_TAG;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "0") return null;
  const n = parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < 1 || n > 4094) {
    throw new Error(
      `PROXMOX_PUBLIC_VLAN_TAG must be 1–4094 or 0 to disable (got ${JSON.stringify(raw)})`
    );
  }
  return n;
}

function withEffectiveFields(fromStore: ProxmoxHostConfig): ProxmoxHostConfigEffective {
  const envNode = asTrimmedString(process.env.PROXMOX_DEFAULT_NODE);
  const envStorage = asTrimmedString(process.env.PROXMOX_DISK_STORAGE);
  const envBackupStorage = asTrimmedString(process.env.PROXMOX_BACKUP_STORAGE);
  const envPublicBridge = asTrimmedString(process.env.PROXMOX_PUBLIC_BRIDGE);
  const envPrivateBridge = asTrimmedString(process.env.PROXMOX_PRIVATE_LAN_BRIDGE);
  const envDisableAuto =
    process.env.PROXMOX_AUTO_PLACE_VMS === "0" ||
    process.env.PROXMOX_AUTO_PLACE_VMS === "false";

  const effectiveDefaultDiskStorage =
    fromStore.defaultDiskStorage ?? envStorage ?? DEFAULT_DISK_STORAGE;
  const effectivePrivateLanBridge =
    fromStore.privateLanBridge ?? envPrivateBridge ?? DEFAULT_BRIDGE;

  const storedVlan = fromStore.publicVlanTag;
  const effectivePublicVlanTag =
    storedVlan === undefined ? envPublicVlanTag() : storedVlan === 0 ? null : storedVlan;

  return {
    ...fromStore,
    effectiveDefaultCloneNode: fromStore.defaultCloneNode ?? envNode ?? "",
    effectiveDefaultDiskStorage,
    effectiveBackupStorage:
      fromStore.backupStorage ?? envBackupStorage ?? effectiveDefaultDiskStorage,
    effectiveAutoPlaceNewVms:
      fromStore.autoPlaceNewVms !== undefined
        ? fromStore.autoPlaceNewVms
        : !envDisableAuto,
    effectivePublicBridge:
      fromStore.publicBridge ??
      envPublicBridge ??
      envPrivateBridge ??
      DEFAULT_BRIDGE,
    effectivePublicVlanTag,
    effectivePrivateLanBridge,
  };
}

/** Proxmox `net0` value: virtio on the public bridge, optionally VLAN-tagged. */
export function formatPublicNet0(bridge: string, vlanTag: number | null): string {
  return vlanTag != null
    ? `virtio,bridge=${bridge},tag=${vlanTag}`
    : `virtio,bridge=${bridge}`;
}

/**
 * Public NIC for a new guest. `bridgeOverride` replaces the configured bridge
 * and still uses the configured VLAN tag.
 */
export async function resolvePublicNet0(bridgeOverride?: string): Promise<string> {
  const cfg = await getProxmoxHostConfig();
  const bridge = bridgeOverride?.trim() || cfg.effectivePublicBridge;
  return formatPublicNet0(bridge, cfg.effectivePublicVlanTag);
}

/** Effective host defaults: Firestore → env → built-in fallbacks. */
export async function getProxmoxHostConfig(): Promise<ProxmoxHostConfigEffective> {
  const fromStore = await readFirestoreConfig();
  return withEffectiveFields(fromStore);
}

/** Resolved storage pool for clone / extra-disk paths. */
export async function resolveProxmoxDiskStoragePool(): Promise<string> {
  const cfg = await getProxmoxHostConfig();
  return cfg.effectiveDefaultDiskStorage;
}

/** Resolved storage pool for listing / restoring vzdump backups. */
export async function resolveProxmoxBackupStoragePool(): Promise<string> {
  const cfg = await getProxmoxHostConfig();
  return cfg.effectiveBackupStorage;
}

/** Admin write — pass `null` to clear a Firestore override. */
export async function setProxmoxHostConfig(patch: {
  defaultCloneNode?: string | null;
  autoPlaceNewVms?: boolean | null;
  defaultDiskStorage?: string | null;
  backupStorage?: string | null;
  publicBridge?: string | null;
  /** `null` clears the override. `0` omits the public VLAN tag. */
  publicVlanTag?: number | null;
  privateLanBridge?: string | null;
}): Promise<ProxmoxHostConfigEffective> {
  const ref = getFirestoreDb().collection(COL).doc(DEFAULT_DOC_ID);
  const update: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };

  if (patch.defaultCloneNode !== undefined) {
    if (patch.defaultCloneNode === null || patch.defaultCloneNode === "") {
      update.defaultCloneNode = null;
    } else {
      const validated = validateProxmoxNodeName(patch.defaultCloneNode);
      if (typeof validated === "object") throw new Error(validated.error);
      update.defaultCloneNode = validated;
    }
  }

  if (patch.autoPlaceNewVms !== undefined) {
    update.autoPlaceNewVms =
      patch.autoPlaceNewVms === null ? null : Boolean(patch.autoPlaceNewVms);
  }

  if (patch.defaultDiskStorage !== undefined) {
    if (patch.defaultDiskStorage === null || patch.defaultDiskStorage === "") {
      update.defaultDiskStorage = null;
    } else {
      const validated = validateProxmoxDiskStorageId(patch.defaultDiskStorage);
      if (typeof validated === "object") throw new Error(validated.error);
      update.defaultDiskStorage = validated;
    }
  }

  if (patch.backupStorage !== undefined) {
    if (patch.backupStorage === null || patch.backupStorage === "") {
      update.backupStorage = null;
    } else {
      const validated = validateProxmoxDiskStorageId(patch.backupStorage);
      if (typeof validated === "object") throw new Error(validated.error);
      update.backupStorage = validated;
    }
  }

  if (patch.publicBridge !== undefined) {
    if (patch.publicBridge === null || patch.publicBridge === "") {
      update.publicBridge = null;
    } else {
      const validated = validateProxmoxBridgeName(patch.publicBridge);
      if (typeof validated === "object") throw new Error(validated.error);
      update.publicBridge = validated;
    }
  }

  if (patch.publicVlanTag !== undefined) {
    if (patch.publicVlanTag === null) {
      update.publicVlanTag = null;
    } else {
      const validated = validatePublicVlanTag(patch.publicVlanTag);
      if (typeof validated === "object") throw new Error(validated.error);
      update.publicVlanTag = validated;
    }
  }

  if (patch.privateLanBridge !== undefined) {
    if (patch.privateLanBridge === null || patch.privateLanBridge === "") {
      update.privateLanBridge = null;
    } else {
      const validated = validateProxmoxBridgeName(patch.privateLanBridge);
      if (typeof validated === "object") throw new Error(validated.error);
      update.privateLanBridge = validated;
    }
  }

  await ref.set(update, { merge: true });
  invalidateProxmoxHostConfigCache();
  return getProxmoxHostConfig();
}
