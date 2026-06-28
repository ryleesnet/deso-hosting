"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api-client";

export type OrderPlanSpecs = {
  vcpu: number;
  ram: number;
  storage: number;
} | undefined;

type SpecsPayload = {
  vcpus: number;
  memoryMb: number;
  disksGb: number[];
};

function IconWrap({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--card-border)] text-[var(--accent)] [&>svg]:h-4 [&>svg]:w-4"
      aria-hidden
    >
      {children}
    </span>
  );
}

function CpuIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m9-13.5V18a.75.75 0 0 1-.75.75H6.75a.75.75 0 0 1-.75-.75V5.25a.75.75 0 0 1 .75-.75h13.5a.75.75 0 0 1 .75.75Z"
      />
    </svg>
  );
}

function MemoryIcon() {
  /* DIMM-style: two chip ICs, PCB rectangle, staggered pins with gap for locator notch */
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="5" width="4.75" height="3.35" rx="0.35" />
      <rect x="13.25" y="5" width="4.75" height="3.35" rx="0.35" />
      <rect x="4" y="9.85" width="16" height="5.65" rx="1" />
      <path d="M5.25 18v3M7.6 17.85v3.15M10 17.85v3.15M14 17.85v3.15M16.4 17.85v3.15M18.75 18v3" />
    </svg>
  );
}

function DiskIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <ellipse cx="12" cy="6" rx="8" ry="2.5" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 6v5c0 1.25 3.58 2.25 8 2.25S20 12.25 20 11V6"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M4 11v5c0 1.25 3.58 2.25 8 2.25S20 17.25 20 16v-5"
      />
    </svg>
  );
}

function formatRamParts(mb: number): { amount: string; unit: string } | null {
  if (mb <= 0) return null;
  if (mb % 1024 === 0) {
    const gb = mb / 1024;
    return { amount: String(gb), unit: "GB" };
  }
  if (mb >= 1024) {
    const gb = mb / 1024;
    return {
      amount: gb >= 10 ? Math.round(gb).toString() : gb.toFixed(1),
      unit: "GB",
    };
  }
  return { amount: String(mb), unit: "MB" };
}

function formatDiskGb(gb: number) {
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 10) return `${gb.toFixed(1)} GB`;
  return `${gb.toFixed(2)} GB`;
}

/** Dashboard specs — each line `Label:` value with icon (Proxmox or plan). vCPU, Memory, disks. */
export function OrderSpecsSummary({
  orderId,
  plan,
  /** Order's catalogue `serviceId` — bumps refetch after plan upgrades. */
  catalogServiceId,
  /** When false after a resize, bumps refetch once `adjustingPlan` clears so Proxmox data is re-read. */
  adjustingPlan = false,
  /** Same for extra-disk maintenance. */
  hardwareMaintenance = false,
  /** Same for backup restore. */
  backupRestoreInProgress = false,
  listClassName,
  extrasFingerprint,
}: {
  orderId: string;
  plan: OrderPlanSpecs;
  catalogServiceId?: string;
  adjustingPlan?: boolean;
  hardwareMaintenance?: boolean;
  backupRestoreInProgress?: boolean;
  /** Replaces default `mt-3` on the spec list (e.g. `mt-0` in a stacked card). */
  listClassName?: string;
  /** Bump when `extraDisksGb` changes so live disk list refetches. */
  extrasFingerprint?: string;
}) {
  const [specs, setSpecs] = useState<SpecsPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setSpecs(null);
    });
    void apiFetch(`/api/vm/${orderId}/specs`)
      .then((r) => r.json())
      .then((data: SpecsPayload & { error?: string }) => {
        if (cancelled || data?.error != null) return;
        if (typeof data.vcpus === "number" && typeof data.memoryMb === "number") {
          setSpecs({
            vcpus: data.vcpus,
            memoryMb: data.memoryMb,
            disksGb: Array.isArray(data.disksGb) ? data.disksGb : [],
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [orderId, catalogServiceId, adjustingPlan, hardwareMaintenance, backupRestoreInProgress, extrasFingerprint]);

  const vcpus = specs?.vcpus ?? plan?.vcpu;
  const memoryMb = specs?.memoryMb ?? plan?.ram;
  const disksGb =
    specs?.disksGb?.length && specs.disksGb.length > 0
      ? specs.disksGb
      : plan?.storage != null && plan.storage > 0
        ? [plan.storage]
        : [];

  const ramParts = typeof memoryMb === "number" ? formatRamParts(memoryMb) : null;

  const rows: { key: string; node: ReactNode }[] = [];

  if (typeof vcpus === "number" && vcpus > 0) {
    rows.push({
      key: "cpu",
      node: (
        <>
          <IconWrap>
            <CpuIcon />
          </IconWrap>
          <span>
            <span className="text-[var(--muted)]">vCPU:</span>{" "}
            <span className="font-medium text-[var(--foreground)]">{vcpus}</span>
          </span>
        </>
      ),
    });
  }

  if (ramParts) {
    const memoryValue = `${ramParts.amount} ${ramParts.unit}`;
    rows.push({
      key: "ram",
      node: (
        <>
          <IconWrap>
            <MemoryIcon />
          </IconWrap>
          <span>
            <span className="text-[var(--muted)]">Memory:</span>{" "}
            <span className="font-medium text-[var(--foreground)]">
              {memoryValue}
            </span>
          </span>
        </>
      ),
    });
  }

  disksGb.forEach((gb, i) => {
    rows.push({
      key: `disk-${i}`,
      node: (
        <>
          <IconWrap>
            <DiskIcon />
          </IconWrap>
          <span>
            <span className="text-[var(--muted)]">Disk {i + 1}:</span>{" "}
            <span className="font-medium text-[var(--foreground)]">
              {formatDiskGb(gb)}
            </span>
          </span>
        </>
      ),
    });
  });

  if (rows.length === 0) {
    return (
      <p className="mt-2 text-sm text-[var(--muted)]">
        Specifications unavailable
      </p>
    );
  }

  const listCn = listClassName ?? "mt-3 flex flex-col gap-2.5";

  return (
    <ul className={listCn} role="list">
      {rows.map(({ key, node }) => (
        <li key={key} className="flex items-center gap-3 text-sm">
          {node}
        </li>
      ))}
    </ul>
  );
}
