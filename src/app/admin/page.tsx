"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";
import { ServiceForm } from "@/components/ServiceForm";
import { DeleteVpsConfirmationDialog } from "@/components/DeleteVpsConfirmationDialog";
import { formatDesoDisplay } from "@/lib/deso";
import { formatUsdCents } from "@/lib/pricing";
import { apiFetch } from "@/lib/api-client";

interface VPSService {
  id: string;
  name: string;
  description: string;
  vcpu: number;
  ram: number;
  storage: number;
  priceUsdCents: number;
  pricePreviewNanos?: number;
  priceNanos?: number;
  active: boolean;
  proxmoxNode?: string;
  proxmoxTemplate?: number;
}

interface Order {
  id: string;
  userId: string;
  serviceId: string;
  vmid: number;
  node: string;
  status: string;
  publicIpv4?: string;
}

interface PublicIpRecord {
  address: string;
  status: string;
  userId?: string;
  orderId?: string;
  vmid?: number;
  node?: string;
}

export default function AdminPage() {
  const { user, isAdmin } = useAuth();
  const [services, setServices] = useState<VPSService[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [publicIps, setPublicIps] = useState<PublicIpRecord[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingIp, setEditingIp] = useState<string | null>(null);
  const [ipDraft, setIpDraft] = useState<{
    status: string;
    orderId: string;
    userId: string;
    vmid: string;
  } | null>(null);
  const [ipSaving, setIpSaving] = useState<string | null>(null);
  const [publicIpError, setPublicIpError] = useState<string | null>(null);
  const [ipListRefreshing, setIpListRefreshing] = useState(false);
  const [ipFilterStatus, setIpFilterStatus] = useState<string>("");
  const [ipFilterUserId, setIpFilterUserId] = useState("");
  const [ipFilterAddress, setIpFilterAddress] = useState("");
  const [ipFilterOrderId, setIpFilterOrderId] = useState("");
  const [ipFilterVmid, setIpFilterVmid] = useState("");

  const [orderFilterOrderId, setOrderFilterOrderId] = useState("");
  const [orderFilterUserId, setOrderFilterUserId] = useState("");
  const [orderFilterVmid, setOrderFilterVmid] = useState("");
  const [orderFilterPublicIp, setOrderFilterPublicIp] = useState("");
  const [orderFilterNode, setOrderFilterNode] = useState("");
  /** "" = all except cancelled (default); "all" = include cancelled; else exact status */
  const [orderFilterStatus, setOrderFilterStatus] = useState<string>("");
  const [orderFiltersOpen, setOrderFiltersOpen] = useState(false);
  const [orderCopyToast, setOrderCopyToast] = useState<{
    message: string;
    x: number;
    y: number;
    isError: boolean;
  } | null>(null);
  const orderClipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adminDeleteOrderRef = useRef<string | null>(null);
  const adminDeleteDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    return () => {
      if (orderClipboardTimerRef.current) {
        clearTimeout(orderClipboardTimerRef.current);
      }
    };
  }, []);

  function showOrderCopyToast(
    message: string,
    clientX: number,
    clientY: number,
    isError: boolean
  ) {
    if (orderClipboardTimerRef.current) {
      clearTimeout(orderClipboardTimerRef.current);
    }
    setOrderCopyToast({ message, x: clientX, y: clientY, isError });
    orderClipboardTimerRef.current = setTimeout(() => {
      setOrderCopyToast(null);
      orderClipboardTimerRef.current = null;
    }, 1800);
  }

  async function copyOrderAdminField(
    text: string,
    flashLabel: string,
    e: MouseEvent<HTMLButtonElement>
  ) {
    const t = text.trim();
    if (!t) return;
    const { clientX, clientY } = e;
    try {
      await navigator.clipboard.writeText(t);
      showOrderCopyToast(`Copied ${flashLabel}`, clientX, clientY, false);
    } catch {
      showOrderCopyToast(
        "Copy failed — check browser permissions",
        clientX,
        clientY,
        true
      );
    }
  }

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      if (orderFilterStatus === "") {
        if (o.status === "cancelled") return false;
      } else if (orderFilterStatus !== "all" && o.status !== orderFilterStatus) {
        return false;
      }

      const orderQ = orderFilterOrderId.trim().toLowerCase();
      if (orderQ && !o.id.toLowerCase().includes(orderQ)) return false;

      const userQ = orderFilterUserId.trim().toLowerCase();
      if (userQ && !o.userId.toLowerCase().includes(userQ)) return false;

      const vmidQ = orderFilterVmid.trim();
      if (vmidQ) {
        const vmStr = o.vmid > 0 ? String(o.vmid) : "";
        if (!vmStr.includes(vmidQ)) return false;
      }

      const ipQ = orderFilterPublicIp.trim().toLowerCase();
      if (ipQ && !(o.publicIpv4 ?? "").toLowerCase().includes(ipQ)) {
        return false;
      }

      const nodeQ = orderFilterNode.trim().toLowerCase();
      if (nodeQ && !(o.node ?? "").toLowerCase().includes(nodeQ)) return false;

      return true;
    });
  }, [
    orders,
    orderFilterOrderId,
    orderFilterUserId,
    orderFilterVmid,
    orderFilterPublicIp,
    orderFilterNode,
    orderFilterStatus,
  ]);

  const orderFiltersActive =
    orderFilterStatus !== "" ||
    !!orderFilterOrderId.trim() ||
    !!orderFilterUserId.trim() ||
    !!orderFilterVmid.trim() ||
    !!orderFilterPublicIp.trim() ||
    !!orderFilterNode.trim();

  function clearOrderFilters() {
    setOrderFilterOrderId("");
    setOrderFilterUserId("");
    setOrderFilterVmid("");
    setOrderFilterPublicIp("");
    setOrderFilterNode("");
    setOrderFilterStatus("");
  }

  const filteredPublicIps = useMemo(() => {
    return publicIps.filter((ip) => {
      if (ipFilterStatus && ip.status !== ipFilterStatus) return false;

      const addrQ = ipFilterAddress.trim().toLowerCase();
      if (addrQ && !(ip.address ?? "").toLowerCase().includes(addrQ)) {
        return false;
      }

      const orderQ = ipFilterOrderId.trim().toLowerCase();
      if (orderQ && !(ip.orderId ?? "").toLowerCase().includes(orderQ)) {
        return false;
      }

      const vmidQ = ipFilterVmid.trim();
      if (vmidQ) {
        const vmStr =
          ip.vmid != null && ip.vmid > 0 ? String(ip.vmid) : "";
        if (!vmStr.includes(vmidQ)) return false;
      }

      const userQ = ipFilterUserId.trim();
      if (userQ) {
        const uid = (ip.userId ?? "").toLowerCase();
        if (!uid.includes(userQ.toLowerCase())) return false;
      }
      return true;
    });
  }, [
    publicIps,
    ipFilterStatus,
    ipFilterUserId,
    ipFilterAddress,
    ipFilterOrderId,
    ipFilterVmid,
  ]);

  const ipFiltersActive =
    !!ipFilterStatus ||
    !!ipFilterUserId.trim() ||
    !!ipFilterAddress.trim() ||
    !!ipFilterOrderId.trim() ||
    !!ipFilterVmid.trim();

  const [ipFiltersOpen, setIpFiltersOpen] = useState(false);

  function clearIpFilters() {
    setIpFilterStatus("");
    setIpFilterUserId("");
    setIpFilterAddress("");
    setIpFilterOrderId("");
    setIpFilterVmid("");
  }

  async function reloadPublicIps() {
    if (!user || !isAdmin) return;
    setIpListRefreshing(true);
    setPublicIpError(null);
    try {
      const r = await apiFetch(`/api/admin/public-ips`);
      const data = await r.json().catch(() => []);
      if (!r.ok) {
        setPublicIpError(
          typeof data.error === "string" ? data.error : "Could not load public IPs"
        );
        return;
      }
      setPublicIps(Array.isArray(data) ? (data as PublicIpRecord[]) : []);
    } finally {
      setIpListRefreshing(false);
    }
  }

  function loadData() {
    if (!user || !isAdmin) return;
    Promise.all([
      apiFetch(`/api/services`).then((r) => r.json()),
      apiFetch(`/api/orders?as=all`).then((r) => r.json()),
      apiFetch(`/api/admin/public-ips`).then(
        async (r) => {
          const data = await r.json().catch(() => []);
          if (!r.ok) return [];
          return Array.isArray(data) ? data : [];
        }
      ),
    ]).then(([svc, ord, ips]) => {
      setServices(Array.isArray(svc) ? svc : []);
      setOrders(Array.isArray(ord) ? ord : []);
      setPublicIps(ips as PublicIpRecord[]);
    }).finally(() => setLoading(false));
  }

  useEffect(() => {
    loadData();
  }, [user, isAdmin]);

  async function handleDelete(id: string) {
    if (!user || !confirm("Delete this service?")) return;
    await apiFetch(`/api/services/${id}`, {
      method: "DELETE",
    });
    loadData();
  }

  const [provisioning, setProvisioning] = useState<string | null>(null);
  const [provisionVmid, setProvisionVmid] = useState<Record<string, string>>({});
  const [provisionNode, setProvisionNode] = useState<Record<string, string>>({});

  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [orderSuspendBusy, setOrderSuspendBusy] = useState<string | null>(null);

  /** Import existing VM: link Firestore order + subscription without cloning. */
  const [importUserId, setImportUserId] = useState("");
  const [importServiceId, setImportServiceId] = useState("");
  const [importNode, setImportNode] = useState("");
  const [importVmid, setImportVmid] = useState("");
  const [importLastPayment, setImportLastPayment] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });
  const [importNextPayment, setImportNextPayment] = useState("");
  const [importPublicIp, setImportPublicIp] = useState("");
  const [importExtraDisks, setImportExtraDisks] = useState("");
  const [importLoginUser, setImportLoginUser] = useState("");
  const [importLoginPass, setImportLoginPass] = useState("");
  const [importSshKeys, setImportSshKeys] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{
    orderId: string;
    hints: string[];
  } | null>(null);

  useEffect(() => {
    if (importServiceId || !services.length) return;
    const first = services.find((s) => s.active);
    if (first) setImportServiceId(first.id);
  }, [services, importServiceId]);

  async function handleProvision(orderId: string) {
    if (!user) return;
    const vmid = parseInt(provisionVmid[orderId] || "0", 10);
    const node = provisionNode[orderId] || "";
    if (!vmid || !node) {
      setProvisionError("Enter VMID and Node");
      return;
    }
    setProvisionError(null);
    setProvisioning(orderId);
    try {
      const res = await apiFetch("/api/admin/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          vmid,
          node,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        loadData();
        setProvisionVmid((p) => ({ ...p, [orderId]: "" }));
        setProvisionNode((p) => ({ ...p, [orderId]: "" }));
      } else {
        setProvisionError(data.details || data.error || "Provisioning failed");
      }
    } finally {
      setProvisioning(null);
    }
  }

  async function handleImportExistingVm(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    setImportErr(null);
    setImportResult(null);
    const vmid = parseInt(importVmid.trim(), 10);
    if (!importUserId.trim()) {
      setImportErr("Customer DeSo public key is required.");
      return;
    }
    if (!importServiceId) {
      setImportErr("Choose a service plan.");
      return;
    }
    if (!importNode.trim()) {
      setImportErr("Proxmox node is required.");
      return;
    }
    if (!Number.isFinite(vmid) || vmid <= 0) {
      setImportErr("VMID must be a positive number.");
      return;
    }
    if (!importLastPayment.trim()) {
      setImportErr("Last payment date is required.");
      return;
    }
    setImportBusy(true);
    try {
      const res = await apiFetch("/api/admin/import-existing-vm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: importUserId.trim(),
          serviceId: importServiceId,
          vmid,
          node: importNode.trim(),
          lastPaymentAt: importLastPayment.trim(),
          ...(importNextPayment.trim()
            ? { nextPaymentAt: importNextPayment.trim() }
            : {}),
          ...(importPublicIp.trim() ? { publicIpv4: importPublicIp.trim() } : {}),
          ...(importExtraDisks.trim()
            ? { extraDisksGb: importExtraDisks.trim() }
            : {}),
          ...(importLoginUser.trim()
            ? { vmLoginUsername: importLoginUser.trim() }
            : {}),
          ...(importLoginPass ? { vmLoginPassword: importLoginPass } : {}),
          ...(importSshKeys.trim()
            ? { cloudInitSshKeys: importSshKeys.trim() }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImportErr(
          typeof data.error === "string" ? data.error : `Import failed (${res.status})`
        );
        return;
      }
      const hints: string[] = [];
      if (data.serviceInactive) {
        hints.push(
          "This service is marked inactive in the catalogue; consider activating it or picking another plan."
        );
      }
      if (importPublicIp.trim() && data.publicIpPoolLinked === false) {
        hints.push(
          "Public IP was saved on the order but no matching public_ips row was updated — assign the address in Public IPs below if you use the pool."
        );
      }
      setImportResult({
        orderId: String(data.orderId ?? ""),
        hints,
      });
      setImportUserId("");
      setImportVmid("");
      setImportNextPayment("");
      setImportPublicIp("");
      setImportExtraDisks("");
      setImportLoginUser("");
      setImportLoginPass("");
      setImportSshKeys("");
      loadData();
    } finally {
      setImportBusy(false);
    }
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <p className="text-[var(--muted)]">Please log in.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <p className="text-red-400">Admin access required.</p>
        <Link href="/dashboard" className="mt-4 inline-block text-[var(--accent)] hover:underline">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16">
        <div className="h-64 animate-pulse rounded-2xl bg-[var(--card)]" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold">Admin Panel</h1>
      <p className="mt-2 text-[var(--muted)]">
        Manage services and orders
      </p>

      {/* Import existing VM (production / manual onboarding) */}
      <section className="mt-12 rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-6">
        <h2 className="text-xl font-semibold">Import existing VM (customer)</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Creates an <span className="font-medium text-[var(--foreground)]">active</span> order and
          subscription linked to a VM that already exists in Proxmox — no clone and no cloud-init
          changes. Required besides the fields below:{" "}
          <span className="font-medium text-[var(--foreground)]">
            service plan
          </span>{" "}
          (pricing / specs) and{" "}
          <span className="font-medium text-[var(--foreground)]">Proxmox node</span> (same host
          name you use in the orders table).
        </p>
        <form onSubmit={handleImportExistingVm} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--foreground)]">
              Customer DeSo public key <span className="text-red-400">*</span>
            </label>
            <textarea
              value={importUserId}
              onChange={(e) => setImportUserId(e.target.value)}
              rows={3}
              required
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs"
              placeholder="BC1YL…"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-[var(--foreground)]">
                Service plan <span className="text-red-400">*</span>
              </label>
              <select
                value={importServiceId}
                onChange={(e) => setImportServiceId(e.target.value)}
                required
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm"
              >
                <option value="">Select…</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {!s.active ? " (inactive)" : ""} ({formatUsdCents(s.priceUsdCents ?? 0)}/mo)
                  </option>
                ))}
              </select>
              {services.length === 0 ? (
                <p className="mt-1 text-xs text-amber-400">Add a service under VPS Services first.</p>
              ) : null}
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--foreground)]">
                Proxmox node <span className="text-red-400">*</span>
              </label>
              <input
                value={importNode}
                onChange={(e) => setImportNode(e.target.value)}
                required
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                placeholder="pve01"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-[var(--foreground)]">
                VMID <span className="text-red-400">*</span>
              </label>
              <input
                type="number"
                min={1}
                value={importVmid}
                onChange={(e) => setImportVmid(e.target.value)}
                required
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                placeholder="5002"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--foreground)]">
                Last payment date <span className="text-red-400">*</span>
              </label>
              <input
                type="date"
                value={importLastPayment}
                onChange={(e) => setImportLastPayment(e.target.value)}
                required
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-[var(--muted)]">
                Next renewal defaults to one calendar month after this if you leave the next field
                empty.
              </p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--foreground)]">
              Next payment date <span className="text-[var(--muted)]">(optional)</span>
            </label>
            <input
              type="date"
              value={importNextPayment}
              onChange={(e) => setImportNextPayment(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm"
            />
          </div>
          <details className="rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 p-4">
            <summary className="cursor-pointer text-sm font-medium text-[var(--foreground)]">
              Optional: public IP, extra disks, login, SSH
            </summary>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--muted)]">
                  Public IPv4
                </label>
                <input
                  value={importPublicIp}
                  onChange={(e) => setImportPublicIp(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  placeholder="If in pool, we try to mark the row assigned"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--muted)]">
                  Extra data disks (GB, comma-separated — affects billed add-ons)
                </label>
                <input
                  value={importExtraDisks}
                  onChange={(e) => setImportExtraDisks(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  placeholder="e.g. 50, 100"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)]">
                    VM login username (dashboard)
                  </label>
                  <input
                    value={importLoginUser}
                    onChange={(e) => setImportLoginUser(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--muted)]">
                    VM login password (stored like other orders)
                  </label>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={importLoginPass}
                    onChange={(e) => setImportLoginPass(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--muted)]">
                  SSH public key(s), one per line (optional; not pushed to Proxmox by this form)
                </label>
                <textarea
                  value={importSshKeys}
                  onChange={(e) => setImportSshKeys(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs"
                />
              </div>
            </div>
          </details>
          {importErr ? (
            <p className="text-sm text-red-400" role="alert">
              {importErr}
            </p>
          ) : null}
          {importResult ? (
            <div className="rounded-lg border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-300">
              <p className="font-medium">Order created</p>
              <p className="mt-1 font-mono text-xs break-all">{importResult.orderId}</p>
              {importResult.hints.map((h) => (
                <p key={h} className="mt-2 text-xs text-amber-200/95">
                  {h}
                </p>
              ))}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={importBusy}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
          >
            {importBusy ? "Creating…" : "Create order + subscription"}
          </button>
        </form>
      </section>

      {/* Services */}
      <section className="mt-12">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">VPS Services</h2>
          <button
            onClick={() => { setShowForm(true); setEditingId(null); }}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)]"
          >
            Add Service
          </button>
        </div>

        {showForm && (
          <ServiceForm
            service={editingId ? services.find((s) => s.id === editingId) : undefined}
            onClose={() => { setShowForm(false); setEditingId(null); loadData(); }}
          />
        )}

        <div className="mt-6 space-y-4">
          {services.map((s) => (
            <div
              key={s.id}
              className="flex flex-col gap-4 rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-6 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <h3 className="font-semibold">{s.name}</h3>
                <p className="text-sm text-[var(--muted)]">{s.description}</p>
                <p className="mt-2 text-sm">
                  {s.vcpu} vCPU · {s.ram / 1024} GB Memory · {s.storage} GB
                </p>
                <p className="mt-1 text-sm">
                  <span className="text-[var(--accent)]">
                    {formatUsdCents(s.priceUsdCents)}/mo
                  </span>
                  <span className="text-[var(--muted)]">
                    {" "}
                    (~{formatDesoDisplay(s.pricePreviewNanos ?? s.priceNanos ?? 0)} DESO)
                  </span>
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => { setEditingId(s.id); setShowForm(true); }}
                  className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-[var(--card)]"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(s.id)}
                  className="rounded-lg border border-red-500/50 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Public IP pool */}
      <section className="mt-16">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-xl font-semibold">Public IP Addresses</h2>
          <button
            type="button"
            onClick={() => void reloadPublicIps()}
            disabled={ipListRefreshing}
            className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-sm hover:bg-[var(--card)] disabled:opacity-50"
          >
            {ipListRefreshing ? "Refreshing…" : "Refresh pool"}
          </button>
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Firestore <code className="rounded bg-[var(--card)] px-1">public_ips</code> —
          edit status, order, user, and VM ID. Clearing optional fields removes them from the document.
        </p>
        <PublicIpPoolConfigPanel publicKey={user.publicKey} />
        {publicIpError && (
          <div className="mt-4 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm text-red-400">
            {publicIpError}
            <button
              type="button"
              onClick={() => setPublicIpError(null)}
              className="ml-2 underline"
            >
              Dismiss
            </button>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[var(--muted)]">
            Showing {filteredPublicIps.length} of {publicIps.length} addresses
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {ipFiltersActive && (
              <button
                type="button"
                onClick={clearIpFilters}
                className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-xs hover:bg-[var(--card)]"
              >
                Clear filters
              </button>
            )}
            <button
              type="button"
              onClick={() => setIpFiltersOpen((v) => !v)}
              aria-expanded={ipFiltersOpen}
              aria-controls="public-ip-filter-fields"
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--card-border)] bg-[var(--card)]/30 px-3 py-1.5 text-xs font-medium hover:bg-[var(--card)]"
            >
              <span className="text-[10px] text-[var(--muted)]" aria-hidden>
                {ipFiltersOpen ? "▼" : "▶"}
              </span>
              Filters
              {ipFiltersActive && (
                <span className="rounded-full bg-[var(--accent)]/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                  Active
                </span>
              )}
            </button>
          </div>
        </div>
        <div className="mt-2 max-h-[31rem] overflow-auto rounded-2xl border border-[var(--card-border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--card)] shadow-[0_1px_0_var(--card-border)]">
              <tr>
                <th className="px-3 py-3 text-left font-medium">Address</th>
                <th className="px-3 py-3 text-left font-medium">Status</th>
                <th className="px-3 py-3 text-left font-medium">Order ID</th>
                <th className="px-3 py-3 text-left font-medium">User ID</th>
                <th className="px-3 py-3 text-left font-medium">VMID</th>
                <th className="px-3 py-3 text-left font-medium">Actions</th>
              </tr>
              {ipFiltersOpen && (
                <tr
                  id="public-ip-filter-fields"
                  className="border-b border-[var(--card-border)]"
                >
                <th className="px-3 py-2 align-bottom font-normal">
                  <label className="sr-only" htmlFor="ip-filter-address">
                    Filter by IP address
                  </label>
                  <input
                    id="ip-filter-address"
                    type="text"
                    value={ipFilterAddress}
                    onChange={(e) => setIpFilterAddress(e.target.value)}
                    placeholder="IP Address"
                    className="w-full min-w-[6rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs placeholder:font-sans"
                    aria-label="Filter by IP address substring"
                  />
                </th>
                <th className="px-3 py-2 align-bottom font-normal">
                  <label className="sr-only" htmlFor="ip-filter-status">
                    Filter by status
                  </label>
                  <select
                    id="ip-filter-status"
                    value={ipFilterStatus}
                    onChange={(e) => setIpFilterStatus(e.target.value)}
                    className="w-full min-w-[8rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 text-xs"
                    aria-label="Filter by status"
                  >
                    <option value="">All</option>
                    <option value="available">available</option>
                    <option value="assigned">assigned</option>
                    <option value="reserved">reserved</option>
                  </select>
                </th>
                <th className="px-3 py-2 align-bottom font-normal">
                  <label className="sr-only" htmlFor="ip-filter-orderid">
                    Filter by OrderID
                  </label>
                  <input
                    id="ip-filter-orderid"
                    type="text"
                    value={ipFilterOrderId}
                    onChange={(e) => setIpFilterOrderId(e.target.value)}
                    placeholder="OrderID"
                    className="w-full min-w-[6rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs placeholder:font-sans"
                    aria-label="Filter by OrderID substring"
                  />
                </th>
                <th className="px-3 py-2 align-bottom font-normal">
                  <label className="sr-only" htmlFor="ip-filter-userid">
                    Filter by PublicKey
                  </label>
                  <input
                    id="ip-filter-userid"
                    type="text"
                    value={ipFilterUserId}
                    onChange={(e) => setIpFilterUserId(e.target.value)}
                    placeholder="PublicKey"
                    className="w-full min-w-[6rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs placeholder:font-sans"
                    aria-label="Filter by PublicKey substring"
                  />
                </th>
                <th className="px-3 py-2 align-bottom font-normal">
                  <label className="sr-only" htmlFor="ip-filter-vmid">
                    Filter by VMID
                  </label>
                  <input
                    id="ip-filter-vmid"
                    type="text"
                    inputMode="numeric"
                    value={ipFilterVmid}
                    onChange={(e) => setIpFilterVmid(e.target.value)}
                    placeholder="VMID"
                    className="w-full min-w-[3.5rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs tabular-nums placeholder:font-sans"
                    aria-label="Filter by VMID substring"
                  />
                </th>
                <th className="px-3 py-2 align-bottom font-normal" aria-hidden />
                </tr>
              )}
            </thead>
            <tbody>
              {publicIps.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--muted)]">
                    No IP rows loaded (empty pool or not seeded). Use{" "}
                    <code className="rounded bg-[var(--card)] px-1">npm run db:seed-public-ips</code>{" "}
                    to seed addresses.
                  </td>
                </tr>
              ) : filteredPublicIps.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[var(--muted)]">
                    No addresses match the current filters.
                  </td>
                </tr>
              ) : (
                filteredPublicIps.map((ip) => {
                  const isRowEdit = editingIp === ip.address;
                  return (
                    <tr
                      key={ip.address}
                      className="border-b border-[var(--card-border)] last:border-0"
                    >
                      <td className="px-3 py-2 font-mono text-xs">{ip.address}</td>
                      <td className="px-3 py-2">
                        {isRowEdit && ipDraft ? (
                          <select
                            value={ipDraft.status}
                            onChange={(e) =>
                              setIpDraft((d) =>
                                d ? { ...d, status: e.target.value } : d
                              )
                            }
                            className="w-full min-w-[8rem] rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-xs"
                          >
                            <option value="available">available</option>
                            <option value="assigned">assigned</option>
                            <option value="reserved">reserved</option>
                          </select>
                        ) : (
                          <span
                            className={
                              ip.status === "available"
                                ? "text-green-400"
                                : ip.status === "assigned"
                                  ? "text-[var(--accent)]"
                                  : "text-yellow-400"
                            }
                          >
                            {ip.status}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isRowEdit && ipDraft ? (
                          <input
                            type="text"
                            value={ipDraft.orderId}
                            onChange={(e) =>
                              setIpDraft((d) =>
                                d ? { ...d, orderId: e.target.value } : d
                              )
                            }
                            placeholder="order id"
                            className="w-full min-w-[6rem] rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 font-mono text-xs"
                          />
                        ) : (
                          <span className="font-mono text-xs text-[var(--muted)]">
                            {ip.orderId || "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isRowEdit && ipDraft ? (
                          <input
                            type="text"
                            value={ipDraft.userId}
                            onChange={(e) =>
                              setIpDraft((d) =>
                                d ? { ...d, userId: e.target.value } : d
                              )
                            }
                            placeholder="DeSo public key"
                            className="w-full min-w-[8rem] rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 font-mono text-xs"
                          />
                        ) : (
                          <span className="font-mono text-xs text-[var(--muted)]">
                            {ip.userId ? `${ip.userId.slice(0, 14)}…` : "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isRowEdit && ipDraft ? (
                          <input
                            type="number"
                            min={0}
                            value={ipDraft.vmid}
                            onChange={(e) =>
                              setIpDraft((d) =>
                                d ? { ...d, vmid: e.target.value } : d
                              )
                            }
                            placeholder="vmid"
                            className="w-20 rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-xs"
                          />
                        ) : (
                          <span className="tabular-nums">
                            {ip.vmid != null && ip.vmid > 0 ? ip.vmid : "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isRowEdit ? (
                          <div className="flex flex-wrap gap-1">
                            <button
                              type="button"
                              disabled={ipSaving === ip.address}
                              onClick={async () => {
                                if (!user || !ipDraft) return;
                                setPublicIpError(null);
                                setIpSaving(ip.address);
                                try {
                                  const res = await apiFetch(
                                    "/api/admin/public-ips",
                                    {
                                      method: "PATCH",
                                      headers: {
                                        "Content-Type": "application/json",
                                      },
                                      body: JSON.stringify({
                                        address: ip.address,
                                        status: ipDraft.status,
                                        orderId: ipDraft.orderId.trim(),
                                        userId: ipDraft.userId.trim(),
                                        vmid:
                                          ipDraft.vmid.trim() === ""
                                            ? null
                                            : ipDraft.vmid,
                                      }),
                                    }
                                  );
                                  const data = await res.json().catch(() => ({}));
                                  if (!res.ok) {
                                    setPublicIpError(
                                      typeof data.error === "string"
                                        ? data.error
                                        : "Update failed"
                                    );
                                    return;
                                  }
                                  setEditingIp(null);
                                  setIpDraft(null);
                                  loadData();
                                } finally {
                                  setIpSaving(null);
                                }
                              }}
                              className="rounded bg-[var(--accent)] px-2 py-1 text-xs font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
                            >
                              {ipSaving === ip.address ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              disabled={ipSaving === ip.address}
                              onClick={() => {
                                setEditingIp(null);
                                setIpDraft(null);
                                setPublicIpError(null);
                              }}
                              className="rounded border border-[var(--card-border)] px-2 py-1 text-xs hover:bg-[var(--card)]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingIp(ip.address);
                              setIpDraft({
                                status: ip.status || "available",
                                orderId: ip.orderId ?? "",
                                userId: ip.userId ?? "",
                                vmid:
                                  ip.vmid != null && ip.vmid > 0
                                    ? String(ip.vmid)
                                    : "",
                              });
                              setPublicIpError(null);
                            }}
                            className="rounded border border-[var(--card-border)] px-2 py-1 text-xs hover:bg-[var(--card)]"
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Orders */}
      <section className="mt-16">
        <h2 className="text-xl font-semibold">Orders</h2>
        {provisionError && (
          <div className="mt-4 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm text-red-400">
            {provisionError}
            <button
              onClick={() => setProvisionError(null)}
              className="ml-2 underline"
            >
              Dismiss
            </button>
          </div>
        )}
        <p className="mt-2 text-xs text-[var(--muted)]">
          Cancelled orders are hidden by default. Choose &quot;All statuses&quot; in the status
          filter to include cancelled rows, or choose &quot;cancelled&quot; to show only those.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[var(--muted)]">
            Showing {filteredOrders.length} of {orders.length} orders
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {orderFiltersActive && (
              <button
                type="button"
                onClick={clearOrderFilters}
                className="rounded-lg border border-[var(--card-border)] px-3 py-1.5 text-xs hover:bg-[var(--card)]"
              >
                Clear filters
              </button>
            )}
            <button
              type="button"
              onClick={() => setOrderFiltersOpen((v) => !v)}
              aria-expanded={orderFiltersOpen}
              aria-controls="orders-filter-fields"
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--card-border)] bg-[var(--card)]/30 px-3 py-1.5 text-xs font-medium hover:bg-[var(--card)]"
            >
              <span className="text-[10px] text-[var(--muted)]" aria-hidden>
                {orderFiltersOpen ? "▼" : "▶"}
              </span>
              Filters
              {orderFiltersActive && (
                <span className="rounded-full bg-[var(--accent)]/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                  Active
                </span>
              )}
            </button>
          </div>
        </div>
        <div className="mt-2 max-h-[31rem] overflow-auto rounded-2xl border border-[var(--card-border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--card)] shadow-[0_1px_0_var(--card-border)]">
              <tr>
                <th className="px-3 py-3 text-left font-medium">Order</th>
                <th className="px-3 py-3 text-left font-medium">User</th>
                <th className="px-3 py-3 text-left font-medium">VMID</th>
                <th className="px-3 py-3 text-left font-medium">Public IP</th>
                <th className="px-3 py-3 text-left font-medium">Node</th>
                <th className="px-3 py-3 text-left font-medium">Status</th>
                <th className="px-3 py-3 text-left font-medium">Actions</th>
              </tr>
              {orderFiltersOpen && (
                <tr
                  id="orders-filter-fields"
                  className="border-b border-[var(--card-border)]"
                >
                  <th className="px-3 py-2 align-bottom font-normal">
                    <label className="sr-only" htmlFor="order-filter-order-id">
                      Filter by order ID
                    </label>
                    <input
                      id="order-filter-order-id"
                      type="text"
                      value={orderFilterOrderId}
                      onChange={(e) => setOrderFilterOrderId(e.target.value)}
                      placeholder="Order ID"
                      className="w-full min-w-[6rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs placeholder:font-sans"
                      aria-label="Filter by order ID substring"
                    />
                  </th>
                  <th className="px-3 py-2 align-bottom font-normal">
                    <label className="sr-only" htmlFor="order-filter-user-id">
                      Filter by user public key
                    </label>
                    <input
                      id="order-filter-user-id"
                      type="text"
                      value={orderFilterUserId}
                      onChange={(e) => setOrderFilterUserId(e.target.value)}
                      placeholder="Public key"
                      className="w-full min-w-[6rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs placeholder:font-sans"
                      aria-label="Filter by user public key substring"
                    />
                  </th>
                  <th className="px-3 py-2 align-bottom font-normal">
                    <label className="sr-only" htmlFor="order-filter-vmid">
                      Filter by VMID
                    </label>
                    <input
                      id="order-filter-vmid"
                      type="text"
                      inputMode="numeric"
                      value={orderFilterVmid}
                      onChange={(e) => setOrderFilterVmid(e.target.value)}
                      placeholder="VMID"
                      className="w-full min-w-[3.5rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs tabular-nums placeholder:font-sans"
                      aria-label="Filter by VMID substring"
                    />
                  </th>
                  <th className="px-3 py-2 align-bottom font-normal">
                    <label className="sr-only" htmlFor="order-filter-public-ip">
                      Filter by public IP
                    </label>
                    <input
                      id="order-filter-public-ip"
                      type="text"
                      value={orderFilterPublicIp}
                      onChange={(e) => setOrderFilterPublicIp(e.target.value)}
                      placeholder="Public IP"
                      className="w-full min-w-[6rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 font-mono text-xs placeholder:font-sans"
                      aria-label="Filter by public IP substring"
                    />
                  </th>
                  <th className="px-3 py-2 align-bottom font-normal">
                    <label className="sr-only" htmlFor="order-filter-node">
                      Filter by node
                    </label>
                    <input
                      id="order-filter-node"
                      type="text"
                      value={orderFilterNode}
                      onChange={(e) => setOrderFilterNode(e.target.value)}
                      placeholder="Node"
                      className="w-full min-w-[4rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 text-xs placeholder:font-sans"
                      aria-label="Filter by node substring"
                    />
                  </th>
                  <th className="px-3 py-2 align-bottom font-normal">
                    <label className="sr-only" htmlFor="order-filter-status">
                      Filter by status
                    </label>
                    <select
                      id="order-filter-status"
                      value={orderFilterStatus}
                      onChange={(e) => setOrderFilterStatus(e.target.value)}
                      className="w-full min-w-[9rem] rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-2 py-1.5 text-xs"
                      aria-label="Filter by order status"
                    >
                      <option value="">All (hide cancelled)</option>
                      <option value="all">All statuses</option>
                      <option value="pending">pending</option>
                      <option value="provisioning">provisioning</option>
                      <option value="active">active</option>
                      <option value="suspended">suspended</option>
                      <option value="cancelled">cancelled</option>
                    </select>
                  </th>
                  <th className="px-3 py-2 align-bottom font-normal" aria-hidden />
                </tr>
              )}
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--muted)]">
                    No orders.
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--muted)]">
                    No orders match the current filters.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-[var(--card-border)] last:border-0"
                  >
                    <td className="px-3 py-3 font-mono text-xs">
                      <button
                        type="button"
                        onClick={(e) => void copyOrderAdminField(o.id, "order ID", e)}
                        className="max-w-full cursor-pointer truncate text-left underline-offset-2 hover:underline"
                        title="Copy full order ID"
                      >
                        {o.id.slice(0, 8)}...
                      </button>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">
                      <button
                        type="button"
                        onClick={(e) =>
                          void copyOrderAdminField(o.userId, "user public key", e)
                        }
                        className="max-w-full cursor-pointer truncate text-left underline-offset-2 hover:underline"
                        title="Copy full user public key"
                      >
                        {o.userId.slice(0, 12)}...
                      </button>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      {o.vmid > 0 ? (
                        <button
                          type="button"
                          onClick={(e) =>
                            void copyOrderAdminField(String(o.vmid), "VMID", e)
                          }
                          className="cursor-pointer underline-offset-2 hover:underline"
                          title="Copy VMID"
                        >
                          {o.vmid}
                        </button>
                      ) : (
                        <span className="text-[var(--muted)]">-</span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">
                      {o.publicIpv4?.trim() ? (
                        <button
                          type="button"
                          onClick={(e) =>
                            void copyOrderAdminField(
                              o.publicIpv4!,
                              "public IP",
                              e
                            )
                          }
                          className="max-w-full cursor-pointer truncate text-left underline-offset-2 hover:underline"
                          title="Copy public IP"
                        >
                          {o.publicIpv4}
                        </button>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {o.node?.trim() ? (
                        <button
                          type="button"
                          onClick={(e) =>
                            void copyOrderAdminField(o.node, "node name", e)
                          }
                          className="max-w-full cursor-pointer truncate text-left underline-offset-2 hover:underline"
                          title="Copy Proxmox node name"
                        >
                          {o.node}
                        </button>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={
                          o.status === "active"
                            ? "text-green-400"
                            : o.status === "pending"
                              ? "text-yellow-400"
                              : o.status === "provisioning"
                                ? "text-orange-400"
                                : o.status === "suspended"
                                  ? "text-amber-400"
                                  : o.status === "cancelled"
                                    ? "text-red-400"
                                    : ""
                        }
                      >
                        {o.status}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                      {(o.status === "pending" || o.status === "provisioning") && (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="number"
                            placeholder="VMID"
                            value={provisionVmid[o.id] || ""}
                            onChange={(e) =>
                              setProvisionVmid((p) => ({
                                ...p,
                                [o.id]: e.target.value,
                              }))
                            }
                            className="w-20 rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-xs"
                          />
                          <input
                            type="text"
                            placeholder="Node"
                            value={provisionNode[o.id] || o.node || ""}
                            onChange={(e) =>
                              setProvisionNode((p) => ({
                                ...p,
                                [o.id]: e.target.value,
                              }))
                            }
                            className="w-24 rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => handleProvision(o.id)}
                            disabled={provisioning === o.id}
                            className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
                          >
                            {provisioning === o.id ? "..." : "Provision"}
                          </button>
                        </div>
                      )}
                      {o.status === "active" && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (
                              !user ||
                              !confirm(
                                "Shut down this VM (ACPI) and mark the order suspended? The customer loses power/console until renewal or you resume."
                              )
                            ) {
                              return;
                            }
                            setProvisionError(null);
                            setOrderSuspendBusy(o.id);
                            try {
                              const res = await apiFetch("/api/admin/suspend-order", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  orderId: o.id,
                                }),
                              });
                              const data = await res.json().catch(() => ({}));
                              if (!res.ok) {
                                setProvisionError(
                                  typeof data.error === "string"
                                    ? data.error
                                    : "Suspend failed"
                                );
                                return;
                              }
                              loadData();
                            } finally {
                              setOrderSuspendBusy(null);
                            }
                          }}
                          disabled={
                            orderSuspendBusy === o.id || provisioning === o.id
                          }
                          className="rounded border border-amber-500/50 px-2 py-1 text-xs text-amber-400 hover:bg-amber-500/10 disabled:opacity-50"
                        >
                          {orderSuspendBusy === o.id ? "..." : "Suspend"}
                        </button>
                      )}
                      {o.status === "suspended" && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (
                              !user ||
                              !confirm(
                                "Mark this order active and start the VM (if it is provisioned)? Billing status is unchanged."
                              )
                            ) {
                              return;
                            }
                            setProvisionError(null);
                            setOrderSuspendBusy(o.id);
                            try {
                              const res = await apiFetch("/api/admin/resume-order", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  orderId: o.id,
                                }),
                              });
                              const data = await res.json().catch(() => ({}));
                              if (!res.ok) {
                                setProvisionError(
                                  typeof data.error === "string"
                                    ? data.error
                                    : "Resume failed"
                                );
                                return;
                              }
                              loadData();
                            } finally {
                              setOrderSuspendBusy(null);
                            }
                          }}
                          disabled={orderSuspendBusy === o.id}
                          className="rounded border border-green-500/50 px-2 py-1 text-xs text-green-400 hover:bg-green-500/10 disabled:opacity-50"
                        >
                          {orderSuspendBusy === o.id ? "..." : "Resume"}
                        </button>
                      )}
                      {(o.status === "active" ||
                        o.status === "pending" ||
                        o.status === "provisioning" ||
                        o.status === "suspended") && (
                        <button
                          type="button"
                          onClick={() => {
                            if (!user) return;
                            adminDeleteOrderRef.current = o.id;
                            adminDeleteDialogRef.current?.showModal();
                          }}
                          className="rounded border border-red-500/50 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {user ? (
        <DeleteVpsConfirmationDialog
          dialogRef={adminDeleteDialogRef}
          orderIdRef={adminDeleteOrderRef}
          userPublicKey={user.publicKey}
          isAdmin
          onSuccess={() => {
            adminDeleteOrderRef.current = null;
            loadData();
          }}
          onDismiss={() => {
            adminDeleteOrderRef.current = null;
          }}
        />
      ) : null}

      {orderCopyToast ? (
        <div
          role="status"
          aria-live="polite"
          className={
            orderCopyToast.isError
              ? "pointer-events-none fixed z-[10000] max-w-[18rem] rounded-lg border border-red-500/35 bg-[var(--card)] px-2.5 py-1.5 text-xs text-red-400 shadow-lg"
              : "pointer-events-none fixed z-[10000] max-w-[18rem] rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-2.5 py-1.5 text-xs text-green-400 shadow-lg"
          }
          style={{
            left: orderCopyToast.x + 12,
            top: orderCopyToast.y + 12,
          }}
        >
          {orderCopyToast.message}
        </div>
      ) : null}
    </div>
  );
}

interface PublicIpPoolConfigState {
  gateway?: string;
  prefixLen?: number;
  dns?: string;
  updatedAt?: string;
}

function PublicIpPoolConfigPanel({ publicKey }: { publicKey: string }) {
  const [config, setConfig] = useState<PublicIpPoolConfigState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [gateway, setGateway] = useState("");
  const [prefixLen, setPrefixLen] = useState("");
  const [dns, setDns] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/api/admin/public-ips/config`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.error || `Request failed (${r.status})`);
        return data as PublicIpPoolConfigState;
      })
      .then((data) => {
        if (cancelled) return;
        setConfig(data);
        setGateway(data.gateway ?? "");
        setPrefixLen(
          data.prefixLen != null ? String(data.prefixLen) : ""
        );
        setDns(data.dns ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  async function save() {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const body: Record<string, unknown> = {
        gateway: gateway.trim() || null,
        dns: dns.trim() || null,
      };
      const trimmedPrefix = prefixLen.trim();
      body.prefixLen = trimmedPrefix === "" ? null : Number(trimmedPrefix);

      const res = await apiFetch("/api/admin/public-ips/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
      const next = data as PublicIpPoolConfigState;
      setConfig(next);
      setGateway(next.gateway ?? "");
      setPrefixLen(next.prefixLen != null ? String(next.prefixLen) : "");
      setDns(next.dns ?? "");
      setSavedAt(next.updatedAt ?? new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-[var(--card-border)] bg-[var(--card)]/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Pool routing config</h3>
        <span className="text-xs text-[var(--muted)]">
          Firestore <code className="rounded bg-[var(--background)] px-1">public_ips_config/default</code>
        </span>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Cloud-init <code className="rounded bg-[var(--background)] px-1">ipconfig0</code> needs
        a gateway. Without one, allocation is skipped even when addresses exist in the pool.
        Env vars (PUBLIC_IP_GATEWAY / PUBLIC_IP_PREFIX_LEN / PUBLIC_IP_DNS) are still honored as
        a fallback when these fields are blank.
      </p>
      {loading ? (
        <p className="mt-3 text-xs text-[var(--muted)]">Loading…</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-xs text-[var(--muted)]">Gateway (IPv4)</label>
            <input
              type="text"
              value={gateway}
              onChange={(e) => setGateway(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm font-mono"
              placeholder="68.122.49.254"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)]">Prefix length</label>
            <input
              type="number"
              min={0}
              max={32}
              value={prefixLen}
              onChange={(e) => setPrefixLen(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm font-mono"
              placeholder="32"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--muted)]">DNS (comma-separated)</label>
            <input
              type="text"
              value={dns}
              onChange={(e) => setDns(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm font-mono"
              placeholder="1.1.1.1,8.8.8.8"
            />
          </div>
        </div>
      )}
      {error && (
        <p className="mt-3 text-xs text-red-400">{error}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || loading}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save config"}
        </button>
        {savedAt && (
          <span className="text-xs text-green-400">
            Saved {new Date(savedAt).toLocaleString()}
          </span>
        )}
        {!savedAt && config?.updatedAt && (
          <span className="text-xs text-[var(--muted)]">
            Last updated {new Date(config.updatedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}
