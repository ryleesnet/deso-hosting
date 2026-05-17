"use client";

import { useEffect, useRef, useState } from "react";
import type { VmPowerControlAction } from "@/components/VPSControl";
import { apiFetch } from "@/lib/api-client";

type DisplayState = "loading" | "running" | "off" | "error";

const PENDING_LABEL: Record<VmPowerControlAction, string> = {
  start: "Starting",
  reboot: "Restarting",
  shutdown: "Shutting down",
  force_shutdown: "Shutting down",
  reset: "Force restarting",
};

const PENDING_PILL_CLASS: Record<VmPowerControlAction, string> = {
  start: "bg-green-500/15 text-green-400",
  reboot: "bg-blue-500/15 text-blue-400",
  shutdown: "bg-yellow-500/15 text-yellow-400",
  force_shutdown: "bg-red-500/15 text-red-400",
  reset: "bg-orange-500/15 text-orange-400",
};

interface VMRunningStatusProps {
  orderId: string;
  /** Larger pills for dashboard title row. */
  size?: "default" | "prominent";
  /**
   * When set, shows an in-progress label with fast polling. Cleared when the target is observed
   * (`onPendingPowerSynced` for start/shutdown) or when `VPSControl` finishes polling (reboot/reset).
   */
  pendingPowerAction?: VmPowerControlAction;
  /** Call when `pendingPowerAction` has reached its target (running vs off). */
  onPendingPowerSynced?: () => void;
}

/** Live VM power state from Proxmox (polling). */
export function VMRunningStatus({
  orderId,
  size = "default",
  pendingPowerAction,
  onPendingPowerSynced,
}: VMRunningStatusProps) {
  const pill =
    size === "prominent"
      ? "rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
      : "rounded-full px-3 py-0.5 text-xs font-semibold uppercase tracking-wide";
  const [display, setDisplay] = useState<DisplayState>("loading");
  const onSyncedRef = useRef(onPendingPowerSynced);
  onSyncedRef.current = onPendingPowerSynced;

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await apiFetch(`/api/vm/${orderId}/status`);
        const data = (await res.json()) as {
          status?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || data.error || typeof data.status !== "string") {
          setDisplay("error");
          return;
        }
        const s = data.status.trim().toLowerCase();
        setDisplay(s === "running" ? "running" : "off");
      } catch {
        if (!cancelled) setDisplay("error");
      }
    }

    void poll();
    const intervalMs = pendingPowerAction ? 750 : 15_000;
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [orderId, pendingPowerAction]);

  useEffect(() => {
    if (!pendingPowerAction) return;

    if (pendingPowerAction === "shutdown" || pendingPowerAction === "force_shutdown") {
      if (display === "off") onSyncedRef.current?.();
      return;
    }

    if (pendingPowerAction === "start") {
      if (display === "running") onSyncedRef.current?.();
    }

    // reboot / reset: pending is cleared by VPSControl when its poll finishes (guest may stay "running" in PVE API).
  }, [pendingPowerAction, display]);

  if (display === "running" && pendingPowerAction === "start") {
    return (
      <span className={`${pill} bg-green-500/15 text-green-400`}>Running</span>
    );
  }

  if (pendingPowerAction) {
    return (
      <span
        className={`${pill} ${PENDING_PILL_CLASS[pendingPowerAction]} animate-pulse`}
      >
        {PENDING_LABEL[pendingPowerAction]}
      </span>
    );
  }

  if (display === "running") {
    return (
      <span className={`${pill} bg-green-500/15 text-green-400`}>Running</span>
    );
  }

  if (display === "loading") {
    return (
      <span className={`${pill} bg-[var(--card)] text-[var(--muted)]`}>…</span>
    );
  }

  if (display === "error") {
    return (
      <span className={`${pill} bg-red-500/15 text-red-400`}>Unknown</span>
    );
  }

  return (
    <span className={`${pill} bg-red-500/15 text-red-400`}>Off</span>
  );
}
