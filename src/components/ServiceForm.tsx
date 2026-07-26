"use client";

import { useState, useEffect } from "react";
import { memoryGbToRamMb, ramMbToMemoryGb } from "@/lib/service-ram";
import { apiFetch } from "@/lib/api-client";
import type { VPSService } from "@/lib/db";

export function ServiceForm({
  service,
  onClose,
}: {
  service?: VPSService;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [vcpu, setVcpu] = useState(1);
  const [memoryGb, setMemoryGb] = useState(1);
  const [storage, setStorage] = useState(20);
  const [priceUsd, setPriceUsd] = useState("9.99");
  const [proxmoxNode, setProxmoxNode] = useState("");
  const [active, setActive] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (service) {
      setName(service.name);
      setDescription(service.description);
      setVcpu(service.vcpu);
      setMemoryGb(ramMbToMemoryGb(service.ram));
      setStorage(service.storage);
      setPriceUsd(((service.priceUsdCents ?? 0) / 100).toFixed(2));
      setProxmoxNode(service.proxmoxNode || "");
      setActive(service.active);
      setTesting(service.testing === true);
    }
  }, [service]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const dollars = parseFloat(priceUsd);
      if (!Number.isFinite(dollars) || dollars < 0) {
        setError("Enter a valid USD price (0 or more).");
        setSaving(false);
        return;
      }

      const priceUsdCents = Math.round(dollars * 100);
      const ram = memoryGbToRamMb(memoryGb);
      const body = {
        name,
        description,
        vcpu,
        ram,
        storage,
        priceUsdCents,
        proxmoxNode: proxmoxNode || undefined,
        active,
        testing,
      };

      const res = service
        ? await apiFetch(`/api/services/${service.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await apiFetch("/api/services", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
        return;
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-6">
        <h3 className="text-xl font-semibold">
          {service ? "Edit Service" : "Add Service"}
        </h3>
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm text-[var(--muted)]">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-[var(--muted)]">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2"
              rows={2}
            />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-[var(--muted)]">vCPU</label>
              <input
                type="number"
                min={1}
                value={vcpu}
                onChange={(e) => setVcpu(parseInt(e.target.value, 10) || 1)}
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--muted)]">Memory (GB)</label>
              <input
                type="number"
                min={1}
                step={1}
                value={memoryGb}
                onChange={(e) =>
                  setMemoryGb(Math.max(1, parseInt(e.target.value, 10) || 1))
                }
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--muted)]">Storage (GB)</label>
              <input
                type="number"
                min={1}
                value={storage}
                onChange={(e) => setStorage(parseInt(e.target.value, 10) || 20)}
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm text-[var(--muted)]">Price (USD / month)</label>
            <input
              type="text"
              inputMode="decimal"
              value={priceUsd}
              onChange={(e) => setPriceUsd(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2"
              placeholder="9.99"
            />
            <p className="mt-1 text-xs text-[var(--muted)]">
              Customers pay this amount in USD value. Charged in DeSo (at the live
              rate), dUSDC (1:1 USD), or PayPal at checkout.
            </p>
          </div>
          <div>
            <label className="block text-sm text-[var(--muted)]">
              Preferred Proxmox node
            </label>
            <input
              type="text"
              value={proxmoxNode}
              onChange={(e) => setProxmoxNode(e.target.value)}
              className="mt-1 max-w-md rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2"
              placeholder="pve"
            />
            <p className="mt-1 text-xs text-[var(--muted)] leading-relaxed">
              Default placement for VMs on this SKU. QEMU OS templates live on individual orders —
              Admin → Orders → <strong>VPS OS templates</strong> — not on catalogue plans anymore.
              Host-wide options use <code className="rounded bg-[var(--background)] px-1 text-[10px]">TEMPLATE_CATALOG_JSON</code>;{" "}
              <code className="rounded bg-[var(--background)] px-1 text-[10px]">PROXMOX_DEFAULT_*</code> stays the last-resort fallback.
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <label htmlFor="active" className="text-sm">
              Active (visible to users)
            </label>
          </div>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="testing"
              checked={testing}
              onChange={(e) => setTesting(e.target.checked)}
              className="mt-0.5"
            />
            <label htmlFor="testing" className="text-sm">
              Testing (Visible to Admins Only)
              <span className="mt-0.5 block text-xs text-[var(--muted)]">
                Hidden from the public catalog and checkout. Only admins can see
                and order this plan — useful for staging or a $0.01 smoke-test
                SKU.
              </span>
            </label>
          </div>
          <div className="flex gap-2 pt-4">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 rounded-lg bg-[var(--accent)] py-2 font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[var(--card-border)] px-4 py-2 hover:bg-[var(--card)]"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
