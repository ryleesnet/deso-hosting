"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

type BackupRow = {
  volid: string;
  label: string;
  sizeBytes: number;
  createdAt: string;
  format: string;
};

type Props = {
  orderId: string;
  onStarted?: () => void;
  disabled?: boolean;
  disabledTitle?: string;
};

export function VmBackupsButton({
  orderId,
  onStarted,
  disabled,
  disabledTitle,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [listBusy, setListBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [selectedVolid, setSelectedVolid] = useState("");

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onCloseEvt = () => {
      setListBusy(false);
      setRestoreBusy(false);
      setError(null);
      setBackups([]);
      setSelectedVolid("");
    };
    el.addEventListener("close", onCloseEvt);
    return () => el.removeEventListener("close", onCloseEvt);
  }, []);

  async function openDialog() {
    setError(null);
    setListBusy(true);
    setBackups([]);
    setSelectedVolid("");
    dialogRef.current?.showModal();
    try {
      const res = await apiFetch(`/api/vm/${orderId}/backups`);
      const data = (await res.json()) as {
        error?: string;
        backups?: BackupRow[];
      };
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const rows = Array.isArray(data.backups) ? data.backups : [];
      setBackups(rows);
      if (rows.length > 0) setSelectedVolid(rows[0]!.volid);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load backups");
    } finally {
      setListBusy(false);
    }
  }

  async function handleRestore() {
    if (!selectedVolid) return;
    setError(null);
    setRestoreBusy(true);
    try {
      const res = await apiFetch(`/api/vm/${orderId}/backups/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volid: selectedVolid }),
      });
      const data = (await res.json()) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      dialogRef.current?.close();
      onStarted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Restore failed to start");
    } finally {
      setRestoreBusy(false);
    }
  }

  const busy = listBusy || restoreBusy;
  const btnClass =
    "flex w-full items-center justify-center rounded-lg border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-3 py-1.5 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent)]/25 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <>
      <button
        type="button"
        disabled={disabled || busy}
        title={disabled ? disabledTitle : undefined}
        onClick={() => void openDialog()}
        className={btnClass}
      >
        Backups
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby="vm-backups-title"
        aria-describedby="vm-backups-desc"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <div className="flex max-h-[calc(90vh-3rem)] flex-col gap-4">
          <div>
            <p id="vm-backups-title" className="text-lg font-semibold">
              Restore from backup
            </p>
            <p
              id="vm-backups-desc"
              className="mt-2 text-sm leading-relaxed text-[var(--muted)]"
            >
              Choose a backup archive to restore. The VPS will be stopped, disks
              replaced from the backup, then started again.{" "}
              <span className="font-medium text-[var(--foreground)]">
                Current disk contents will be overwritten.
              </span>
            </p>
          </div>

          {listBusy ? (
            <p className="text-sm text-[var(--muted)]">Loading backups…</p>
          ) : backups.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              {error
                ? null
                : "No backups found for this VPS."}
            </p>
          ) : (
            <div
              className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--card-border)]"
              role="radiogroup"
              aria-label="Available backups"
            >
              <ul className="divide-y divide-[var(--card-border)]">
                {backups.map((b) => (
                  <li key={b.volid}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-[var(--background)]/60">
                      <input
                        type="radio"
                        name="backup-volid"
                        className="mt-1"
                        checked={selectedVolid === b.volid}
                        onChange={() => setSelectedVolid(b.volid)}
                        disabled={restoreBusy}
                      />
                      <span className="min-w-0 flex-1 text-sm font-medium">
                        {b.label}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
              disabled={restoreBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleRestore()}
              disabled={
                restoreBusy || listBusy || !selectedVolid || backups.length === 0
              }
            >
              {restoreBusy ? "Starting restore…" : "Restore selected backup"}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
