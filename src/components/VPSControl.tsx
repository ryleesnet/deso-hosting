"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";
import { apiFetch } from "@/lib/api-client";

type Action =
  | "start"
  | "shutdown"
  | "force_shutdown"
  | "reboot"
  | "reset";

export type VmPowerControlAction = Action;

const POLL_MS = 750;
const POWER_WAIT_MS = 120_000;

const LOADING_BUTTON_LABEL: Record<Action, string> = {
  start: "Starting",
  reboot: "Restarting",
  shutdown: "Shutting down",
  force_shutdown: "Shutting down",
  reset: "Force restarting",
};

const TIMEOUT_MESSAGE: Record<Action, string> = {
  start:
    "The VM did not report running in time. Refresh the page or try Start again.",
  reboot:
    "The VM did not finish restarting in time. Refresh the page or check the host.",
  shutdown:
    "The VM did not report powered off in time. Refresh the page or try again.",
  force_shutdown:
    "The VM did not report powered off in time. Refresh the page or try again.",
  reset:
    "The VM did not finish force restart in time. Refresh the page or check the host.",
};

async function pollUntilRunning(
  fetchStatus: () => Promise<string | null>,
  applyLocal: (s: string) => void
): Promise<boolean> {
  const deadline = Date.now() + POWER_WAIT_MS;
  while (Date.now() < deadline) {
    const s = await fetchStatus();
    if (s) applyLocal(s);
    if (s === "running") return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

async function pollUntilGuestOff(
  fetchStatus: () => Promise<string | null>,
  applyLocal: (s: string) => void
): Promise<boolean> {
  const deadline = Date.now() + POWER_WAIT_MS;
  while (Date.now() < deadline) {
    const s = await fetchStatus();
    if (s) applyLocal(s);
    if (s != null && s !== "running") return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return false;
}

/**
 * ACPI reboot: guest usually hits stopped in PVE; wait longer for that, then for running again.
 */
async function pollAfterSoftReboot(
  fetchStatus: () => Promise<string | null>,
  applyLocal: (s: string) => void
): Promise<boolean> {
  const globalDeadline = Date.now() + POWER_WAIT_MS;
  const phase1End = Date.now() + 60_000;
  let sawNotRunning = false;
  while (Date.now() < phase1End && Date.now() < globalDeadline) {
    await new Promise((r) => setTimeout(r, 400));
    const s = await fetchStatus();
    if (s) applyLocal(s);
    if (s && s !== "running") {
      sawNotRunning = true;
      break;
    }
  }
  const phase2AcceptAfter = sawNotRunning
    ? Date.now()
    : Date.now() + 5000;
  while (Date.now() < globalDeadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = await fetchStatus();
    if (s) applyLocal(s);
    if (s === "running" && Date.now() >= phase2AcceptAfter) return true;
  }
  return false;
}

/**
 * Force reset: PVE often keeps qemu status "running" for the whole operation — do not wait 90s for "stopped".
 */
async function pollAfterForceReset(
  fetchStatus: () => Promise<string | null>,
  applyLocal: (s: string) => void
): Promise<boolean> {
  const globalDeadline = Date.now() + POWER_WAIT_MS;
  const phase1End = Date.now() + 4000;
  let sawNotRunning = false;
  while (Date.now() < phase1End && Date.now() < globalDeadline) {
    await new Promise((r) => setTimeout(r, 350));
    const s = await fetchStatus();
    if (s) applyLocal(s);
    if (s && s !== "running") {
      sawNotRunning = true;
      break;
    }
  }
  const phase2AcceptAfter = sawNotRunning
    ? Date.now()
    : Date.now() + 1200;
  while (Date.now() < globalDeadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = await fetchStatus();
    if (s) applyLocal(s);
    if (s === "running" && Date.now() >= phase2AcceptAfter) return true;
  }
  return false;
}

export function VPSControl({
  orderId,
  deleteButton,
  onPowerFlowPending,
}: {
  orderId: string;
  /** Rendered after power buttons on the first row (e.g. Delete subscription). */
  deleteButton?: ReactNode;
  /**
   * Set when a power action begins (`action`). On API/timeout failure pass `null`.
   * Do not clear on success — parent clears after `VMRunningStatus` sees the target state.
   */
  onPowerFlowPending?: (pending: VmPowerControlAction | null) => void;
}) {
  const { user } = useAuth();
  const [loading, setLoading] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [vmPowerStatus, setVmPowerStatus] = useState<string | null>(null);
  const forceShutdownDialogRef = useRef<HTMLDialogElement>(null);
  const forceRestartDialogRef = useRef<HTMLDialogElement>(null);

  const fetchPowerStatus = useCallback(async (): Promise<string | null> => {
    try {
      const res = await apiFetch(`/api/vm/${orderId}/status`);
      const data = await res.json();
      const raw = data.status;
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (s === "running" || s === "stopped" || s === "paused") {
          return s;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }, [orderId]);

  const refreshPowerStatus = useCallback(async () => {
    const s = await fetchPowerStatus();
    if (s) setVmPowerStatus(s);
  }, [fetchPowerStatus]);

  useEffect(() => {
    void refreshPowerStatus();
    const id = setInterval(() => void refreshPowerStatus(), 15_000);
    return () => clearInterval(id);
  }, [refreshPowerStatus]);

  async function runAction(action: Action) {
    if (!user) return;
    setActionError(null);
    setLoading(action);
    onPowerFlowPending?.(action);

    let reachedTarget = false;
    const applyLocal = (s: string) => setVmPowerStatus(s);

    try {
      const res = await apiFetch(`/api/vm/${orderId}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (action === "start") {
        reachedTarget = await pollUntilRunning(fetchPowerStatus, applyLocal);
      } else if (action === "shutdown" || action === "force_shutdown") {
        reachedTarget = await pollUntilGuestOff(fetchPowerStatus, applyLocal);
      } else if (action === "reboot") {
        reachedTarget = await pollAfterSoftReboot(
          fetchPowerStatus,
          applyLocal
        );
      } else if (action === "reset") {
        reachedTarget = await pollAfterForceReset(
          fetchPowerStatus,
          applyLocal
        );
      }

      if (!reachedTarget) {
        setActionError(TIMEOUT_MESSAGE[action]);
      } else if (action === "reboot" || action === "reset") {
        // Proxmox may keep status "running" through reset — pill can't infer completion; control poll is authoritative.
        onPowerFlowPending?.(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Request failed";
      setActionError(msg);
      console.error(e);
    } finally {
      setLoading(null);
      if (!reachedTarget) {
        onPowerFlowPending?.(null);
      }
    }
  }

  const isRunning = vmPowerStatus === "running";

  const offHint = "VM is off — start it first";

  const linkBase =
    "inline-flex rounded-lg border border-[var(--accent)]/50 px-3 py-1.5 text-sm text-[var(--accent)]";

  function btnOpacityWhen(actionName: Action) {
    return loading === actionName ? "" : "disabled:opacity-50";
  }

  function btnPulseWhen(actionName: Action) {
    return loading === actionName ? "animate-pulse" : "";
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => runAction("start")}
        disabled={loading !== null || isRunning}
        title={isRunning ? "VM is already running" : undefined}
        className={`rounded-lg bg-green-600/20 px-3 py-1.5 text-sm text-green-400 hover:bg-green-600/30 disabled:cursor-not-allowed ${btnPulseWhen(
          "start"
        )} ${btnOpacityWhen("start")}`}
      >
        {loading === "start" ? LOADING_BUTTON_LABEL.start : "Start"}
      </button>
      <button
        type="button"
        onClick={() => runAction("reboot")}
        disabled={loading !== null || !isRunning}
        title={!isRunning ? offHint : undefined}
        className={`rounded-lg bg-blue-600/20 px-3 py-1.5 text-sm text-blue-400 hover:bg-blue-600/30 disabled:cursor-not-allowed ${btnPulseWhen(
          "reboot"
        )} ${btnOpacityWhen("reboot")}`}
      >
        {loading === "reboot" ? LOADING_BUTTON_LABEL.reboot : "Restart"}
      </button>
      <button
        type="button"
        onClick={() => runAction("shutdown")}
        disabled={loading !== null || !isRunning}
        title={!isRunning ? offHint : undefined}
        className={`rounded-lg bg-yellow-600/20 px-3 py-1.5 text-sm text-yellow-400 hover:bg-yellow-600/30 disabled:cursor-not-allowed ${btnPulseWhen(
          "shutdown"
        )} ${btnOpacityWhen("shutdown")}`}
      >
        {loading === "shutdown"
          ? LOADING_BUTTON_LABEL.shutdown
          : "Shutdown"}
      </button>
      <button
        type="button"
        onClick={() => forceShutdownDialogRef.current?.showModal()}
        disabled={loading !== null || !isRunning}
        title={
          !isRunning
            ? offHint
            : "Immediate power off — does not wait for the guest OS"
        }
        className={`rounded-lg bg-red-600/20 px-3 py-1.5 text-sm text-red-400 hover:bg-red-600/30 disabled:cursor-not-allowed ${btnPulseWhen(
          "force_shutdown"
        )} ${btnOpacityWhen("force_shutdown")}`}
      >
        {loading === "force_shutdown"
          ? LOADING_BUTTON_LABEL.force_shutdown
          : "Force Shutdown"}
      </button>
      <button
        type="button"
        onClick={() => forceRestartDialogRef.current?.showModal()}
        disabled={loading !== null || !isRunning}
        title={
          !isRunning
            ? offHint
            : "Hardware reset — does not shut down the guest cleanly"
        }
        className={`rounded-lg bg-orange-600/20 px-3 py-1.5 text-sm text-orange-400 hover:bg-orange-600/30 disabled:cursor-not-allowed ${btnPulseWhen(
          "reset"
        )} ${btnOpacityWhen("reset")}`}
      >
        {loading === "reset" ? LOADING_BUTTON_LABEL.reset : "Force Restart"}
      </button>
      {deleteButton}
      <span className="h-0 w-full basis-full shrink-0" aria-hidden />
      {isRunning ? (
        <Link
          href={`/dashboard/${orderId}/console`}
          className={`${linkBase} hover:bg-[var(--accent)]/10`}
        >
          Console
        </Link>
      ) : (
        <button
          type="button"
          disabled
          title={offHint}
          className={`${linkBase} bg-transparent disabled:opacity-50`}
        >
          Console
        </button>
      )}
      {actionError && (
        <p className="w-full basis-full text-sm text-red-400" role="alert">
          {actionError}
        </p>
      )}
      </div>
      <dialog
        ref={forceShutdownDialogRef}
        aria-labelledby="force-shutdown-title"
        aria-describedby="force-shutdown-desc"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <p
            id="force-shutdown-title"
            className="text-lg font-semibold text-red-400"
          >
            Force shutdown
          </p>
          <p
            id="force-shutdown-desc"
            className="text-sm leading-relaxed text-[var(--muted)]"
          >
            This cuts power to the VM immediately (like unplugging it). Any
            active guest shutdown (ACPI) requests are overruled so the VM can stop
            right away. The guest does not shut down cleanly, and{" "}
            <span className="font-medium text-[var(--foreground)]">
              unsaved data may be lost
            </span>
            .
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--background)]"
              onClick={() => forceShutdownDialogRef.current?.close()}
              disabled={loading !== null}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                forceShutdownDialogRef.current?.close();
                void runAction("force_shutdown");
              }}
              disabled={loading !== null || !isRunning}
            >
              Force shutdown
            </button>
          </div>
        </div>
      </dialog>
      <dialog
        ref={forceRestartDialogRef}
        aria-labelledby="force-restart-title"
        aria-describedby="force-restart-desc"
        className="fixed left-1/2 top-1/2 z-50 m-0 max-h-[90vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/50"
      >
        <div className="flex flex-col gap-4">
          <p
            id="force-restart-title"
            className="text-lg font-semibold text-orange-400"
          >
            Force restart
          </p>
          <p
            id="force-restart-desc"
            className="text-sm leading-relaxed text-[var(--muted)]"
          >
            This sends a hardware reset to the VM (similar to pressing a
            physical reset button). The guest does not shut down cleanly, and{" "}
            <span className="font-medium text-[var(--foreground)]">
              unsaved data may be lost
            </span>
            . The server will be unavailable briefly while it reboots.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--background)]"
              onClick={() => forceRestartDialogRef.current?.close()}
              disabled={loading !== null}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                forceRestartDialogRef.current?.close();
                void runAction("reset");
              }}
              disabled={loading !== null || !isRunning}
            >
              Force restart
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
