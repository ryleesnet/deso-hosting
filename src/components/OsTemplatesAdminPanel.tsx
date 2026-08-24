"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { suggestHostedTemplateDocId } from "@/lib/os-template-admin";

type Row = {
  id: string;
  label: string;
  templateVmid: number;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  /**
   * Cloud-image filename (or absolute path) on the Proxmox host. When set,
   * reinstall performs an in-place disk swap (`qm importdisk`-style) using
   * this image instead of full-cloning the template VMID.
   */
  imageFile?: string;
};

/** Admin CRUD for global Firestore catalogue `os_templates`. */
export function OsTemplatesAdminPanel({ embedded = false }: { embedded?: boolean }) {
  const [templates, setTemplates] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  /** New row draft */
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftVmid, setDraftVmid] = useState("");
  const [draftSort, setDraftSort] = useState("");
  const [draftImageFile, setDraftImageFile] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch("/api/admin/os-templates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `${res.status}`);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
      setSaveError(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to load");
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function onSuggestDraftId() {
    if (!draftLabel.trim()) return;
    setDraftId(suggestHostedTemplateDocId(draftLabel));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setSaveError(null);
    try {
      const tmpl = draftVmid.trim() ? parseInt(draftVmid, 10) : NaN;
      if (!Number.isFinite(tmpl) || tmpl <= 0 || !draftLabel.trim()) {
        setSaveError("Label and template VMID (positive integer) are required.");
        return;
      }
      const res = await apiFetch("/api/admin/os-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draftId.trim() || undefined,
          label: draftLabel.trim(),
          templateVmid: tmpl,
          active: true,
          sortOrder: draftSort.trim()
            ? Math.floor(parseInt(draftSort, 10))
            : undefined,
          imageFile: draftImageFile.trim() ? draftImageFile.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Create failed (${res.status})`);
      setDraftId("");
      setDraftLabel("");
      setDraftVmid("");
      setDraftSort("");
      setDraftImageFile("");
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function patchRow(row: Row, patch: Partial<Row>) {
    setSavingId(row.id);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/admin/os-templates/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: patch.label,
          templateVmid: patch.templateVmid,
          active: patch.active,
          sortOrder: patch.sortOrder,
          // `imageFile` is only forwarded when the row editor explicitly
          // touched it — undefined leaves the stored value alone, and an
          // empty string is normalised to `null` so PATCH can clear it.
          ...(patch.imageFile !== undefined
            ? { imageFile: patch.imageFile === "" ? null : patch.imageFile }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  }

  async function removeRow(row: Row) {
    if (!confirm(`Remove OS template “${row.label}” (${row.id}) from the catalogue?`)) return;
    setSavingId(row.id);
    setSaveError(null);
    try {
      const res = await apiFetch(`/api/admin/os-templates/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Delete failed (${res.status})`);
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <section className={embedded ? "mt-6" : "mt-14 scroll-mt-28"} id={embedded ? undefined : "admin-host-os"}>
      {!embedded ? (
        <h2 className="text-xl font-semibold">OS templates (global)</h2>
      ) : (
        <h3 className="text-sm font-semibold">OS templates (global)</h3>
      )}
      <p className="mt-2 max-w-3xl text-sm text-[var(--muted)] leading-relaxed">
        Name each Proxmox template guest (clone source VMID). Customers choose one at checkout and
        when reinstalling. Inactive templates stay off the storefront but remain editable here.
        Per-VPS overrides are still possible from <strong className="text-[var(--foreground)]">Orders → VPS OS templates</strong>.
      </p>
      <p className="mt-2 max-w-3xl text-xs text-[var(--muted)] leading-relaxed">
        Set an <strong className="text-[var(--foreground)]">Image file</strong> (e.g.{" "}
        <code className="rounded bg-[var(--background)] px-1">ubuntu-26.04-server-cloudimg-amd64.qcow2</code>)
        to switch reinstall to the fast in-place disk swap flow ({" "}
        <code className="rounded bg-[var(--background)] px-1">qm importdisk</code> equivalent, no full clone).
        Bare filenames are pulled from the Proxmox <em>import</em> storage named by{" "}
        <code className="rounded bg-[var(--background)] px-1">PROXMOX_CLOUD_IMAGE_STORAGE</code>{" "}
        (default <code className="rounded bg-[var(--background)] px-1">cloudimg</code>) — one-time PVE setup:
        {" "}
        <code className="rounded bg-[var(--background)] px-1">mkdir -p /cloudimg &amp;&amp; pvesm add dir cloudimg --path /cloudimg --content import</code>.
        Leave blank to keep the legacy full-clone reinstall.
      </p>

      <form onSubmit={(e) => void handleCreate(e)} className="mt-6 rounded-2xl border border-[var(--card-border)] bg-[var(--card)]/35 p-4">
        <h3 className="text-sm font-semibold text-[var(--foreground)]">Add template</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Example label:{" "}
          <code className="rounded bg-[var(--background)] px-1">Ubuntu 26.04 LTS</code> —
          Profile ID slug can be derived from the label or set manually (letters, digits, underscore, hyphen; starts with a letter).
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <label className="text-xs font-medium text-[var(--muted)]">Display label</label>
            <input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm"
              placeholder="Ubuntu 26.04 LTS"
              required
            />
          </div>
          <div className="lg:col-span-3">
            <label className="text-xs font-medium text-[var(--muted)]">Proxmox template VMID</label>
            <input
              type="number"
              min={1}
              value={draftVmid}
              onChange={(e) => setDraftVmid(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm font-mono"
              placeholder="5001"
              required
            />
          </div>
          <div className="lg:col-span-3">
            <label className="text-xs font-medium text-[var(--muted)]">Profile ID (optional)</label>
            <div className="mt-1 flex gap-2">
              <input
                value={draftId}
                onChange={(e) => setDraftId(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                placeholder="auto from label"
              />
              <button
                type="button"
                onClick={onSuggestDraftId}
                className="shrink-0 rounded-lg border border-[var(--card-border)] px-3 py-2 text-xs hover:bg-[var(--card)]"
              >
                Suggest
              </button>
            </div>
          </div>
          <div className="lg:col-span-2">
            <label className="text-xs font-medium text-[var(--muted)]">Sort order</label>
            <input
              type="number"
              value={draftSort}
              onChange={(e) => setDraftSort(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm"
              placeholder="0"
            />
          </div>
          <div className="lg:col-span-12">
            <label className="text-xs font-medium text-[var(--muted)]">
              Image file (optional, enables in-place reinstall)
            </label>
            <input
              value={draftImageFile}
              onChange={(e) => setDraftImageFile(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
              placeholder="ubuntu-26.04-server-cloudimg-amd64.qcow2"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={creating}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
          >
            {creating ? "Saving…" : "Add OS template"}
          </button>
        </div>
      </form>

      {saveError ? (
        <p className="mt-4 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {saveError}
        </p>
      ) : null}

      <div className="mt-6 overflow-auto rounded-2xl border border-[var(--card-border)]">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-[var(--card)] shadow-[0_1px_0_var(--card-border)]">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Active</th>
              <th className="px-3 py-2 text-left font-medium">Label</th>
              <th className="px-3 py-2 text-left font-medium">VMID</th>
              <th className="px-3 py-2 text-left font-medium">Profile ID</th>
              <th className="px-3 py-2 text-left font-medium">Image file</th>
              <th className="px-3 py-2 text-left font-medium">Sort</th>
              <th className="px-3 py-2 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-[var(--muted)]">
                  Loading templates…
                </td>
              </tr>
            ) : templates.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-[var(--muted)]">
                  No global OS templates yet — add Ubuntu 26.04 LTS (VMID <code className="rounded px-1">5001</code>) above.
                </td>
              </tr>
            ) : (
              templates.map((t) => (
                <OsTemplateEditableRow
                  key={t.id}
                  row={t}
                  busy={savingId === t.id}
                  onPatch={(patch) => void patchRow(t, patch)}
                  onRemove={() => void removeRow(t)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OsTemplateEditableRow(props: {
  row: Row;
  busy: boolean;
  onPatch: (patch: Partial<Row>) => void;
  onRemove: () => void;
}) {
  const { row, busy, onPatch, onRemove } = props;
  // Reset local draft fields whenever the parent row snapshot changes (e.g.
  // after a successful PATCH reload). Using React's "adjust state during
  // render" pattern instead of a `useEffect` so we don't cascade renders and
  // stay within the `react-hooks/set-state-in-effect` lint rule.
  const [rowSnapshot, setRowSnapshot] = useState(row);
  const [label, setLabel] = useState(row.label);
  const [vmid, setVmid] = useState(String(row.templateVmid));
  const [sortOrder, setSortOrder] = useState(String(row.sortOrder));
  const [imageFile, setImageFile] = useState(row.imageFile ?? "");
  if (rowSnapshot !== row) {
    setRowSnapshot(row);
    setLabel(row.label);
    setVmid(String(row.templateVmid));
    setSortOrder(String(row.sortOrder));
    setImageFile(row.imageFile ?? "");
  }

  const tvm = Math.floor(Number(vmid));
  const sortN = Math.floor(Number(sortOrder) || 0);
  const dirty =
    label.trim() !== row.label.trim() ||
    tvm !== row.templateVmid ||
    sortN !== row.sortOrder ||
    imageFile.trim() !== (row.imageFile ?? "").trim();
  const canSave =
    label.trim().length > 0 && Number.isFinite(tvm) && tvm > 0;

  return (
    <tr className="border-b border-[var(--card-border)] last:border-0">
      <td className="px-3 py-2 align-middle">
        <button
          type="button"
          disabled={busy}
          onClick={() => onPatch({ active: !row.active })}
          className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${row.active ? "bg-green-500/15 text-green-400" : "bg-[var(--background)] text-[var(--muted)]"} border border-[var(--card-border)]`}
        >
          {row.active ? "yes" : "no"}
        </button>
      </td>
      <td className="px-3 py-2 align-middle">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
          className="w-full max-w-[14rem] rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-sm"
        />
      </td>
      <td className="px-3 py-2 align-middle">
        <input
          type="number"
          min={1}
          value={vmid}
          onChange={(e) => setVmid(e.target.value)}
          disabled={busy}
          className="w-28 rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 font-mono text-sm"
        />
      </td>
      <td className="px-3 py-2 align-middle font-mono text-xs text-[var(--muted)]">{row.id}</td>
      <td className="px-3 py-2 align-middle">
        <input
          value={imageFile}
          onChange={(e) => setImageFile(e.target.value)}
          disabled={busy}
          placeholder="(clone reinstall)"
          className="w-56 rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 font-mono text-xs"
        />
      </td>
      <td className="px-3 py-2 align-middle">
        <input
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          disabled={busy}
          className="w-20 rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-sm"
        />
      </td>
      <td className="px-3 py-2 align-middle">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !dirty || !canSave}
            onClick={() =>
              onPatch({
                label: label.trim(),
                templateVmid: tvm,
                sortOrder: sortN,
                imageFile: imageFile.trim(),
              })
            }
            className="rounded border border-[var(--card-border)] px-2 py-1 text-xs hover:bg-[var(--card)] disabled:opacity-40"
          >
            Save row
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}
