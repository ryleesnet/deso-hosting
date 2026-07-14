"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { payWithDeSo, payWithDUSDC } from "@/lib/deso";
import { getDesoPaymentRecipientPublicKey } from "@/lib/payment-public-key";
import {
  MAX_BATCH_RENEWAL_ORDERS,
  MAX_RENEWAL_MONTHS,
  renewBatchMemoFull,
  type RenewBatchItem,
} from "@/lib/renewal-months";
import { apiFetch } from "@/lib/api-client";
import type { PaymentToken } from "@/lib/deso-tokens";

export type BulkRenewOrderOption = {
  orderId: string;
  serviceName: string;
  vmid: number;
  status: string;
  subscriptionStatus: string;
  nextPaymentAt?: string;
};

type BatchQuoteItem = {
  orderId: string;
  serviceName: string;
  months: number;
  totalUsdFormatted: string;
  desoFormatted: string;
  dusdcFormatted: string;
};

type BatchQuote = {
  count: number;
  items: BatchQuoteItem[];
  totalUsdFormatted: string;
  totalAmountNanos: number;
  totalUsdCents: number;
  totalDesoFormatted: string;
  totalDusdcFormatted: string;
  usdPerDeso: number;
  rateSource: string;
  memoFull: string;
  maxBatchOrders: number;
};

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatNextPaymentShort(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export function BulkRenewPanel(props: {
  orders: BulkRenewOrderOption[];
  onSuccess: () => void;
}) {
  const { orders, onSuccess } = props;
  const payee = getDesoPaymentRecipientPublicKey();

  const eligibleOrders = useMemo(
    () =>
      orders
        .filter(
          (o) =>
            (o.status === "active" || o.status === "suspended") &&
            o.vmid > 0 &&
            (o.subscriptionStatus === "active" ||
              o.subscriptionStatus === "past_due")
        )
        .sort((a, b) => {
          // Show past_due first, then by nextPaymentAt asc.
          const pastDueA = a.subscriptionStatus === "past_due" ? 0 : 1;
          const pastDueB = b.subscriptionStatus === "past_due" ? 0 : 1;
          if (pastDueA !== pastDueB) return pastDueA - pastDueB;
          const ta = a.nextPaymentAt ? Date.parse(a.nextPaymentAt) : Infinity;
          const tb = b.nextPaymentAt ? Date.parse(b.nextPaymentAt) : Infinity;
          return ta - tb;
        }),
    [orders]
  );

  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState<number>(1);
  const [paymentToken, setPaymentToken] = useState<PaymentToken>("DESO");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [quote, setQuote] = useState<BatchQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [vmNames, setVmNames] = useState<Record<string, string>>({});

  useEffect(() => {
    // Prune stale selections when the orders list changes (e.g. after payment).
    setSelected((prev) => {
      const eligibleIds = new Set(eligibleOrders.map((o) => o.orderId));
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, v] of Object.entries(prev)) {
        if (eligibleIds.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [eligibleOrders]);

  // Lazily fetch the Proxmox display name for each eligible VM the first time
  // the panel opens, so the list matches what the user sees on the individual
  // dashboard cards.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const missing = eligibleOrders.filter(
      (o) => o.vmid > 0 && vmNames[o.orderId] === undefined
    );
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (o) => {
        try {
          const res = await apiFetch(`/api/vm/${o.orderId}/status`);
          const data = (await res.json()) as { name?: unknown };
          if (!res.ok) return { orderId: o.orderId, name: "" };
          const raw = data.name;
          const n = typeof raw === "string" ? raw.trim() : "";
          return { orderId: o.orderId, name: n };
        } catch {
          return { orderId: o.orderId, name: "" };
        }
      })
    ).then((results) => {
      if (cancelled) return;
      setVmNames((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.orderId] = r.name;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, eligibleOrders, vmNames]);

  const selectedIds = useMemo(
    () => eligibleOrders.filter((o) => selected[o.orderId]).map((o) => o.orderId),
    [eligibleOrders, selected]
  );

  const items: RenewBatchItem[] = useMemo(
    () => selectedIds.map((orderId) => ({ orderId, months })),
    [selectedIds, months]
  );

  const loadQuote = useCallback(async () => {
    if (items.length === 0) {
      setQuote(null);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const url = `/api/pricing/renew-batch-quote?months=${months}&orderIds=${encodeURIComponent(
        selectedIds.join(",")
      )}`;
      const res = await apiFetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Quote failed");
      setQuote(data as BatchQuote);
    } catch (e) {
      setQuote(null);
      setError(e instanceof Error ? e.message : "Could not load batch quote");
    } finally {
      setLoading(false);
    }
  }, [items.length, months, selectedIds]);

  useEffect(() => {
    if (!open) return;
    void loadQuote();
  }, [open, loadQuote]);

  const toggleAll = (checked: boolean) => {
    if (checked) {
      const next: Record<string, boolean> = {};
      let count = 0;
      for (const o of eligibleOrders) {
        if (count >= MAX_BATCH_RENEWAL_ORDERS) break;
        next[o.orderId] = true;
        count += 1;
      }
      setSelected(next);
    } else {
      setSelected({});
    }
  };

  const allSelected =
    eligibleOrders.length > 0 &&
    eligibleOrders
      .slice(0, MAX_BATCH_RENEWAL_ORDERS)
      .every((o) => selected[o.orderId]);
  const someSelected = selectedIds.length > 0;
  const overCap = selectedIds.length > MAX_BATCH_RENEWAL_ORDERS;

  async function handlePay() {
    if (!payee) {
      setError("Payment recipient not configured (NEXT_PUBLIC_DESO_PAYMENT_PUBLIC_KEY).");
      return;
    }
    if (items.length === 0) return;
    if (overCap) {
      setError(`Please select at most ${MAX_BATCH_RENEWAL_ORDERS} servers per batch.`);
      return;
    }

    setPaying(true);
    setError(null);
    setSuccess(null);

    let refreshed: BatchQuote;
    try {
      const url = `/api/pricing/renew-batch-quote?months=${months}&orderIds=${encodeURIComponent(
        selectedIds.join(",")
      )}`;
      const res = await apiFetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Quote failed");
      refreshed = data as BatchQuote;
      setQuote(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh quote");
      setPaying(false);
      return;
    }

    const memo = refreshed.memoFull || renewBatchMemoFull(items);

    try {
      const paymentResult =
        paymentToken === "DUSDC"
          ? await payWithDUSDC(payee, refreshed.totalUsdCents, memo)
          : await payWithDeSo(payee, refreshed.totalAmountNanos, memo);
      const txHash =
        (
          paymentResult as {
            submittedTransactionResponse?: { TxnHashHex?: string };
          }
        )?.submittedTransactionResponse?.TxnHashHex;
      if (!txHash) {
        throw new Error("No transaction hash returned from wallet");
      }
      const renewRes = await apiFetch("/api/billing/renew-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((i) => ({ orderId: i.orderId, months: i.months })),
          txHash,
          paymentToken,
        }),
      });
      const renewData = await renewRes.json();
      if (!renewRes.ok) throw new Error(renewData.error || "Batch renewal failed");
      setSuccess(
        `Renewed ${renewData.count ?? items.length} server${
          (renewData.count ?? items.length) === 1 ? "" : "s"
        } in one transaction.`
      );
      setSelected({});
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setPaying(false);
    }
  }

  if (!payee || eligibleOrders.length < 2) {
    // Nothing to bulk-pay if only one server is renewable — the per-VM panel
    // already covers that flow.
    return null;
  }

  return (
    <section
      aria-labelledby="bulk-renew-title"
      className="mt-6 rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="bulk-renew-title"
            className="text-sm font-semibold tracking-tight sm:text-base"
          >
            Renew multiple servers in one transaction
          </h2>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Pick the servers, choose how many months, and pay for all of them
            with a single wallet approval.
          </p>
        </div>
        {!open ? (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setError(null);
              setSuccess(null);
            }}
            className="rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 px-3 py-1.5 text-xs font-medium hover:border-[var(--accent)]/45 hover:bg-[var(--card)] hover:text-[var(--accent)] sm:text-sm"
          >
            Open bulk renewal
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
            className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            Close
          </button>
        )}
      </div>

      {success ? (
        <p className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
          {success}
        </p>
      ) : null}

      {!open ? null : (
        <div className="mt-4 space-y-4">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-[var(--muted)]">
                Servers to renew ({selectedIds.length} / {Math.min(eligibleOrders.length, MAX_BATCH_RENEWAL_ORDERS)})
              </p>
              <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  disabled={paying}
                />
                Select all
              </label>
            </div>
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 p-2">
              {eligibleOrders.map((o) => {
                const disabled =
                  paying ||
                  (!selected[o.orderId] &&
                    selectedIds.length >= MAX_BATCH_RENEWAL_ORDERS);
                const cachedName = vmNames[o.orderId];
                const vmLabel =
                  cachedName && cachedName.length > 0
                    ? cachedName
                    : cachedName === undefined
                      ? "Loading…"
                      : `VPS - ${shortId(o.orderId)}`;
                return (
                  <li key={o.orderId}>
                    <label
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs sm:text-sm ${
                        disabled ? "opacity-60" : "hover:bg-[var(--card)]/50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                        checked={!!selected[o.orderId]}
                        disabled={disabled}
                        onChange={(e) =>
                          setSelected((prev) => ({
                            ...prev,
                            [o.orderId]: e.target.checked,
                          }))
                        }
                      />
                      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                        <span className="truncate font-medium text-[var(--foreground)]">
                          {vmLabel}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">
                          {o.serviceName}
                        </span>
                        {o.subscriptionStatus === "past_due" ? (
                          <span className="rounded-full border border-orange-500/40 bg-orange-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-orange-200">
                            Past due
                          </span>
                        ) : null}
                        {o.status === "suspended" ? (
                          <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-100">
                            Suspended
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-[var(--muted)]">
                        Next: {formatNextPaymentShort(o.nextPaymentAt)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {overCap ? (
              <p className="mt-2 text-xs text-red-400">
                Maximum {MAX_BATCH_RENEWAL_ORDERS} servers per batch. Please
                deselect some to continue.
              </p>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-[var(--muted)]">
                Months to pay (applies to all selected)
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Array.from({ length: MAX_RENEWAL_MONTHS }, (_, i) => i + 1).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={paying}
                    onClick={() => setMonths(m)}
                    className={
                      months === m
                        ? "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)]"
                        : "rounded-lg border border-[var(--card-border)] bg-[var(--background)]/30 px-3 py-1.5 text-sm hover:bg-[var(--card)] disabled:opacity-50"
                    }
                  >
                    {m} {m === 1 ? "month" : "months"}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-[var(--muted)]">Pay with</p>
              <div
                className="mt-2 flex flex-wrap gap-2"
                role="radiogroup"
                aria-label="Payment token"
              >
                {(
                  [
                    { id: "DESO" as const, label: "DESO" },
                    { id: "DUSDC" as const, label: "dUSDC" },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    role="radio"
                    aria-checked={paymentToken === opt.id}
                    disabled={paying}
                    onClick={() => setPaymentToken(opt.id)}
                    className={
                      paymentToken === opt.id
                        ? "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)]"
                        : "rounded-lg border border-[var(--card-border)] bg-[var(--background)]/30 px-3 py-1.5 text-sm hover:bg-[var(--card)] disabled:opacity-50"
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-[var(--muted)]">Loading quote…</p>
          ) : null}
          {error ? <p className="text-sm text-red-400">{error}</p> : null}

          {quote && !loading ? (
            <div className="rounded-xl border border-[var(--card-border)] bg-[var(--background)]/40 p-3">
              <p className="text-xs font-medium text-[var(--muted)]">
                Batch summary ({quote.count} server{quote.count === 1 ? "" : "s"})
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {quote.items.map((row) => {
                  const cachedName = vmNames[row.orderId];
                  const vmLabel =
                    cachedName && cachedName.length > 0
                      ? cachedName
                      : cachedName === undefined
                        ? "Loading…"
                        : `VPS - ${shortId(row.orderId)}`;
                  return (
                    <li key={row.orderId} className="flex justify-between gap-4">
                      <span className="min-w-0 truncate text-[var(--foreground)]">
                        {vmLabel}{" "}
                        <span className="text-[var(--muted)]">
                          · {row.serviceName} ·{" "}
                          {row.months} {row.months === 1 ? "mo" : "mos"}
                        </span>
                      </span>
                      <span className="tabular-nums text-[var(--muted)]">
                        {row.totalUsdFormatted}
                        {paymentToken === "DESO"
                          ? ` · ${row.desoFormatted} DESO`
                          : ` · ${row.dusdcFormatted}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <dl className="mt-3 space-y-1 border-t border-[var(--card-border)] pt-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--muted)]">Total USD</dt>
                  <dd className="font-semibold tabular-nums">
                    {quote.totalUsdFormatted}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--muted)]">
                    Total {paymentToken === "DUSDC" ? "dUSDC" : "DESO"}
                  </dt>
                  <dd className="font-semibold tabular-nums text-[var(--accent)]">
                    {paymentToken === "DUSDC"
                      ? quote.totalDusdcFormatted
                      : `${quote.totalDesoFormatted} DESO`}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {paymentToken === "DUSDC"
                  ? "Fixed peg: 1 dUSDC = $1 (wrapped USDC on DeSo)."
                  : `~$${quote.usdPerDeso.toFixed(4)} / DESO${
                      quote.rateSource === "env" ? " (DESO_USD_PRICE)" : " (node)"
                    }`}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={paying || !someSelected || overCap || !!error && !quote}
              onClick={() => void handlePay()}
              className="flex-1 rounded-lg bg-[var(--accent)] py-2.5 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
            >
              {paying
                ? "Processing…"
                : paymentToken === "DUSDC"
                  ? `Pay for ${selectedIds.length || 0} server${
                      selectedIds.length === 1 ? "" : "s"
                    } with dUSDC`
                  : `Pay for ${selectedIds.length || 0} server${
                      selectedIds.length === 1 ? "" : "s"
                    } with DESO`}
            </button>
            <button
              type="button"
              className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-xs text-[var(--muted)] hover:bg-[var(--background)] disabled:opacity-50"
              onClick={() => void loadQuote()}
              disabled={loading || paying || !someSelected}
            >
              Refresh quote
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
