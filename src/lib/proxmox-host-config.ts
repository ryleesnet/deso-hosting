/**
 * Firestore-backed Proxmox host defaults (clone placement + disk storage).
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
  updatedAt?: string;
}

export type ProxmoxHostConfigEffective = ProxmoxHostConfig & {
  effectiveDefaultCloneNode: string;
  effectiveDefaultDiskStorage: string;
  effectiveBackupStorage: string;
  effectiveAutoPlaceNewVms: boolean;
};

interface RawConfigDoc {
  defaultCloneNode?: unknown;
  autoPlaceNewVms?: unknown;
  defaultDiskStorage?: unknown;
  backupStorage?: unknown;
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

function withEffectiveFields(fromStore: ProxmoxHostConfig): ProxmoxHostConfigEffective {
  const envNode = asTrimmedString(process.env.PROXMOX_DEFAULT_NODE);
  const envStorage = asTrimmedString(process.env.PROXMOX_DISK_STORAGE);
  const envBackupStorage = asTrimmedString(process.env.PROXMOX_BACKUP_STORAGE);
  const envDisableAuto =
    process.env.PROXMOX_AUTO_PLACE_VMS === "0" ||
    process.env.PROXMOX_AUTO_PLACE_VMS === "false";

  const effectiveDefaultDiskStorage =
    fromStore.defaultDiskStorage ?? envStorage ?? DEFAULT_DISK_STORAGE;

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
  };
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

  await ref.set(update, { merge: true });
  invalidateProxmoxHostConfigCache();
  return getProxmoxHostConfig();
}
