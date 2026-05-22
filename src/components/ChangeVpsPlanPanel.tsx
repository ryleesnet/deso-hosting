"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type CatalogService = {
  id: string;
  name: string;
  vcpu: number;
  ram: number;
  storage: number;
  priceUsdCents?: number;
};

type Props = {
  orderId: string;
  currentServiceId: string;
  servicesById: Record<string, CatalogService>;
  adjustingPlan?: boolean;
  hardwareMaintenance?: boolean;
  disabled?: boolean;
  onScheduled?: () => void;
  /** Shown when the server reported a failure (e.g. last plan change). */
  lastError?: string | null;
  /** Nested inside another card — top border instead of full frame. */
  embedded?: boolean;
};

function fmtPriceUsd(monthlyCents: number | undefined): string {
  if (monthlyCents == null || !Number.isFinite(monthlyCents)) return "";
  const dollars = monthlyCents / 100;
  return dollars.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtRamMb(ramMb: number): string {
  if (!Number.isFinite(ramMb) || ramMb <= 0) return "—";
  if (ramMb % 1024 === 0) return `${Math.round(ramMb / 1024)} GB`;
  return `${ramMb} MB`;
}

/** Dashboard: pick another catalogue plan; server stops the VM, resizes hardware, optionally restarts. */
export function ChangeVpsPlanPanel({
  orderId,
  currentServiceId,
  servicesById,
  adjustingPlan = false,
  hardwareMaintenance = false,
  disabled = false,
  onScheduled,
  lastError,
  embedded = false,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alternates = useMemo(() => {
    return Object.values(servicesById)
      .filter((s) => s.id && s.id !== currentServiceId)
      .slice()
      .sort((a, b) => (a.priceUsdCents ?? 0) - (b.priceUsdCents ?? 0));
  }, [servicesById, currentServiceId]);

  const [selectedId, setSelectedId] = useState("");
  useEffect(() => {
    const first = alternates[0]?.id ?? "";
    setSelectedId((prev) =>
      prev && alternates.some((s) => s.id === prev) ? prev : first
    );
  }, [alternates]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClose = () => {
      setBusy(false);
      setError(null);
    };
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  async function confirmChange() {
    if (!selectedId.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch(`/api/orders/${orderId}/change-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetServiceId: selectedId }),
      });
      const data = (await res.json()) as {
        error?: string;
        message?: string;
        success?: boolean;
      };
      if (!res.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      dialogRef.current?.close();
      onScheduled?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan change failed to start");
    } finally {
      setBusy(false);
    }
  }

  const picked = alternates.find((s) => s.id === selectedId);
  const current = servicesById[currentServiceId];
  const blockUi = adjustingPlan || hardwareMaintenance || disabled || busy;

  if (alternates.length === 0) {
    return null;
  }

  const shell =
    embedded
      ? "mt-4 border-t border-[var(--card-border)] pt-4"
      : "mt-5 rounded-xl border border-[var(--card-border)] bg-[var(--background)]/40 p-4";

  return (
    <div className={shell}>
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
        Change plan
      </h4>
      {!embedded ? (
        <p className="mt-2 text-sm text-[var(--muted)] leading-snug">
          Move this VPS between plans for CPU, memory, and root disk sizing. Monthly price updates on
          the next subscription cycle calculation (extras such as extra data disks are kept).
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-[var(--muted)] leading-snug">
          Choose another tier — the guest stops briefly during resize.
        </p>
      )}
      {hardwareMaintenance && !adjustingPlan ? (
        <p className="mt-2 text-xs text-orange-400/95" role="status">
          Extra disk attach/remove running — finish that before changing plans.
        </p>
      ) : null}
      {adjustingPlan ? (
        <p
          className="mt-2 text-sm font-medium text-orange-400"
          role="status"
          aria-live="polite"
        >
          Plan change running — shutting down or resizing… this list refreshes shortly.
        </p>
      ) : null}

      {!adjustingPlan && !hardwareMaintenance && current ? (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Current:{" "}
          <span className="font-medium text-[var(--foreground)]">{current.name}</span> —{" "}
          {current.vcpu} vCPU · {fmtRamMb(current.ram)} · {current.storage}
          GB disk
          {current.priceUsdCents != null
            ? ` · ${fmtPriceUsd(current.priceUsdCents)}/mo`
            : ""}
        </p>
      ) : null}

      {lastError?.trim() && !adjustingPlan && !hardwareMaintenance ? (
        <p className="mt-2 rounded-md border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {lastError.trim()}
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          className="max-w-full min-w-0 flex-1 rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-3 py-2 text-sm"
          value={selectedId}
          onChange={(ev) => setSelectedId(ev.target.value)}
          disabled={blockUi}
          aria-label="Target plan"
        >
          {alternates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.vcpu} vCPU · {fmtRamMb(s.ram)} · {s.storage} GB
              {s.priceUsdCents != null ? ` · ${fmtPriceUsd(s.priceUsdCents)}/mo` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={blockUi || !selectedId}
          onClick={() => dialogRef.current?.showModal()}
          className="rounded-lg border border-[var(--accent-muted)] bg-[var(--accent)]/15 px-3 py-2 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50 sm:shrink-0"
        >
          Change…
        </button>
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby="change-plan-title"
        aria-describedby="change-plan-desc"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <p id="change-plan-title" className="text-lg font-semibold text-[var(--accent)]">
            Change VPS plan?
          </p>
          <p id="change-plan-desc" className="text-sm text-[var(--muted)] leading-relaxed">
            The VPS will receive an orderly shutdown signal and may remain off for roughly one to three
            minutes while the hypervisor adjusts CPU, memory, and the root disk. If shutdown stalls, a
            forced stop may be used. You can close this dialog after confirming —{" "}
            <span className="font-medium text-[var(--foreground)]">the dashboard will update</span>{" "}
            when the resize finishes (this page polls while a plan change runs).
          </p>
          {picked ? (
            <div className="rounded-lg border border-[var(--card-border)] bg-[var(--background)]/50 p-3 text-sm">
              <p className="font-medium">{picked.name}</p>
              <p className="mt-1 text-[var(--muted)]">
                {picked.vcpu} vCPU · {fmtRamMb(picked.ram)} · {picked.storage}
                GB disk
                {picked.priceUsdCents != null
                  ? ` · ${fmtPriceUsd(picked.priceUsdCents)}/mo`
                  : ""}
              </p>
            </div>
          ) : null}
          {error ? (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => dialogRef.current?.close()}
              className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--background)]/60 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !picked}
              onClick={() => void confirmChange()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
            >
              {busy ? "Starting…" : "Confirm plan change"}
            </button>
          </div>
        </div>
      </dialog>

      {current == null ? (
        <p className="mt-2 text-xs text-amber-400">
          Catalogue entry for your current plan is missing from this browser session — reload the page.
        </p>
      ) : null}
    </div>
  );
}
