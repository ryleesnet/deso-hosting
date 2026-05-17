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
};

export function CancelVpsButton({
  orderId,
  shouldCheckPower,
  userPublicKey,
  onSuccess,
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

  const disabled = shouldCheckPower && vmRunning;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        title={
          disabled
            ? "Shut down the VM before cancelling this VPS"
            : undefined
        }
        onClick={() => {
          if (!userPublicKey || disabled) return;
          deleteDialogRef.current?.showModal();
        }}
        className="rounded-lg border border-red-500/50 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50"
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
