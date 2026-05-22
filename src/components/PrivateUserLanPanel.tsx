"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

export function PrivateUserLanPanel({
  orderId,
  enabled,
  ip,
  canEdit,
  onChange,
  className,
}: {
  orderId: string;
  enabled?: boolean;
  ip?: string;
  canEdit: boolean;
  onChange: () => void;
  /** Extra classes for layout on the dashboard (margins / borders handled by parent). */
  className?: string;
}) {
  const removeDialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = removeDialogRef.current;
    if (!el) return;
    const onClose = () => {
      setBusy(false);
      setError(null);
    };
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, []);

  async function setEnabled(next: boolean) {
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch(`/api/vm/${orderId}/private-network`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Request failed");
      }
      removeDialogRef.current?.close();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!canEdit) return null;

  return (
    <div
      className={`mt-5 rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 p-4${className ? ` ${className}` : ""}`}
    >
      <h4 className="text-sm font-semibold text-[var(--foreground)]">
        VM-to-VM private LAN
      </h4>
      <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
        Adds a second network adapter so your VPS can talk to{" "}
        <span className="font-medium text-[var(--foreground)]">your other VPS</span>{" "}
        on the same isolated VLAN. Each server gets an address from{" "}
        <span className="font-mono text-[var(--foreground)]">10.200.0.0/24</span>{" "}
        (unique per VM).
      </p>
      {enabled && ip != null && (
        <dl className="mt-3 gap-1 text-sm">
          <div>
            <dt className="text-[var(--muted)]">Private IPv4</dt>
            <dd className="font-mono text-[var(--accent)]">{ip}</dd>
          </div>
        </dl>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!enabled ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void setEnabled(true)}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
          >
            {busy ? "Enabling…" : "Add private network adapter"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => removeDialogRef.current?.showModal()}
            className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:bg-[var(--background)] disabled:opacity-50"
          >
            Remove private adapter
          </button>
        )}
      </div>

      <dialog
        ref={removeDialogRef}
        aria-labelledby="remove-privlan-title"
        aria-describedby="remove-privlan-desc"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <p
            id="remove-privlan-title"
            className="text-lg font-semibold text-amber-400"
          >
            Remove private adapter?
          </p>
          <p
            id="remove-privlan-desc"
            className="text-sm leading-relaxed text-[var(--muted)]"
          >
            This VM will lose its address on{" "}
            <span className="font-mono text-[var(--foreground)]">10.200.0.0/24</span>{" "}
            and won&apos;t reach your other VPS on that VLAN until you enable it again
            (you may receive a different IP).
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
              onClick={() => removeDialogRef.current?.close()}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void setEnabled(false)}
              disabled={busy}
            >
              {busy ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
