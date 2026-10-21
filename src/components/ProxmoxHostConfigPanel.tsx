"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type ProxmoxHostConfigState = {
  defaultCloneNode?: string;
  autoPlaceNewVms?: boolean;
  defaultDiskStorage?: string;
  backupStorage?: string;
  publicBridge?: string;
  publicVlanTag?: number;
  privateLanBridge?: string;
  effectiveDefaultCloneNode?: string;
  effectiveDefaultDiskStorage?: string;
  effectiveBackupStorage?: string;
  effectiveAutoPlaceNewVms?: boolean;
  effectivePublicBridge?: string;
  effectivePublicVlanTag?: number | null;
  effectivePrivateLanBridge?: string;
  updatedAt?: string;
};

export function ProxmoxHostConfigPanel({ embedded = false }: { embedded?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [cloneNode, setCloneNode] = useState("");
  const [autoPlace, setAutoPlace] = useState(true);
  const [diskStorage, setDiskStorage] = useState("");
  const [backupStorage, setBackupStorage] = useState("");
  const [publicBridge, setPublicBridge] = useState("");
  const [publicVlanTag, setPublicVlanTag] = useState("");
  const [privateLanBridge, setPrivateLanBridge] = useState("");
  const [effectiveNode, setEffectiveNode] = useState("");
  const [effectiveStorage, setEffectiveStorage] = useState("SAN_HDD");
  const [effectiveBackupStorage, setEffectiveBackupStorage] = useState("SAN_HDD");
  const [effectivePublicBridge, setEffectivePublicBridge] = useState("vmbr0");
  const [effectivePublicVlanTag, setEffectivePublicVlanTag] = useState<number | null>(888);
  const [effectivePrivateLanBridge, setEffectivePrivateLanBridge] = useState("vmbr0");

  function applyConfig(data: ProxmoxHostConfigState) {
    setCloneNode(data.defaultCloneNode ?? "");
    setAutoPlace(data.autoPlaceNewVms ?? data.effectiveAutoPlaceNewVms ?? true);
    setDiskStorage(data.defaultDiskStorage ?? "");
    setBackupStorage(data.backupStorage ?? "");
    setPublicBridge(data.publicBridge ?? "");
    setPublicVlanTag(
      data.publicVlanTag == null ? "" : String(data.publicVlanTag)
    );
    setPrivateLanBridge(data.privateLanBridge ?? "");
    setEffectiveNode(data.effectiveDefaultCloneNode ?? "");
    setEffectiveStorage(data.effectiveDefaultDiskStorage ?? "SAN_HDD");
    setEffectiveBackupStorage(data.effectiveBackupStorage ?? "SAN_HDD");
    setEffectivePublicBridge(data.effectivePublicBridge ?? "vmbr0");
    setEffectivePublicVlanTag(
      data.effectivePublicVlanTag === undefined ? 888 : data.effectivePublicVlanTag
    );
    setEffectivePrivateLanBridge(data.effectivePrivateLanBridge ?? "vmbr0");
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiFetch("/api/admin/proxmox-config")
      .then(async (r) => {
        const data = (await r.json().catch(() => ({}))) as ProxmoxHostConfigState & {
          error?: string;
        };
        if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        applyConfig(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await apiFetch("/api/admin/proxmox-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultCloneNode: cloneNode.trim() || null,
          autoPlaceNewVms: autoPlace,
          defaultDiskStorage: diskStorage.trim() || null,
          backupStorage: backupStorage.trim() || null,
          publicBridge: publicBridge.trim() || null,
          publicVlanTag: publicVlanTag.trim() === "" ? null : Number(publicVlanTag.trim()),
          privateLanBridge: privateLanBridge.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ProxmoxHostConfigState & {
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      applyConfig(data);
      setSavedAt(data.updatedAt ?? new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={embedded ? "mt-8" : "mt-12 scroll-mt-28"} id={embedded ? undefined : "admin-host-proxmox"}>
      {!embedded ? (
        <h2 className="text-xl font-semibold">VM Creation Defaults</h2>
      ) : (
        <h3 className="text-sm font-semibold">VM Creation Defaults</h3>
      )}
      <div className="mt-4 rounded-xl border border-[var(--card-border)] bg-[var(--card)]/50 p-4">
        <h3 className="text-sm font-semibold">Clone placement &amp; storage</h3>
        <p className="mt-2 text-xs text-[var(--muted)] leading-relaxed">
          Used when a VPS plan does not set its own Proxmox node. OS templates must
          exist on the clone node (or shared storage must allow cross-node clones).
          Per-plan <strong className="font-medium text-[var(--foreground)]">Preferred Proxmox node</strong>{" "}
          on a service SKU still overrides these defaults.
        </p>
        {loading ? (
          <p className="mt-3 text-xs text-[var(--muted)]">Loading…</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <label
                  htmlFor="proxmox-default-clone-node"
                  className="block text-xs text-[var(--muted)]"
                >
                  Default clone node
                </label>
                <input
                  id="proxmox-default-clone-node"
                  type="text"
                  value={cloneNode}
                  onChange={(e) => setCloneNode(e.target.value)}
                  placeholder={
                    effectiveNode || "Not set — uses plan or env"
                  }
                  className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="min-w-0">
                <label
                  htmlFor="proxmox-default-disk-storage"
                  className="block text-xs text-[var(--muted)]"
                >
                  Default VM disk storage
                </label>
                <input
                  id="proxmox-default-disk-storage"
                  type="text"
                  value={diskStorage}
                  onChange={(e) => setDiskStorage(e.target.value)}
                  placeholder={effectiveStorage}
                  className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="min-w-0 sm:col-span-2">
                <label
                  htmlFor="proxmox-backup-storage"
                  className="block text-xs text-[var(--muted)]"
                >
                  Backup storage pool
                </label>
                <input
                  id="proxmox-backup-storage"
                  type="text"
                  value={backupStorage}
                  onChange={(e) => setBackupStorage(e.target.value)}
                  placeholder={effectiveBackupStorage}
                  className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Proxmox storage ID where vzdump archives for customer restores are
                  listed. Leave blank to use disk storage (
                  <span className="font-mono">{effectiveStorage}</span>
                  ).
                </p>
              </div>
            </div>
            <div className="border-t border-[var(--card-border)] pt-4">
              <h4 className="text-sm font-semibold">Network</h4>
              <p className="mt-2 text-xs text-[var(--muted)] leading-relaxed">
                Public <span className="font-mono">net0</span> and private{" "}
                <span className="font-mono">net1</span> for new guests. Leave a
                field blank to use the env fallback. Public VLAN{" "}
                <span className="font-mono">0</span> omits the tag. Each
                customer&apos;s private VLAN is still assigned automatically.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <label
                    htmlFor="proxmox-public-bridge"
                    className="block text-xs text-[var(--muted)]"
                  >
                    Public bridge
                  </label>
                  <input
                    id="proxmox-public-bridge"
                    type="text"
                    value={publicBridge}
                    onChange={(e) => setPublicBridge(e.target.value)}
                    placeholder={effectivePublicBridge}
                    className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
                <div className="min-w-0">
                  <label
                    htmlFor="proxmox-public-vlan"
                    className="block text-xs text-[var(--muted)]"
                  >
                    Public VLAN
                  </label>
                  <input
                    id="proxmox-public-vlan"
                    type="number"
                    min={0}
                    max={4094}
                    value={publicVlanTag}
                    onChange={(e) => setPublicVlanTag(e.target.value)}
                    placeholder={
                      effectivePublicVlanTag == null
                        ? "0"
                        : String(effectivePublicVlanTag)
                    }
                    className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div className="min-w-0 sm:col-span-2">
                  <label
                    htmlFor="proxmox-private-bridge"
                    className="block text-xs text-[var(--muted)]"
                  >
                    Private LAN bridge
                  </label>
                  <input
                    id="proxmox-private-bridge"
                    type="text"
                    value={privateLanBridge}
                    onChange={(e) => setPrivateLanBridge(e.target.value)}
                    placeholder={effectivePrivateLanBridge}
                    className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    In effect: public{" "}
                    <span className="font-mono">
                      {effectivePublicBridge}
                      {effectivePublicVlanTag == null
                        ? ""
                        : ` tag ${effectivePublicVlanTag}`}
                    </span>
                    , private bridge{" "}
                    <span className="font-mono">{effectivePrivateLanBridge}</span>.
                  </p>
                </div>
              </div>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoPlace}
                onChange={(e) => setAutoPlace(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Auto-select cluster node</span>
                <span className="mt-0.5 block text-xs text-[var(--muted)]">
                  When enabled, pick the online node with the most free RAM (requires
                  shared storage for cross-node clones). When disabled, new VMs stay on
                  the default clone node above.
                </span>
              </span>
            </label>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save defaults"}
            </button>
          </div>
        )}
        {error ? (
          <p className="mt-3 text-xs text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        {savedAt ? (
          <p className="mt-2 text-xs text-green-400">Saved {savedAt}</p>
        ) : null}
      </div>
    </section>
  );
}
