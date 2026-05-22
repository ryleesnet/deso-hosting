"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

/** Matches server `imageProfiles`; avoid importing firebase-bound modules in the client bundle. */
export type ClientImageProfile = {
  id: string;
  label: string;
  templateVmid: number;
};

type Props = {
  orderId: string;
  /** From catalogue service */
  profiles: ClientImageProfile[];
  /** Stored `cloneImageProfileId` on order (preferred default for picker). */
  orderProfileId?: string;
  /** Stored `cloneTemplateVmid` */
  orderTemplateVmid?: number;
  onStarted?: () => void;
  disabled?: boolean;
  /** When true, button fills a grid cell (paired with Delete on the dashboard). */
  fillCell?: boolean;
};

/**
 * Reinstall confirmation — optionally pick clone source when profiles &gt; 1.
 */
export function ReinstallVpsButton({
  orderId,
  profiles,
  orderProfileId,
  orderTemplateVmid,
  onStarted,
  disabled,
  fillCell,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultProfileId = useMemo(() => {
    if (!profiles.length) return "";
    if (orderProfileId) {
      const hit = profiles.find((p) => p.id === orderProfileId);
      if (hit) return hit.id;
    }
    if (typeof orderTemplateVmid === "number" && orderTemplateVmid > 0) {
      const hit = profiles.find((p) => p.templateVmid === orderTemplateVmid);
      if (hit) return hit.id;
    }
    return profiles[0]!.id;
  }, [profiles, orderProfileId, orderTemplateVmid]);

  const [selectedProfileId, setSelectedProfileId] = useState(defaultProfileId);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onCloseEvt = () => {
      setBusy(false);
      setError(null);
    };
    el.addEventListener("close", onCloseEvt);
    return () => el.removeEventListener("close", onCloseEvt);
  }, []);

  useEffect(() => {
    setSelectedProfileId(defaultProfileId);
  }, [defaultProfileId]);

  async function handleConfirm() {
    setError(null);
    setBusy(true);
    try {
      const body =
        profiles.length > 1
          ? { imageProfileId: selectedProfileId }
          : profiles.length === 1
            ? { imageProfileId: profiles[0]!.id }
            : {};
      const res = await apiFetch(`/api/orders/${orderId}/reinstall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      dialogRef.current?.close();
      onStarted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reinstall failed to start");
    } finally {
      setBusy(false);
    }
  }

  const showPick = profiles.length > 1;

  return (
    <>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => dialogRef.current?.showModal()}
        className={`rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-200 hover:bg-amber-500/15 disabled:opacity-50${
          fillCell ? " flex w-full justify-center" : ""
        }`}
      >
        Reinstall
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="reinstall-vps-title"
        aria-describedby="reinstall-vps-desc"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <p
            id="reinstall-vps-title"
            className="text-lg font-semibold text-orange-400"
          >
            Reinstall
          </p>
          <p
            id="reinstall-vps-desc"
            className="text-sm leading-relaxed text-[var(--muted)]"
          >
            This will{" "}
            <span className="font-medium text-[var(--foreground)]">
              permanently delete the current VM
            </span>{" "}
            and clone a fresh one with the same plan resources, public IP, and login settings.{" "}
            <span className="font-medium text-[var(--foreground)]">
              All data on the current disk will be lost.
            </span>{" "}
            The process can take several minutes.
          </p>

          {showPick ? (
            <div className="rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 p-3">
              <label
                htmlFor="reinstall-image"
                className="text-xs font-medium text-[var(--muted)]"
              >
                Operating system image
              </label>
              <select
                id="reinstall-image"
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId(e.target.value)}
                disabled={busy}
                className="mt-2 w-full rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-3 py-2 text-sm"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} (VMID {p.templateVmid})
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--background)]"
              onClick={() => dialogRef.current?.close()}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleConfirm()}
              disabled={
                busy ||
                (showPick && (!selectedProfileId || !profiles.some((p) => p.id === selectedProfileId)))
              }
            >
              {busy ? "Starting…" : "Reinstall"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
