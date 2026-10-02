"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type LogLevel = "info" | "warn" | "error";
type LogCategory =
  | "proxmox"
  | "payment"
  | "billing"
  | "provision"
  | "vm"
  | "network"
  | "admin"
  | "auth"
  | "system";

type LogEntry = {
  id: string;
  ts: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  userId?: string;
  actorId?: string;
  username?: string;
  orderId?: string;
  vmid?: number;
  node?: string;
  details?: string;
};

type CategoryOption = { id: LogCategory; label: string };

const FALLBACK_CATEGORIES: CategoryOption[] = [
  { id: "proxmox", label: "Proxmox" },
  { id: "payment", label: "Payment" },
  { id: "billing", label: "Billing" },
  { id: "provision", label: "Provision" },
  { id: "vm", label: "VM" },
  { id: "network", label: "Network" },
  { id: "admin", label: "Admin" },
  { id: "auth", label: "Auth" },
  { id: "system", label: "System" },
];

function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function shortKey(pk?: string): string {
  if (!pk) return "—";
  if (pk.length <= 16) return pk;
  return `${pk.slice(0, 8)}…${pk.slice(-6)}`;
}

function levelClass(level: LogLevel): string {
  if (level === "error") return "text-red-400";
  if (level === "warn") return "text-amber-400";
  return "text-[var(--muted)]";
}

export function AdminLogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [categories, setCategories] =
    useState<CategoryOption[]>(FALLBACK_CATEGORIES);
  const [retentionDays, setRetentionDays] = useState(30);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [category, setCategory] = useState("");
  const [user, setUser] = useState("");
  const [level, setLevel] = useState("");
  const [q, setQ] = useState("");
  const [userDraft, setUserDraft] = useState("");
  const [qDraft, setQDraft] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);

  const queryString = useMemo(() => {
    const sp = new URLSearchParams();
    if (category) sp.set("category", category);
    if (user) sp.set("user", user);
    if (level) sp.set("level", level);
    if (q) sp.set("q", q);
    sp.set("limit", "150");
    return sp.toString();
  }, [category, user, level, q]);

  const load = useCallback(
    async (before?: string) => {
      const sp = new URLSearchParams(queryString);
      if (before) sp.set("before", before);
      const res = await apiFetch(`/api/admin/logs?${sp.toString()}`);
      const data = (await res.json().catch(() => ({}))) as {
        entries?: LogEntry[];
        hasMore?: boolean;
        retentionDays?: number;
        categories?: CategoryOption[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    },
    [queryString, reloadNonce]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load()
      .then((data) => {
        if (cancelled) return;
        setEntries(Array.isArray(data.entries) ? data.entries : []);
        setHasMore(Boolean(data.hasMore));
        if (typeof data.retentionDays === "number") {
          setRetentionDays(data.retentionDays);
        }
        if (Array.isArray(data.categories) && data.categories.length) {
          setCategories(data.categories);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setEntries([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  function applyTextFilters(e: React.FormEvent) {
    e.preventDefault();
    setUser(userDraft.trim());
    setQ(qDraft.trim());
  }

  function clearFilters() {
    setCategory("");
    setUser("");
    setLevel("");
    setQ("");
    setUserDraft("");
    setQDraft("");
  }

  async function loadMore() {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    setError(null);
    try {
      const data = await load(last.ts);
      const more = Array.isArray(data.entries) ? data.entries : [];
      const seen = new Set(entries.map((row) => row.id));
      setEntries((prev) => [...prev, ...more.filter((row) => !seen.has(row.id))]);
      setHasMore(Boolean(data.hasMore));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const filtersActive = Boolean(category || user || level || q);

  return (
    <section id="admin-logs" className="scroll-mt-28 mt-16">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Logs</h2>
          <p className="mt-2 max-w-3xl text-sm text-[var(--muted)] leading-relaxed">
            Last {retentionDays} days of server warnings and errors, stored in
            local daily files. Filter by customer (username or public key) and
            failure type.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setUser(userDraft.trim());
            setQ(qDraft.trim());
            setReloadNonce((n) => n + 1);
          }}
          disabled={loading}
          className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-[var(--card)] disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <form
        onSubmit={applyTextFilters}
        className="mt-4 grid gap-3 rounded-xl border border-[var(--card-border)] bg-[var(--card)]/40 p-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <label className="block text-xs text-[var(--muted)]">
          Failure type
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
          >
            <option value="">All types</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-[var(--muted)]">
          User
          <input
            type="text"
            value={userDraft}
            onChange={(e) => setUserDraft(e.target.value)}
            placeholder="Username or public key"
            className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-sm placeholder:font-sans"
            spellCheck={false}
          />
        </label>
        <label className="block text-xs text-[var(--muted)]">
          Level
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
          >
            <option value="">Errors & warnings</option>
            <option value="error">Errors only</option>
            <option value="warn">Warnings only</option>
          </select>
        </label>
        <label className="block text-xs text-[var(--muted)]">
          Search
          <input
            type="search"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Message, order ID, node…"
            className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 text-sm"
          />
        </label>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
          <button
            type="submit"
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)]"
          >
            Apply filters
          </button>
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm hover:bg-[var(--card)]"
            >
              Clear
            </button>
          )}
        </div>
      </form>

      {error ? (
        <p className="mt-3 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 max-h-[36rem] overflow-auto rounded-2xl border border-[var(--card-border)]">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="sticky top-0 z-10 bg-[var(--card)] shadow-[0_1px_0_var(--card-border)]">
            <tr>
              <th className="px-3 py-3 text-left font-medium">Time</th>
              <th className="px-3 py-3 text-left font-medium">Type</th>
              <th className="px-3 py-3 text-left font-medium">Level</th>
              <th className="px-3 py-3 text-left font-medium">User</th>
              <th className="px-3 py-3 text-left font-medium">Order / VM</th>
              <th className="px-3 py-3 text-left font-medium">Message</th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-sm text-[var(--muted)]"
                >
                  Loading logs…
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-sm text-[var(--muted)]"
                >
                  No matching log entries in the last {retentionDays} days.
                </td>
              </tr>
            ) : (
              entries.map((row) => {
                const open = expandedId === row.id;
                const userLabel = row.username
                  ? `@${row.username.replace(/^@/, "")}`
                  : shortKey(row.userId);
                return (
                  <tr
                    key={row.id}
                    className="border-t border-[var(--card-border)] align-top"
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-[var(--muted)]">
                      {fmtTs(row.ts)}
                    </td>
                    <td className="px-3 py-2">
                      <span className="rounded-full border border-[var(--card-border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                        {categories.find((c) => c.id === row.category)?.label ??
                          row.category}
                      </span>
                    </td>
                    <td
                      className={`px-3 py-2 text-xs font-semibold uppercase ${levelClass(row.level)}`}
                    >
                      {row.level}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs" title={row.userId}>
                      {userLabel}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">
                      {row.orderId ? shortKey(row.orderId) : "—"}
                      {row.vmid ? ` · VM ${row.vmid}` : ""}
                      {row.node ? ` · ${row.node}` : ""}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(open ? null : row.id)
                        }
                        className="block max-w-xl text-left text-xs hover:underline"
                      >
                        <span className="line-clamp-2 break-all">
                          {row.message}
                        </span>
                      </button>
                      {open && (
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--card-border)] bg-[var(--background)]/60 p-2 font-mono text-[10px] text-[var(--muted)]">
                          {row.details
                            ? `${row.message}\n\n${row.details}`
                            : row.message}
                          {row.userId ? `\n\nuserId: ${row.userId}` : ""}
                          {row.actorId && row.actorId !== row.userId
                            ? `\nactorId: ${row.actorId}`
                            : ""}
                          {row.orderId ? `\norderId: ${row.orderId}` : ""}
                        </pre>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-[var(--card)] disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load older"}
          </button>
        </div>
      )}
    </section>
  );
}
