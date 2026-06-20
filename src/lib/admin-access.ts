/**
 * Firestore-backed admin public keys (merged with `ADMIN_PUBLIC_KEYS` env at auth time).
 *
 * Collection: `admin_public_keys` — document id = DeSo public key.
 */

import { getFirestoreDb } from "@/lib/firebase-admin";

const COL = "admin_public_keys";

/** Base58-style DeSo public keys (main or derived); permissive length check. */
const PUBLIC_KEY_RE = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmno]{50,120}$/;

export type FirestoreAdminRecord = {
  publicKey: string;
  addedAt: string;
  addedBy?: string;
};

export type AdminDirectoryEntry = {
  publicKey: string;
  source: "env" | "firestore";
  locked: boolean;
  addedAt?: string;
  addedBy?: string;
};

let cachedKeys: { keys: Set<string>; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5_000;

export function envAdminPublicKeys(): string[] {
  return (process.env.ADMIN_PUBLIC_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export function validateAdminPublicKey(raw: string): string | { error: string } {
  const s = raw.trim();
  if (!s) return { error: "Public key is required." };
  if (!PUBLIC_KEY_RE.test(s)) {
    return { error: "Enter a valid DeSo public key (base58, 50+ characters)." };
  }
  return s;
}

export function invalidateAdminPublicKeysCache(): void {
  cachedKeys = null;
}

async function readFirestoreAdminKeys(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedKeys && cachedKeys.expiresAt > now) {
    return cachedKeys.keys;
  }

  const keys = new Set<string>();
  try {
    const snap = await getFirestoreDb().collection(COL).get();
    for (const doc of snap.docs) {
      const pk =
        typeof doc.data().publicKey === "string"
          ? doc.data().publicKey.trim()
          : doc.id.trim();
      if (pk) keys.add(pk);
    }
  } catch (err) {
    console.warn("[admin-access] failed to read Firestore admins:", err);
  }

  cachedKeys = { keys, expiresAt: now + CACHE_TTL_MS };
  return keys;
}

/** Env admins plus Firestore admins (deduped). */
export async function allAdminPublicKeys(): Promise<string[]> {
  const merged = new Set<string>(envAdminPublicKeys());
  for (const k of await readFirestoreAdminKeys()) merged.add(k);
  return [...merged];
}

export async function publicKeyIsAdminAsync(publicKey: string): Promise<boolean> {
  const pk = publicKey.trim();
  if (!pk) return false;
  if (envAdminPublicKeys().includes(pk)) return true;
  return (await readFirestoreAdminKeys()).has(pk);
}

export async function listAdminDirectory(
  currentUserPublicKey?: string
): Promise<{
  admins: AdminDirectoryEntry[];
  currentUserPublicKey?: string;
}> {
  const envSet = new Set(envAdminPublicKeys());

  const admins: AdminDirectoryEntry[] = [];

  for (const publicKey of envSet) {
    admins.push({ publicKey, source: "env", locked: true });
  }

  const snap = await getFirestoreDb().collection(COL).get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const publicKey =
      (typeof data.publicKey === "string" ? data.publicKey.trim() : doc.id.trim()) ||
      "";
    if (!publicKey || envSet.has(publicKey)) continue;
    admins.push({
      publicKey,
      source: "firestore",
      locked: false,
      addedAt:
        typeof data.addedAt === "string" ? data.addedAt : undefined,
      addedBy:
        typeof data.addedBy === "string" ? data.addedBy : undefined,
    });
  }

  admins.sort((a, b) => a.publicKey.localeCompare(b.publicKey));

  return {
    admins,
    currentUserPublicKey: currentUserPublicKey?.trim() || undefined,
  };
}

export async function addFirestoreAdmin(
  publicKey: string,
  addedBy: string
): Promise<FirestoreAdminRecord> {
  const validated = validateAdminPublicKey(publicKey);
  if (typeof validated === "object") throw new Error(validated.error);

  if (envAdminPublicKeys().includes(validated)) {
    throw new Error("This key is already an admin via server environment config.");
  }

  const ref = getFirestoreDb().collection(COL).doc(validated);
  const existing = await ref.get();
  if (existing.exists) {
    throw new Error("This public key is already an admin.");
  }

  const row: FirestoreAdminRecord = {
    publicKey: validated,
    addedAt: new Date().toISOString(),
    addedBy: addedBy.trim() || undefined,
  };

  await ref.set(row);
  invalidateAdminPublicKeysCache();
  return row;
}

export async function removeFirestoreAdmin(publicKey: string): Promise<void> {
  const pk = publicKey.trim();
  if (!pk) throw new Error("Public key is required.");

  if (envAdminPublicKeys().includes(pk)) {
    throw new Error(
      "This admin is defined in ADMIN_PUBLIC_KEYS and cannot be removed here."
    );
  }

  const ref = getFirestoreDb().collection(COL).doc(pk);
  const cur = await ref.get();
  if (!cur.exists) {
    throw new Error("Admin not found.");
  }

  await ref.delete();
  invalidateAdminPublicKeysCache();
}

/** Block removing the last admin in the system. */
export async function canRemoveAdminPublicKey(
  publicKey: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pk = publicKey.trim();
  const all = await allAdminPublicKeys();
  if (!all.includes(pk)) {
    return { ok: false, error: "Admin not found." };
  }
  if (all.length <= 1) {
    return { ok: false, error: "Cannot remove the only remaining admin." };
  }
  return { ok: true };
}
