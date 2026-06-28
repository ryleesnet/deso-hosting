"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  extraDisksAddonUsdCents,
  extraDisksProvisionedGbTotal,
  extraDiskTierMenuLabel,
} from "@/lib/extra-disk-pricing";
import {
  EXTRA_DISK_TIER_SIZES_GB,
  labelExtraDiskTierGb,
} from "@/lib/extra-disks";

function formatUsdCents(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type Limits = {
  maxCount: number;
  maxGbEach: number;
  tierSizesGb?: number[];
};

type Props = {
  orderId: string;
  /** Firestore `extraDisksGb` (sizes in GB); order matches disks after the OS disk. */
  extraDisksGb?: number[];
  adjustingPlan?: boolean;
  hardwareMaintenance?: boolean;
  backupRestoreInProgress?: boolean;
  disabled?: boolean;
  onScheduled?: () => void;
};

/**
 * Add/remove extra data disks (same billing model as checkout).
 * Removal is destructive — modal copy warns data is permanently lost.
 */
export function ExtraDataDisksPanel({
  orderId,
  extraDisksGb = [],
  adjustingPlan = false,
  hardwareMaintenance = false,
  backupRestoreInProgress = false,
  disabled = false,
  onScheduled,
}: Props) {
  const limitsRef = useRef<Limits>({ maxCount: 8, maxGbEach: 2048 });
  const [limits, setLimits] = useState<Limits>(limitsRef.current);
  const [selectedAddTierGb, setSelectedAddTierGb] = useState<number>(
    EXTRA_DISK_TIER_SIZES_GB[0]!
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addDialogRef = useRef<HTMLDialogElement>(null);
  const removeDialogRef = useRef<HTMLDialogElement>(null);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  const [removeAckDanger, setRemoveAckDanger] = useState(false);
  const [removeAckBilling, setRemoveAckBilling] = useState(false);

  useEffect(() => {
    void fetch("/api/extra-disk-limits")
      .then((r) => r.json())
      .then((d: Limits & { error?: string }) => {
        if (
          d &&
          typeof d.maxCount === "number" &&
          typeof d.maxGbEach === "number"
        ) {
          const next: Limits = {
            ...d,
            tierSizesGb: Array.isArray(d.tierSizesGb)
              ? d.tierSizesGb.filter(
                  (x): x is number => typeof x === "number"
                )
              : undefined,
          };
          limitsRef.current = next;
          setLimits(next);
        }
      })
      .catch(() => {});
  }, []);

  const hardwareBusy =
    adjustingPlan || hardwareMaintenance || backupRestoreInProgress;
  const blockUi = disabled || busy || hardwareBusy;

  const tierOptions = useMemo(() => {
    const t = limits.tierSizesGb?.length ? limits.tierSizesGb : undefined;
    const list = t ?? [...EXTRA_DISK_TIER_SIZES_GB];
    return [...list].sort((a, b) => a - b);
  }, [limits.tierSizesGb]);

  useEffect(() => {
    if (tierOptions.length > 0 && !tierOptions.includes(selectedAddTierGb)) {
      setSelectedAddTierGb(tierOptions[0]!);
    }
  }, [tierOptions, selectedAddTierGb]);

  const currentAddonCents = useMemo(
    () => extraDisksAddonUsdCents(extraDisksGb),
    [extraDisksGb]
  );

  const projectedAddon = useMemo(() => {
    const next = [...extraDisksGb, selectedAddTierGb];
    return extraDisksAddonUsdCents(next);
  }, [selectedAddTierGb, extraDisksGb]);

  async function submitAdd() {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch(`/api/orders/${orderId}/extra-disks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", sizeGb: selectedAddTierGb }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      addDialogRef.current?.close();
      onScheduled?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start add");
    } finally {
      setBusy(false);
    }
  }

  async function submitRemove(idx: number) {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch(`/api/orders/${orderId}/extra-disks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", diskIndex: idx }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      removeDialogRef.current?.close();
      setRemoveIndex(null);
      setRemoveAckDanger(false);
      setRemoveAckBilling(false);
      onScheduled?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start removal");
    } finally {
      setBusy(false);
    }
  }

  const gbTotalExtra = extraDisksProvisionedGbTotal(extraDisksGb);

  return (
    <div className="mt-4 border-t border-[var(--card-border)] pt-4">
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
        Extra data disks
      </h4>
      <p className="mt-1.5 text-xs text-[var(--muted)] leading-relaxed">
        Add-on volumes on the same storage as your plan disk. The guest shuts down briefly while the
        host attaches or removes a volume. Sizes in the menu show this disk&apos;s monthly USD add-on.
      </p>
      {hardwareBusy ? (
        <p
          className="mt-2 text-xs font-medium text-orange-400"
          role="status"
          aria-live="polite"
        >
          {backupRestoreInProgress
            ? "Backup restore running — server may be off briefly."
            : hardwareMaintenance
              ? "Disk operation running — server may be off briefly."
              : "Finish plan change before editing disks."}
        </p>
      ) : null}

      <ul className="mt-3 space-y-2 text-sm" role="list">
        {extraDisksGb.map((gb, i) => (
          <li
            key={`extra-disk-${i}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--card-border)] bg-[var(--background)]/30 px-3 py-2"
          >
            <span>
              Data volume #{i + 1}{" "}
              <span className="font-medium text-[var(--foreground)]">
                ({labelExtraDiskTierGb(Math.round(gb))})
              </span>
            </span>
            <button
              type="button"
              disabled={blockUi}
              className="shrink-0 rounded-md border border-red-500/50 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50"
              onClick={() => {
                setRemoveIndex(i);
                setRemoveAckDanger(false);
                setRemoveAckBilling(false);
                setError(null);
                removeDialogRef.current?.showModal();
              }}
            >
              Remove…
            </button>
          </li>
        ))}
        {extraDisksGb.length === 0 ? (
          <li className="text-xs text-[var(--muted)]">No extra disks yet.</li>
        ) : null}
      </ul>

      {extraDisksGb.length > 0 ? (
        <p className="mt-2 text-[11px] text-[var(--muted)]">
          Current extra add-on ≈{" "}
          <span className="font-medium text-[var(--foreground)]">
            {formatUsdCents(currentAddonCents)}
          </span>
          /mo · {gbTotalExtra} GB extra total
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem]">
          <label
            htmlFor={`extra-disk-tier-${orderId}`}
            className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]"
          >
            Size
          </label>
          <select
            id={`extra-disk-tier-${orderId}`}
            value={selectedAddTierGb}
            onChange={(e) =>
              setSelectedAddTierGb(Number(e.target.value))
            }
            disabled={blockUi || tierOptions.length === 0}
            className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-2 py-1.5 text-sm"
          >
            {tierOptions.map((gb) => (
              <option key={gb} value={gb}>
                {extraDiskTierMenuLabel(gb)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={blockUi || extraDisksGb.length >= limits.maxCount}
          onClick={() => {
            setError(null);
            addDialogRef.current?.showModal();
          }}
          className="rounded-lg border border-[var(--accent-muted)] bg-[var(--accent)]/15 px-3 py-2 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:opacity-50"
        >
          Add disk…
        </button>
      </div>
      <p className="mt-2 text-[11px] text-[var(--muted)]">
        Up to {limits.maxCount} extra disks.
      </p>
      {error ? (
        <p className="mt-2 rounded-md border border-red-500/35 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
          {error}
        </p>
      ) : null}

      <dialog
        ref={addDialogRef}
        aria-labelledby="add-disk-title"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-5 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <p
          id="add-disk-title"
          className="text-lg font-semibold text-[var(--accent)]"
        >
          Add extra disk?
        </p>
        <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">
          The VPS will shut down briefly while Proxmox creates and attaches{" "}
          <span className="font-medium text-[var(--foreground)]">
            ~{labelExtraDiskTierGb(selectedAddTierGb)}
          </span>{" "}
          of new storage on your plan&apos;s volume group. Afterwards you must partition, format,
          and mount it in Linux if it is blank.
        </p>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Monthly add-on after this disk (estimate):{" "}
          <span className="font-medium text-[var(--foreground)]">
            {formatUsdCents(projectedAddon)}
          </span>
          /mo (USD; DeSo renewal uses the quoted rate later).
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => addDialogRef.current?.close()}
            className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-[var(--background)]/60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitAdd()}
            className="rounded-lg bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
          >
            {busy ? "Starting…" : "Confirm"}
          </button>
        </div>
      </dialog>

      <dialog
        ref={removeDialogRef}
        aria-labelledby="remove-disk-title"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-red-500/30 bg-[var(--card)] p-5 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <p
          id="remove-disk-title"
          className="text-lg font-semibold text-red-400"
        >
          Remove disk permanently?
        </p>
        {removeIndex != null ? (
          <p className="mt-3 text-sm font-medium">
            Volume #{removeIndex + 1} (~
            {labelExtraDiskTierGb(Math.round(extraDisksGb[removeIndex]!))})
          </p>
        ) : null}
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--muted)]">
          <li className="text-red-300/95">
            <span className="font-semibold text-red-400">Everything on this disk</span> is deleted
            when the volume is detached.{" "}
            <span className="font-semibold text-red-400">
              There is no recovery or undo — the data will be gone permanently.
            </span>
          </li>
          <li>Unmount and back up anything you need before confirming.</li>
          <li className="text-[var(--foreground)]/90">
            Your recurring price drops when extras shrink (same prorated rule as checkout).
          </li>
        </ul>

        <div className="mt-4 flex flex-col gap-3 border-t border-[var(--card-border)] pt-4">
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeAckDanger}
              onChange={(e) => setRemoveAckDanger(e.target.checked)}
              className="mt-1"
            />
            <span>
              I understand that{" "}
              <strong className="text-red-400">this volume and all of its contents</strong> will be lost
               forever — <strong className="text-red-400">not recoverable</strong> via this hosting
              portal.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={removeAckBilling}
              onChange={(e) => setRemoveAckBilling(e.target.checked)}
              className="mt-1"
            />
            <span>
              I am removing{" "}
              <strong className="text-[var(--foreground)]">
                data volume #{removeIndex != null ? removeIndex + 1 : "—"}
              </strong>{" "}
              on purpose.
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => removeDialogRef.current?.close()}
            className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-[var(--background)]/60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              busy ||
              removeIndex == null ||
              !removeAckDanger ||
              !removeAckBilling
            }
            onClick={() =>
              removeIndex != null ? void submitRemove(removeIndex) : undefined
            }
            className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-45"
          >
            {busy ? "Removing…" : "Remove disk forever"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
