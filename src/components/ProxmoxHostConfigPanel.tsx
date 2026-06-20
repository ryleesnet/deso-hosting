"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type ProxmoxHostConfigState = {
  defaultCloneNode?: string;
  autoPlaceNewVms?: boolean;
  defaultDiskStorage?: string;
  effectiveDefaultCloneNode?: string;
  effectiveDefaultDiskStorage?: string;
  effectiveAutoPlaceNewVms?: boolean;
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
  const [effectiveNode, setEffectiveNode] = useState("");
  const [effectiveStorage, setEffectiveStorage] = useState("SAN_HDD");

  function applyConfig(data: ProxmoxHostConfigState) {
    setCloneNode(data.defaultCloneNode ?? "");
    setAutoPlace(data.autoPlaceNewVms ?? data.effectiveAutoPlaceNewVms ?? true);
    setDiskStorage(data.defaultDiskStorage ?? "");
    setEffectiveNode(data.effectiveDefaultCloneNode ?? "");
    setEffectiveStorage(data.effectiveDefaultDiskStorage ?? "SAN_HDD");
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
        <h2 className="text-xl font-semibold">Proxmox host defaults</h2>
      ) : (
        <h3 className="text-sm font-semibold">Proxmox clone defaults</h3>
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
