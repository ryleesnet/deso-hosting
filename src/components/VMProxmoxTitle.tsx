"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/api-client";

type Props = {
  orderId: string;
  vmid: number;
};

/** Heading: VM display name from Proxmox; click to edit (saved to Proxmox / shown on the site). */
export function VMProxmoxTitle({ orderId, vmid }: Props) {
  const { user } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (vmid <= 0) {
      setName(null);
      return;
    }
    let cancelled = false;

    async function poll() {
      try {
        const res = await apiFetch(`/api/vm/${orderId}/status`);
        const data = (await res.json()) as { name?: unknown; error?: string };
        if (cancelled) return;
        if (!res.ok || data.error) {
          setName(null);
          return;
        }
        const raw = data.name;
        const n = typeof raw === "string" ? raw.trim() : "";
        setName(n || null);
      } catch {
        if (!cancelled) setName(null);
      }
    }

    void poll();
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [orderId, vmid]);

  const fallbackLabel = vmid > 0 ? `VPS - ${vmid}` : "VPS - …";
  const displayText = vmid <= 0 ? "VPS - …" : name || fallbackLabel;

  function openEdit() {
    if (!user || vmid <= 0) return;
    setDraft(name || fallbackLabel);
    setSaveError(null);
    dialogRef.current?.showModal();
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    const next = draft.trim();
    if (!next) {
      setSaveError("Name is required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/vm/${orderId}/name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      const data = (await res.json()) as { error?: string; name?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to save");
      }
      const saved = typeof data.name === "string" ? data.name.trim() : next;
      setName(saved || null);
      dialogRef.current?.close();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (vmid <= 0 || !user) {
    return <>{displayText}</>;
  }

  return (
    <>
      <button
        type="button"
        onClick={openEdit}
        className="cursor-pointer rounded px-0.5 text-left font-inherit text-inherit underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        title="Click to edit the display name"
      >
        {displayText}
      </button>
      <dialog
        ref={dialogRef}
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <form onSubmit={handleSave} className="flex flex-col gap-4">
          <p className="text-lg font-semibold">VM name</p>
          <p className="text-sm text-[var(--muted)]">
            This updates the display name on the website (not the hostname inside
            the guest).
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--muted)]">Name</span>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-[var(--foreground)]"
              maxLength={255}
              autoComplete="off"
              autoFocus
            />
          </label>
          {saveError && (
            <p className="text-sm text-red-400" role="alert">
              {saveError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--background)]"
              onClick={() => dialogRef.current?.close()}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
