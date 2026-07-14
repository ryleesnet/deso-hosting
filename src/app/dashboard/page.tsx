"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";
import {
  VPSControl,
  type VmPowerControlAction,
} from "@/components/VPSControl";
import { VMProxmoxTitle } from "@/components/VMProxmoxTitle";
import { VMRunningStatus } from "@/components/VMRunningStatus";
import { DangerZoneCollapsible } from "@/components/DangerZoneCollapsible";
import { CancelVpsButton } from "@/components/CancelVpsButton";
import { OrderSpecsSummary } from "@/components/OrderSpecsSummary";
import { BillingCycleSummary, type BillingInfo } from "@/components/BillingCycleSummary";
import { VmBootstrapCredentials } from "@/components/VmBootstrapCredentials";
import { RenewSubscriptionPanel } from "@/components/RenewSubscriptionPanel";
import { BulkRenewPanel } from "@/components/BulkRenewPanel";
import { ReinstallVpsButton } from "@/components/ReinstallVpsButton";
import { PrivateUserLanPanel } from "@/components/PrivateUserLanPanel";
import { ChangeVpsPlanPanel } from "@/components/ChangeVpsPlanPanel";
import { ExtraDataDisksPanel } from "@/components/ExtraDataDisksPanel";
import { apiFetch } from "@/lib/api-client";
import {
  displayCloneImageSummary,
  effectiveTemplatesForOrder,
} from "@/lib/image-profiles";

interface Order {
  id: string;
  serviceId: string;
  vmid: number;
  node: string;
  status: string;
  createdAt: string;
  billing: BillingInfo | null;
  vmLoginUsername?: string;
  vmLoginPassword?: string;
  extraDisksGb?: number[];
  publicIpv4?: string;
  /** Last failure from the auto-provision/configure flow (clone, hardware, cloud-init). */
  provisionError?: string;
  /** True while halt/resize for catalogue plan upgrade or downgrade runs in the background. */
  adjustingPlan?: boolean;
  /** True while extra disk attach/detach runs. */
  hardwareMaintenance?: boolean;
  /** True while a backup restore runs. */
  backupRestoreInProgress?: boolean;
  /** authorized_keys lines currently installed via cloud-init (server-side state). */
  cloudInitSshKeys?: string;
  cloneTemplateVmid?: number;
  cloneImageProfileId?: string;
  imageProfiles?: { id: string; label: string; templateVmid: number }[];
  privateLanEnabled?: boolean;
  privateLanVlan?: number;
  privateLanIp?: string;
}

interface Service {
  id: string;
  name: string;
  vcpu: number;
  ram: number;
  storage: number;
  priceUsdCents: number;
  pricePreviewNanos?: number;
  priceNanos?: number;
  proxmoxTemplate?: number;
  imageProfiles?: { id: string; label: string; templateVmid: number }[];
}

type HostedCatalogProfile = {
  id: string;
  label: string;
  templateVmid: number;
};

function DashboardSection({
  title,
  titleId,
  children,
}: {
  title: string;
  titleId: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={titleId} className="min-w-0">
      <h2
        id={titleId}
        className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]"
      >
        {title}
      </h2>
      <div className="mt-2 rounded-xl border border-[var(--card-border)] bg-[var(--card)]/30 p-4 sm:p-4">
        {children}
      </div>
    </section>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [services, setServices] = useState<Record<string, Service>>({});
  const [hostedOsTemplates, setHostedOsTemplates] = useState<HostedCatalogProfile[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  /** VM orderId → power action in progress (syncs status pill with controls). */
  const [vmPowerPendingByOrder, setVmPowerPendingByOrder] = useState<
    Partial<Record<string, VmPowerControlAction>>
  >({});
  const [retryingOrder, setRetryingOrder] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<Record<string, string>>({});

  async function handleRetryProvision(orderId: string) {
    if (!user) return;
    setRetryingOrder(orderId);
    setRetryError((prev) => {
      const next = { ...prev };
      delete next[orderId];
      return next;
    });
    try {
      const res = await apiFetch(`/api/orders/${orderId}/retry-provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Retry failed (${res.status})`);
      }
      loadData();
    } catch (e) {
      setRetryError((prev) => ({
        ...prev,
        [orderId]: e instanceof Error ? e.message : "Retry failed",
      }));
    } finally {
      setRetryingOrder(null);
    }
  }

  const loadOrdersOnly = useCallback(() => {
    if (!user) return;
    apiFetch(`/api/orders`)
      .then((r) => r.json())
      .then((ordersData) => {
        const list = Array.isArray(ordersData) ? ordersData : [];
        setOrders(
          list.map((o: Order & { billing?: BillingInfo | null }) => ({
            ...o,
            billing: o.billing ?? null,
          }))
        );
      })
      .catch((err) => {
        console.error("[dashboard] loadOrdersOnly failed", err);
      });
  }, [user]);

  const loadData = useCallback(() => {
    if (!user) return;
    Promise.all([
      apiFetch(`/api/orders`).then((r) => r.json()),
      fetch("/api/services").then((r) => r.json()),
      fetch("/api/os-templates")
        .then((r) => r.json())
        .catch(() => ({})),
    ])
      .then(([ordersData, servicesData, osTplData]) => {
        const list = Array.isArray(ordersData) ? ordersData : [];
        setOrders(
          list.map((o: Order & { billing?: BillingInfo | null }) => ({
            ...o,
            billing: o.billing ?? null,
          }))
        );
        const map: Record<string, Service> = {};
        (Array.isArray(servicesData) ? servicesData : []).forEach((s: Service) => {
          map[s.id] = s;
        });
        setServices(map);
        const pg = (
          osTplData as { profiles?: HostedCatalogProfile[] } | undefined
        )?.profiles;
        setHostedOsTemplates(Array.isArray(pg) ? pg : []);
      })
      .catch((err) => {
        console.error("[dashboard] loadData failed", err);
      })
      .finally(() => setLoading(false));
  }, [user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const hasProvisioningOrder = orders.some((o) => o.status === "provisioning");
  const hasAsyncVmMaintenance = orders.some(
    (o) => o.adjustingPlan || o.hardwareMaintenance || o.backupRestoreInProgress
  );

  useEffect(() => {
    if (!user || !(hasProvisioningOrder || hasAsyncVmMaintenance)) return;
    const t = setInterval(() => loadOrdersOnly(), 3000);
    return () => clearInterval(t);
  }, [user, hasProvisioningOrder, hasAsyncVmMaintenance, loadOrdersOnly]);

  if (!user) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center">
        <p className="text-[var(--muted)]">Please log in to view your dashboard.</p>
        <Link href="/" className="mt-4 inline-block text-[var(--accent)] hover:underline">
          Go Home
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
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <header className="flex flex-col gap-2 border-b border-[var(--card-border)] pb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          Dashboard
        </h1>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-sm text-[var(--muted)]">
            Power, sizing, SSH, and renewal for each server below.
          </p>
          {(hasProvisioningOrder || hasAsyncVmMaintenance) ? (
            <p
              className="rounded-lg border border-orange-500/25 bg-orange-500/10 px-3 py-2 text-xs text-orange-300 sm:max-w-sm sm:text-start"
              role="status"
              aria-live="polite"
            >
              {hasProvisioningOrder && !hasAsyncVmMaintenance
                ? "Provisioning in progress — list refreshes every few seconds."
                : hasProvisioningOrder && hasAsyncVmMaintenance
                  ? "Provisioning or hardware changes running — list refreshes every few seconds."
                  : "Hardware change running (plan resize, disks, or backup restore) — VM may be off briefly."}
            </p>
          ) : null}
        </div>
      </header>

      {orders.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-[var(--card-border)] bg-[var(--card)]/25 px-8 py-14 text-center">
          <p className="text-sm text-[var(--muted)]">You don&apos;t have any VPS yet.</p>
          <Link
            href="/services"
            className="mt-6 inline-flex items-center justify-center rounded-lg bg-[var(--accent)] px-6 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)]"
          >
            Browse plans
          </Link>
        </div>
      ) : (
        <>
          <BulkRenewPanel
            orders={orders
              .filter((o) => o.status !== "cancelled")
              .map((o) => ({
                orderId: o.id,
                serviceName:
                  services[o.serviceId]?.name ?? `Plan ${o.serviceId.slice(0, 8)}…`,
                vmid: o.vmid,
                status: o.status,
                subscriptionStatus:
                  o.billing?.subscriptionStatus ?? "unknown",
                nextPaymentAt: o.billing?.nextPaymentAt,
              }))}
            onSuccess={loadData}
          />
        <div className="mt-8 space-y-8">
          {orders
            .filter((o) => o.status !== "cancelled")
            .map((order) => {
              const catalog = services[order.serviceId];
              const vmLocked =
                !!order.adjustingPlan ||
                !!order.hardwareMaintenance ||
                !!order.backupRestoreInProgress;
              const reinstallProfiles = effectiveTemplatesForOrder(
                order,
                catalog ?? {},
                hostedOsTemplates
              );
              const osImageSummary = displayCloneImageSummary(
                order,
                catalog,
                hostedOsTemplates
              );
              return (
                <article
                  key={order.id}
                  className="overflow-hidden rounded-2xl border border-[var(--card-border)] bg-[var(--card)] shadow-[0_20px_50px_-32px_rgba(0,0,0,0.55)]"
                >
                  {order.status === "pending" && order.vmid > 0 ? (
                    <div className="border-b border-yellow-500/25 bg-yellow-500/5 px-4 py-3 sm:px-6">
                      <p className="text-sm font-medium text-yellow-200">
                        Post-clone setup didn&apos;t finish for this VPS.
                      </p>
                      {order.provisionError ? (
                        <p className="mt-1 break-all font-mono text-xs text-yellow-200/75">
                          {order.provisionError}
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-yellow-100/65">
                        Retry applies CPU/memory, credentials, and extra disks — no full re-clone.
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleRetryProvision(order.id)}
                          disabled={retryingOrder === order.id}
                          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50 sm:text-sm"
                        >
                          {retryingOrder === order.id ? "Retrying…" : "Retry provisioning"}
                        </button>
                      </div>
                      {retryError[order.id] ? (
                        <p className="mt-2 break-all text-xs text-red-400">{retryError[order.id]}</p>
                      ) : null}
                    </div>
                  ) : null}

                  {order.status === "pending" && order.vmid <= 0 ? (
                    <div className="border-b border-yellow-500/20 bg-yellow-500/5 px-4 py-3 sm:px-6">
                      <p className="text-sm text-yellow-200/95">
                        Order pending — provisioning will attach a VM shortly.
                      </p>
                    </div>
                  ) : null}

                  {order.status === "provisioning" ? (
                    <div className="border-b border-orange-500/25 bg-orange-500/10 px-4 py-2.5 sm:px-6">
                      <p className="text-xs text-orange-200 sm:text-sm">
                        Creating your VM (clone &amp; hardware). Controls appear when provisioning finishes.
                      </p>
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 sm:pb-5 sm:pt-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">
                          <VMProxmoxTitle orderId={order.id} vmid={order.vmid} />
                        </h2>
                        <p className="text-xs text-[var(--muted)]">
                          {catalog?.name ?? `Plan ${order.serviceId.slice(0, 8)}…`}
                          {order.createdAt ? (
                            <span className="text-[var(--muted)]/80">
                              {" "}
                              · Ordered{" "}
                              {(() => {
                                try {
                                  return new Date(order.createdAt).toLocaleDateString(undefined, {
                                    year: "numeric",
                                    month: "short",
                                    day: "numeric",
                                  });
                                } catch {
                                  return "";
                                }
                              })()}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        {order.adjustingPlan ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-400/35 bg-orange-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-200">
                            <span
                              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400"
                              aria-hidden
                            />
                            Resizing plan
                          </span>
                        ) : order.backupRestoreInProgress ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-400/35 bg-orange-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-200">
                            <span
                              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400"
                              aria-hidden
                            />
                            Restoring backup
                          </span>
                        ) : order.hardwareMaintenance ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-400/35 bg-orange-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-200">
                            <span
                              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400"
                              aria-hidden
                            />
                            Disks
                          </span>
                        ) : null}
                        {order.status === "provisioning" ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-400/35 bg-orange-400/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-200">
                            <span
                              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400"
                              aria-hidden
                            />
                            Provisioning
                          </span>
                        ) : null}
                        {order.status === "active" &&
                        order.billing?.subscriptionStatus === "past_due" ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-orange-200">
                            <span
                              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-orange-400"
                              aria-hidden
                            />
                            Past due
                          </span>
                        ) : null}
                        {order.status === "suspended" ? (
                          <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-100">
                            Suspended — renew required
                          </span>
                        ) : null}
                        {(order.status === "active" || order.status === "suspended") &&
                        order.vmid > 0 ? (
                          <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-[var(--card-border)] bg-[var(--background)]/35 px-2.5 py-1">
                            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
                              Guest power
                            </span>
                            <VMRunningStatus
                              orderId={order.id}
                              size="default"
                              pendingPowerAction={vmPowerPendingByOrder[order.id]}
                              onPendingPowerSynced={() => {
                                setVmPowerPendingByOrder((prev) => {
                                  if (!prev[order.id]) return prev;
                                  const next = { ...prev };
                                  delete next[order.id];
                                  return next;
                                });
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-6 border-t border-[var(--card-border)] px-4 py-5 sm:px-6 lg:grid-cols-12 lg:gap-8 lg:pb-6">
                    <div className="min-w-0 space-y-5 lg:col-span-8">
                      <DashboardSection title="Hardware & plan" titleId={`${order.id}-specs`}>
                        <OrderSpecsSummary
                          orderId={order.id}
                          catalogServiceId={order.serviceId}
                          adjustingPlan={!!order.adjustingPlan}
                          hardwareMaintenance={!!order.hardwareMaintenance}
                          backupRestoreInProgress={!!order.backupRestoreInProgress}
                          listClassName="mt-0 flex flex-row flex-wrap gap-x-5 gap-y-2 md:gap-x-8"
                          extrasFingerprint={(order.extraDisksGb ?? []).join(",")}
                          plan={services[order.serviceId]}
                        />
                        {osImageSummary ? (
                          <p className="mt-2 text-xs text-[var(--muted)] leading-relaxed">
                            <span className="font-medium text-[var(--foreground)]">OS image:</span>{" "}
                            {osImageSummary}
                          </p>
                        ) : null}
                        {order.status === "active" && order.vmid > 0 ? (
                          <ChangeVpsPlanPanel
                            orderId={order.id}
                            currentServiceId={order.serviceId}
                            servicesById={services}
                            adjustingPlan={!!order.adjustingPlan}
                            hardwareMaintenance={!!order.hardwareMaintenance}
                            backupRestoreInProgress={!!order.backupRestoreInProgress}
                            lastError={order.provisionError}
                            embedded
                            disabled={
                              !!vmPowerPendingByOrder[order.id] || vmLocked
                            }
                            onScheduled={loadOrdersOnly}
                          />
                        ) : null}
                        {order.status === "active" && order.vmid > 0 ? (
                          <ExtraDataDisksPanel
                            orderId={order.id}
                            extraDisksGb={order.extraDisksGb}
                            adjustingPlan={!!order.adjustingPlan}
                            hardwareMaintenance={!!order.hardwareMaintenance}
                            backupRestoreInProgress={!!order.backupRestoreInProgress}
                            disabled={!!vmPowerPendingByOrder[order.id]}
                            onScheduled={loadOrdersOnly}
                          />
                        ) : null}
                      </DashboardSection>

                      <PrivateUserLanPanel
                          orderId={order.id}
                          enabled={order.privateLanEnabled}
                          ip={order.privateLanIp}
                          canEdit={
                            (order.status === "active" || order.status === "suspended") &&
                            order.vmid > 0
                          }
                          onChange={loadData}
                          className="mt-0"
                        />

                      <DashboardSection
                        title="Billing & renewal"
                        titleId={`${order.id}-billing`}
                      >
                        <BillingCycleSummary billing={order.billing} className="mt-0" />
                        {order.billing &&
                          (order.status === "active" || order.status === "suspended") &&
                          order.vmid > 0 && (
                            <RenewSubscriptionPanel
                              orderId={order.id}
                              userPublicKey={user.publicKey}
                              onSuccess={loadData}
                            />
                          )}
                      </DashboardSection>
                    </div>

                    <aside
                      aria-labelledby={
                        order.status === "active" ||
                        order.status === "pending" ||
                        order.status === "provisioning" ||
                        order.status === "suspended"
                          ? `${order.id}-actions ${order.id}-access`
                          : `${order.id}-access`
                      }
                      className="flex min-w-0 flex-col gap-5 lg:col-span-4"
                    >
                      {(order.status === "active" ||
                        order.status === "pending" ||
                        order.status === "provisioning" ||
                        order.status === "suspended") ? (
                        <DashboardSection title="Server actions" titleId={`${order.id}-actions`}>
                          {order.status === "suspended" ? (
                            <p className="mb-3 text-xs text-amber-400/95">
                              Shown after unpaid period — renew to re-enable guest power and console
                              from controls.
                            </p>
                          ) : null}
                          <div className="flex w-full min-w-0 flex-col gap-3">
                            {order.status === "active" && order.vmid > 0 ? (
                              <VPSControl
                                orderId={order.id}
                                powerLocked={vmLocked}
                                powerLockedTitle={
                                  order.adjustingPlan && order.hardwareMaintenance
                                    ? "VM maintenance in progress."
                                    : order.backupRestoreInProgress
                                      ? "Backup restore in progress."
                                      : order.hardwareMaintenance
                                        ? "Disk maintenance in progress."
                                        : "Plan change in progress."
                                }
                                onBackupRestoreStarted={loadData}
                                onPowerFlowPending={(pending) => {
                                  setVmPowerPendingByOrder((prev) => {
                                    const next = { ...prev };
                                    if (pending == null) delete next[order.id];
                                    else next[order.id] = pending;
                                    return next;
                                  });
                                }}
                                deleteButton={
                                  <>
                                    <div className="min-w-0">
                                      <ReinstallVpsButton
                                        orderId={order.id}
                                        profiles={reinstallProfiles}
                                        orderProfileId={order.cloneImageProfileId}
                                        orderTemplateVmid={order.cloneTemplateVmid}
                                        onStarted={loadData}
                                        disabled={
                                          !!vmPowerPendingByOrder[order.id] ||
                                          vmLocked
                                        }
                                        fillCell
                                      />
                                    </div>
                                    <div className="min-w-0">
                                      <CancelVpsButton
                                        orderId={order.id}
                                        shouldCheckPower
                                        userPublicKey={user.publicKey}
                                        onSuccess={loadData}
                                        operationBlocked={vmLocked}
                                        fillCell
                                      />
                                    </div>
                                  </>
                                }
                              />
                            ) : (
                              <DangerZoneCollapsible>
                                <div className="flex flex-wrap items-center gap-2">
                                  {(order.status === "active" ||
                                    order.status === "suspended") &&
                                  order.vmid > 0 ? (
                                    <ReinstallVpsButton
                                      orderId={order.id}
                                      profiles={reinstallProfiles}
                                      orderProfileId={order.cloneImageProfileId}
                                      orderTemplateVmid={order.cloneTemplateVmid}
                                      onStarted={loadData}
                                      disabled={
                                        !!vmPowerPendingByOrder[order.id] ||
                                        vmLocked
                                      }
                                    />
                                  ) : null}
                                  <CancelVpsButton
                                    orderId={order.id}
                                    shouldCheckPower={
                                      order.status === "active" && order.vmid > 0
                                    }
                                    userPublicKey={user.publicKey}
                                    onSuccess={loadData}
                                    operationBlocked={
                                      order.status === "active" && vmLocked
                                    }
                                  />
                                </div>
                              </DangerZoneCollapsible>
                            )}
                          </div>
                        </DashboardSection>
                      ) : null}

                      <div className="min-w-0">
                        <h2
                          id={`${order.id}-access`}
                          className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]"
                        >
                          Access &amp; SSH
                        </h2>
                        <VmBootstrapCredentials
                          username={order.vmLoginUsername}
                          password={order.vmLoginPassword}
                          orderId={order.id}
                          userPublicKey={user.publicKey}
                          allowReset={order.status === "active" && order.vmid > 0}
                          onReload={loadData}
                          className="mt-0"
                          publicIpv4={order.publicIpv4}
                          cloudInitSshKeys={order.cloudInitSshKeys}
                        />
                      </div>
                    </aside>
                  </div>
                </article>
              );
            })}
        </div>
        </>
      )}
    </div>
  );
}
