"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DeleteVpsConfirmationDialog } from "@/components/DeleteVpsConfirmationDialog";
import { apiFetch } from "@/lib/api-client";

type Props = {
  orderId: string;
  /** Only poll Proxmox when order is active and has a VM. */
  shouldCheckPower: boolean;
  userPublicKey: string;
  onSuccess: () => void;
  /** When true, delete is unavailable (e.g. plan resize in progress), regardless of VM power. */
  operationBlocked?: boolean;
  /** When true, button fills a grid cell (paired with Reinstall on the dashboard). */
  fillCell?: boolean;
};

export function CancelVpsButton({
  orderId,
  shouldCheckPower,
  userPublicKey,
  onSuccess,
  operationBlocked = false,
  fillCell,
}: Props) {
  const [vmRunning, setVmRunning] = useState(false);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const orderIdRef = useRef<string | null>(null);
  orderIdRef.current = orderId;

  const refresh = useCallback(async () => {
    if (!shouldCheckPower) {
      setVmRunning(false);
      return;
    }
    try {
      const res = await apiFetch(`/api/vm/${orderId}/status`);
      const data = (await res.json()) as { status?: string };
      const raw = data.status;
      setVmRunning(
        typeof raw === "string" && raw.trim().toLowerCase() === "running"
      );
    } catch {
      setVmRunning(false);
    }
  }, [orderId, shouldCheckPower]);

  useEffect(() => {
    void refresh();
    if (!shouldCheckPower) return;
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [refresh, shouldCheckPower]);

  const disabled = operationBlocked || (shouldCheckPower && vmRunning);
  const title = operationBlocked
    ? "Unavailable while disk or plan maintenance runs"
    : disabled && shouldCheckPower && vmRunning
      ? "Shut down the VM before cancelling this VPS"
      : undefined;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        title={title}
        onClick={() => {
          if (!userPublicKey || disabled) return;
          deleteDialogRef.current?.showModal();
        }}
        className={`rounded-lg border border-red-500/50 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50${
          fillCell ? " flex w-full justify-center" : ""
        }`}
      >
        Delete
      </button>
      <DeleteVpsConfirmationDialog
        dialogRef={deleteDialogRef}
        orderIdRef={orderIdRef}
        userPublicKey={userPublicKey}
        isAdmin={false}
        onSuccess={onSuccess}
      />
    </>
  );
}
