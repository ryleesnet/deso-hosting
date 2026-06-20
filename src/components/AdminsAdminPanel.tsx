"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type AdminEntry = {
  publicKey: string;
  source: "env" | "firestore";
  locked: boolean;
  addedAt?: string;
  addedBy?: string;
};

export function AdminsAdminPanel() {
  const [admins, setAdmins] = useState<AdminEntry[]>([]);
  const [currentUserPublicKey, setCurrentUserPublicKey] = useState("");
  const [newPublicKey, setNewPublicKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await apiFetch("/api/admin/admins");
    const data = (await res.json().catch(() => ({}))) as {
      admins?: AdminEntry[];
      currentUserPublicKey?: string;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    setAdmins(Array.isArray(data.admins) ? data.admins : []);
    setCurrentUserPublicKey(data.currentUserPublicKey ?? "");
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load()
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey: newPublicKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setAdmins(Array.isArray(data.admins) ? data.admins : []);
      setCurrentUserPublicKey(data.currentUserPublicKey ?? currentUserPublicKey);
      setNewPublicKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(publicKey: string) {
    if (!confirm("Remove admin access for this public key?")) return;
    setRemovingKey(publicKey);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/admins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setAdmins(Array.isArray(data.admins) ? data.admins : []);
      setCurrentUserPublicKey(data.currentUserPublicKey ?? currentUserPublicKey);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingKey(null);
    }
  }

  return (
    <section id="admin-admins" className="scroll-mt-28 mt-16">
      <h2 className="text-xl font-semibold">Administrators</h2>
      <p className="mt-2 max-w-3xl text-sm text-[var(--muted)] leading-relaxed">
        DeSo public keys with access to this admin panel. Keys listed as{" "}
        <span className="font-medium text-[var(--foreground)]">Environment</span> come from{" "}
        <code className="rounded bg-[var(--card)] px-1 text-xs">ADMIN_PUBLIC_KEYS</code>{" "}
        and cannot be removed here.
      </p>

      <div className="mt-4 rounded-xl border border-[var(--card-border)] bg-[var(--card)]/50 p-4">
        {loading ? (
          <p className="text-xs text-[var(--muted)]">Loading…</p>
        ) : (
          <>
            <ul className="space-y-2">
              {admins.length === 0 ? (
                <li className="text-sm text-[var(--muted)]">No admins configured.</li>
              ) : (
                admins.map((a) => {
                  const isSelf = a.publicKey === currentUserPublicKey;
                  return (
                    <li
                      key={a.publicKey}
                      className="flex flex-col gap-2 rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="break-all font-mono text-xs">{a.publicKey}</p>
                        <p className="mt-1 text-[10px] text-[var(--muted)]">
                          {a.source === "env" ? "Environment" : "Added in admin"}
                          {isSelf ? " · you" : ""}
                          {a.addedAt ? ` · ${a.addedAt.slice(0, 10)}` : ""}
                        </p>
                      </div>
                      {a.locked ? (
                        <span className="shrink-0 text-xs text-[var(--muted)]">Locked</span>
                      ) : (
                        <button
                          type="button"
                          disabled={removingKey === a.publicKey}
                          onClick={() => void handleRemove(a.publicKey)}
                          className="shrink-0 rounded border border-red-500/50 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {removingKey === a.publicKey ? "Removing…" : "Remove"}
                        </button>
                      )}
                    </li>
                  );
                })
              )}
            </ul>

            <form onSubmit={(e) => void handleAdd(e)} className="mt-4 space-y-3 border-t border-[var(--card-border)] pt-4">
              <div>
                <label
                  htmlFor="admin-new-public-key"
                  className="block text-xs text-[var(--muted)]"
                >
                  Add admin by DeSo public key
                </label>
                <textarea
                  id="admin-new-public-key"
                  value={newPublicKey}
                  onChange={(e) => setNewPublicKey(e.target.value)}
                  rows={2}
                  placeholder="BC1YL…"
                  className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs"
                  spellCheck={false}
                />
              </div>
              <button
                type="submit"
                disabled={adding || !newPublicKey.trim()}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add admin"}
              </button>
            </form>
          </>
        )}
        {error ? (
          <p className="mt-3 text-xs text-red-400" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
