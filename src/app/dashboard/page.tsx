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
import { CancelVpsButton } from "@/components/CancelVpsButton";
import { OrderSpecsSummary } from "@/components/OrderSpecsSummary";
import { BillingCycleSummary, type BillingInfo } from "@/components/BillingCycleSummary";
import { VmBootstrapCredentials } from "@/components/VmBootstrapCredentials";
import { RenewSubscriptionPanel } from "@/components/RenewSubscriptionPanel";
import { ReinstallVpsButton } from "@/components/ReinstallVpsButton";
import { PrivateUserLanPanel } from "@/components/PrivateUserLanPanel";
import { apiFetch } from "@/lib/api-client";

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
  /** authorized_keys lines currently installed via cloud-init (server-side state). */
  cloudInitSshKeys?: string;
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
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [services, setServices] = useState<Record<string, Service>>({});
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

  const loadData = useCallback(() => {
    if (!user) return;
    Promise.all([
      apiFetch(`/api/orders`).then((r) => r.json()),
      fetch("/api/services").then((r) => r.json()),
    ])
      .then(([ordersData, servicesData]) => {
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

  useEffect(() => {
    if (!user || !hasProvisioningOrder) return;
    const t = setInterval(() => loadData(), 3000);
    return () => clearInterval(t);
  }, [user, hasProvisioningOrder, loadData]);

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
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold">My VPS</h1>
      <p className="mt-2 text-[var(--muted)]">
        Manage your virtual private servers
      </p>
      {hasProvisioningOrder && (
        <p className="mt-2 text-sm text-orange-400/95" role="status" aria-live="polite">
          At least one server is still provisioning — this list updates every few seconds.
        </p>
      )}

      {orders.length === 0 ? (
        <div className="mt-12 rounded-2xl border border-dashed border-[var(--card-border)] bg-[var(--card)]/30 p-12 text-center">
          <p className="text-[var(--muted)]">You don&apos;t have any VPS yet.</p>
          <Link
            href="/services"
            className="mt-4 inline-block rounded-lg bg-[var(--accent)] px-6 py-2 font-medium text-[var(--background)] hover:bg-[var(--accent-muted)]"
          >
            Order a VPS
          </Link>
        </div>
      ) : (
        <div className="mt-12 space-y-6">
          {orders
            .filter((o) => o.status !== "cancelled")
            .map((order) => (
            <div
              key={order.id}
              className="rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-6"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-xl font-semibold">
                    <VMProxmoxTitle orderId={order.id} vmid={order.vmid} />
                  </h3>
                {order.status === "provisioning" && (
                  <>
                    <span
                      className="text-lg font-semibold text-[var(--muted)] select-none"
                      aria-hidden
                    >
                      |
                    </span>
                    <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-orange-400">
                      <span
                        className="inline-block h-2 w-2 animate-pulse rounded-full bg-orange-400"
                        aria-hidden
                      />
                      PROVISIONING
                    </span>
                  </>
                )}
                {order.status === "suspended" && (
                  <>
                    <span
                      className="text-lg font-semibold text-[var(--muted)] select-none"
                      aria-hidden
                    >
                      |
                    </span>
                    <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-amber-400">
                      Suspended — renew to restore access
                    </span>
                  </>
                )}
                {(order.status === "active" || order.status === "suspended") &&
                  order.vmid > 0 && (
                  <>
                    <span
                      className="text-lg font-semibold text-[var(--muted)] select-none"
                      aria-hidden
                    >
                      |
                    </span>
                    <div className="flex items-center gap-2 text-lg font-semibold">
                      <span className="text-[var(--muted)]">Status:</span>
                      <VMRunningStatus
                        orderId={order.id}
                        size="prominent"
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
                  </>
                )}
              </div>

              <div className="mt-6 flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
                <div className="min-w-0 flex-1">
                  <OrderSpecsSummary
                    orderId={order.id}
                    plan={services[order.serviceId]}
                  />
                  <BillingCycleSummary billing={order.billing} />
                  <PrivateUserLanPanel
                    orderId={order.id}
                    enabled={order.privateLanEnabled}
                    ip={order.privateLanIp}
                    canEdit={
                      (order.status === "active" ||
                        order.status === "suspended") &&
                      order.vmid > 0
                    }
                    onChange={loadData}
                  />
                  {order.billing &&
                    (order.status === "active" || order.status === "suspended") &&
                    order.vmid > 0 && (
                      <RenewSubscriptionPanel
                        orderId={order.id}
                        userPublicKey={user.publicKey}
                        onSuccess={loadData}
                      />
                    )}
                  {(order.status === "active" ||
                    order.status === "pending" ||
                    order.status === "provisioning" ||
                    order.status === "suspended") && (
                    <div className="mt-5 flex w-full min-w-0 flex-col gap-3">
                      {order.status === "suspended" && (
                        <p className="text-sm text-amber-400">
                          This VPS was shut down after an extended unpaid period. After you renew,
                          your server will return to <span className="font-medium">active</span> and
                          start automatically when possible.
                        </p>
                      )}
                      <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
                        {order.status === "active" && order.vmid > 0 ? (
                          <VPSControl
                            orderId={order.id}
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
                                    onStarted={loadData}
                                    disabled={!!vmPowerPendingByOrder[order.id]}
                                    fillCell
                                  />
                                </div>
                                <div className="min-w-0">
                                  <CancelVpsButton
                                    orderId={order.id}
                                    shouldCheckPower
                                    userPublicKey={user.publicKey}
                                    onSuccess={loadData}
                                    fillCell
                                  />
                                </div>
                              </>
                            }
                          />
                        ) : (
                          <>
                            {(order.status === "active" ||
                              order.status === "suspended") &&
                              order.vmid > 0 && (
                                <ReinstallVpsButton
                                  orderId={order.id}
                                  onStarted={loadData}
                                  disabled={!!vmPowerPendingByOrder[order.id]}
                                />
                              )}
                            <CancelVpsButton
                              orderId={order.id}
                              shouldCheckPower={
                                order.status === "active" && order.vmid > 0
                              }
                              userPublicKey={user.publicKey}
                              onSuccess={loadData}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex w-full shrink-0 flex-col gap-3 lg:max-w-sm">
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
              </div>

              {order.status === "pending" && (
                <div className="mt-4">
                  {order.vmid > 0 ? (
                    <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3 text-sm">
                      <p className="font-medium text-yellow-300">
                        Your VM was created, but post-clone configuration didn&apos;t finish.
                      </p>
                      {order.provisionError && (
                        <p className="mt-1 break-all font-mono text-xs text-yellow-200/80">
                          {order.provisionError}
                        </p>
                      )}
                      <p className="mt-2 text-xs text-yellow-200/70">
                        Retry to re-apply CPU/memory, cloud-init credentials, and any extra disks
                        on the existing VM (no re-clone).
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleRetryProvision(order.id)}
                          disabled={retryingOrder === order.id}
                          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
                        >
                          {retryingOrder === order.id
                            ? "Retrying…"
                            : "Retry provisioning"}
                        </button>
                      </div>
                      {retryError[order.id] && (
                        <p className="mt-2 break-all text-xs text-red-400">
                          {retryError[order.id]}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-yellow-400">
                      Your order is pending. Admin will provision your VPS shortly.
                    </p>
                  )}
                </div>
              )}
              {order.status === "provisioning" && (
                <p className="mt-4 text-sm text-orange-400">
                  Creating your VM (clone, CPU, memory, disk). This page refreshes every few seconds; when
                  ready, controls and power status will appear.
                </p>
              )}
              {order.status === "suspended" && (
                <p className="mt-4 text-sm text-[var(--muted)]">
                  Power and console controls are disabled until the subscription is renewed.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
