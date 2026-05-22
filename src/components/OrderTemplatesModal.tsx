"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";

export type TemplateProfileRow = {
  id: string;
  label: string;
  templateVmid: number;
};

function newProfileRow(): TemplateProfileRow {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? `img_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
      : `img_${Date.now()}`;
  return { id, label: "", templateVmid: 0 };
}

/** Admin: edit QEMU clone catalogue for one VPS (`orders.imageProfiles`). */
export function OrderTemplatesModal(props: {
  orderId: string;
  summaryHint?: string;
  initialProfiles: TemplateProfileRow[];
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { orderId, summaryHint, initialProfiles, open, onClose, onSaved } = props;
  const [draft, setDraft] = useState<TemplateProfileRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(
      initialProfiles.length ? initialProfiles.map((p) => ({ ...p })) : []
    );
  }, [open, initialProfiles]);

  function buildValidatedProfilesPayload(): TemplateProfileRow[] | null {
    const out: TemplateProfileRow[] = [];
    const seenIds = new Set<string>();
    const seenVmids = new Set<number>();
    for (const row of draft) {
      const id = row.id.trim();
      const label = row.label.trim();
      const tmpl = Math.floor(Number(row.templateVmid));
      if (!id && !label && !Number.isFinite(tmpl)) continue;
      if (!id || !label || tmpl <= 0) return null;
      if (seenIds.has(id) || seenVmids.has(tmpl)) return null;
      seenIds.add(id);
      seenVmids.add(tmpl);
      out.push({ id, label, templateVmid: tmpl });
    }
    return out;
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const validated = buildValidatedProfilesPayload();
      if (validated === null) {
        setError(
          "Complete each row with a unique Profile ID (start with a letter), a label, and a unique template VMID — or remove incomplete rows."
        );
        return;
      }

      const res = await apiFetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageProfiles: validated }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.error === "string" ? data.error : `Request failed (${res.status})`
        );
        return;
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-labelledby="order-templates-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-6"
      >
        <h3 id="order-templates-title" className="text-lg font-semibold">
          VPS OS templates
        </h3>
        <p className="mt-2 text-xs text-[var(--muted)] leading-relaxed">
          These profiles belong to order{" "}
          <code className="rounded bg-[var(--background)] px-1 font-mono">{orderId}</code>.
          Checkout and reinstall use this list once saved. Clear all rows and save to revert to{" "}
          <code className="rounded px-1 font-mono text-[10px]">TEMPLATE_CATALOG_JSON</code> then
          legacy plan settings.
        </p>
        {summaryHint ? (
          <p className="mt-2 rounded-lg border border-[var(--card-border)]/70 bg-[var(--background)]/20 px-3 py-2 text-xs text-[var(--muted)]">
            {summaryHint}
          </p>
        ) : null}

        <div className="mt-4 rounded-xl border border-[var(--card-border)] bg-[var(--background)]/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-[var(--foreground)]">
              OS images (profiles)
            </span>
            <button
              type="button"
              onClick={() => setDraft((prev) => [...prev, newProfileRow()])}
              className="rounded-lg border border-[var(--accent-muted)] bg-[var(--accent)]/10 px-3 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20"
            >
              Add profile
            </button>
          </div>
          {draft.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--muted)]">
              No rows — VPS uses global/host defaults after save (see hint above).
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {draft.map((row, idx) => (
                <div
                  key={`${row.id}-${idx}`}
                  className="grid gap-2 rounded-lg border border-[var(--card-border)] bg-[var(--card)]/40 p-2 sm:grid-cols-[1fr_1fr_110px_auto]"
                >
                  <div>
                    <label className="text-[10px] font-semibold uppercase text-[var(--muted)]">
                      Profile ID
                    </label>
                    <input
                      type="text"
                      value={row.id}
                      onChange={(e) =>
                        setDraft((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, id: e.target.value } : r
                          )
                        )
                      }
                      className="mt-0.5 w-full rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold uppercase text-[var(--muted)]">
                      Label (visible)
                    </label>
                    <input
                      type="text"
                      value={row.label}
                      onChange={(e) =>
                        setDraft((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, label: e.target.value } : r
                          )
                        )
                      }
                      className="mt-0.5 w-full rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-semibold uppercase text-[var(--muted)]">
                      Template VMID
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={
                        row.templateVmid > 0 ? String(row.templateVmid) : ""
                      }
                      onChange={(e) =>
                        setDraft((prev) =>
                          prev.map((r, i) =>
                            i === idx
                              ? {
                                  ...r,
                                  templateVmid: parseInt(e.target.value, 10) || 0,
                                }
                              : r
                          )
                        )
                      }
                      className="mt-0.5 w-full rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-sm"
                    />
                  </div>
                  <div className="flex items-end justify-end">
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((prev) => prev.filter((_, i) => i !== idx))
                      }
                      className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {error ? (
          <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--card)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
