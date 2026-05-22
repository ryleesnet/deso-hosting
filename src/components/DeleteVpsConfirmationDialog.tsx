"use client";

import { useEffect, useState, type RefObject } from "react";
import { apiFetch } from "@/lib/api-client";

export type DeleteVpsConfirmationDialogProps = {
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** Current order to cancel; read at confirm time so async open + ref pattern is safe. */
  orderIdRef: RefObject<string | null>;
  userPublicKey: string;
  onSuccess: () => void;
  /** Called when the dialog is dismissed (Cancel, Escape, backdrop) so parents can clear pending state. */
  onDismiss?: () => void;
};

/**
 * Same UX as force shutdown / force restart in {@link VPSControl}: native &lt;dialog&gt; with themed content.
 */
export function DeleteVpsConfirmationDialog({
  dialogRef,
  orderIdRef,
  userPublicKey,
  onSuccess,
  onDismiss,
}: DeleteVpsConfirmationDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onClose = () => {
      setBusy(false);
      setError(null);
      onDismiss?.();
    };
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, [dialogRef, onDismiss]);

  async function handleConfirm() {
    const orderId = orderIdRef.current;
    if (!userPublicKey?.trim() || !orderId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/orders/${orderId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `Cancel failed (${res.status})`
        );
      }
      dialogRef.current?.close();
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="delete-vps-title"
      aria-describedby="delete-vps-desc"
      className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
    >
      <div className="flex flex-col gap-4">
        <p
          id="delete-vps-title"
          className="text-lg font-semibold text-red-400"
        >
          Delete VPS
        </p>
        <p
          id="delete-vps-desc"
          className="text-sm leading-relaxed text-[var(--muted)]"
        >
          This will{" "}
          <span className="font-medium text-[var(--foreground)]">
            cancel the subscription
          </span>{" "}
          and remove the VM. This cannot be undone.
        </p>
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
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleConfirm()}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete VPS"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
