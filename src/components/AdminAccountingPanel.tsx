"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { formatUsdCents } from "@/lib/pricing";

type AccountingKind = "order" | "renewal" | "manual";

type AccountingEntry = {
  id: string;
  kind: AccountingKind;
  paidAt: string;
  orderId: string;
  userId: string;
  username?: string;
  vmid?: number;
  node?: string;
  publicIpv4?: string;
  vmDisplayName?: string;
  serviceName?: string;
  orderStatus?: string;
  rail: string;
  months: number;
  usdCents?: number;
  reference?: string;
  enteredAt?: string;
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function shortKey(pk: string): string {
  if (pk.length <= 16) return pk;
  return `${pk.slice(0, 8)}…${pk.slice(-6)}`;
}

function kindLabel(entry: AccountingEntry): string {
  const months =
    entry.months > 1 ? `${entry.months} months` : "1 month";
  if (entry.kind === "order") return `New order · ${months}`;
  if (entry.kind === "manual") return `Manual payment · ${months}`;
  return `Renewal · ${months}`;
}

export function AdminAccountingPanel() {
  const [entries, setEntries] = useState<AccountingEntry[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qDraft, setQDraft] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"" | AccountingKind>("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    const sp = new URLSearchParams();
    if (query) sp.set("q", query);
    const res = await apiFetch(`/api/admin/accounting?${sp.toString()}`);
    const data = (await res.json().catch(() => ({}))) as {
      entries?: AccountingEntry[];
      openCount?: number;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load(q)
      .then((data) => {
        if (cancelled) return;
        setEntries(Array.isArray(data.entries) ? data.entries : []);
        setOpenCount(typeof data.openCount === "number" ? data.openCount : 0);
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
  }, [load, q]);

  const visible = kind ? entries.filter((e) => e.kind === kind) : entries;

  async function mark(entry: AccountingEntry, entered: boolean) {
    setBusyId(entry.id);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/accounting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, entered }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const next = await load(q);
      setEntries(Array.isArray(next.entries) ? next.entries : []);
      setOpenCount(typeof next.openCount === "number" ? next.openCount : 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section id="admin-accounting" className="scroll-mt-28 mt-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Akaunting</h2>
          <p className="mt-2 max-w-3xl text-sm text-[var(--muted)] leading-relaxed">
            Payments waiting to be entered in Akaunting. Mark one complete and it
            leaves this list. Search still finds entered payments by customer,
            order, VM, IP, or transaction.
          </p>
        </div>
        <p className="text-sm text-[var(--muted)]">
          <span className="font-medium text-[var(--foreground)]">{openCount}</span>{" "}
          to enter
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(qDraft.trim());
        }}
        className="mt-4 flex flex-wrap items-end gap-3"
      >
        <label className="block min-w-[16rem] flex-1 text-xs text-[var(--muted)]">
          Search
          <input
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Username, order, VMID, IP, or tx"
            className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          />
        </label>
        <label className="block text-xs text-[var(--muted)]">
          Type
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "" | AccountingKind)}
            className="mt-1 rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          >
            <option value="">All</option>
            <option value="order">New orders</option>
            <option value="renewal">Renewals</option>
            <option value="manual">Manual payments</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm hover:bg-[var(--card)]"
        >
          Search
        </button>
        {q ? (
          <button
            type="button"
            onClick={() => {
              setQDraft("");
              setQ("");
            }}
            className="rounded-lg px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Clear
          </button>
        ) : null}
      </form>

      {q ? (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Search includes payments already marked entered.
        </p>
      ) : (
        <p className="mt-2 text-xs text-[var(--muted)]">
          New-order amounts are one month at the current plan price (PayPal orders
          use the monthly amount captured at signup).
        </p>
      )}

      {error ? (
        <p className="mt-3 text-sm text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--card-border)]">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-[var(--card-border)] text-xs text-[var(--muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">Paid</th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Payment</th>
              <th className="px-3 py-2 font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Order</th>
              <th className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[var(--muted)]">
                  Loading payments…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[var(--muted)]">
                  {q
                    ? "No payments match that search."
                    : "Nothing waiting to enter in Akaunting."}
                </td>
              </tr>
            ) : (
              visible.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-t border-[var(--card-border)] align-top"
                >
                  <td className="px-3 py-3 whitespace-nowrap text-xs">
                    {fmtDate(entry.paidAt)}
                  </td>
                  <td className="px-3 py-3">
                    <div>{entry.username ? `@${entry.username}` : shortKey(entry.userId)}</div>
                    {entry.username ? (
                      <div className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">
                        {shortKey(entry.userId)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3">
                    <div>{kindLabel(entry)}</div>
                    <div className="mt-0.5 text-xs text-[var(--muted)]">
                      {entry.rail}
                      {entry.serviceName ? ` · ${entry.serviceName}` : ""}
                    </div>
                    {entry.reference ? (
                      <div className="mt-0.5 max-w-[14rem] truncate font-mono text-[10px] text-[var(--muted)]">
                        {entry.reference}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    {typeof entry.usdCents === "number"
                      ? formatUsdCents(entry.usdCents)
                      : "—"}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    <div className="font-mono">{entry.orderId.slice(0, 8)}</div>
                    <div className="mt-0.5 text-[var(--muted)]">
                      {entry.vmid ? `VM ${entry.vmid}` : "No VM"}
                      {entry.publicIpv4 ? ` · ${entry.publicIpv4}` : ""}
                      {entry.orderStatus ? ` · ${entry.orderStatus}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    {entry.enteredAt ? (
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-xs text-green-400">
                          Entered {fmtDate(entry.enteredAt)}
                        </span>
                        <button
                          type="button"
                          disabled={busyId === entry.id}
                          onClick={() => void mark(entry, false)}
                          className="text-xs text-[var(--muted)] underline hover:text-[var(--foreground)] disabled:opacity-50"
                        >
                          {busyId === entry.id ? "Saving…" : "Undo"}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === entry.id}
                        onClick={() => void mark(entry, true)}
                        className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
                      >
                        {busyId === entry.id ? "Saving…" : "Mark entered"}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
