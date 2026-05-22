"use client";

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useId,
  type ReactNode,
} from "react";
import { DangerZoneCollapsible } from "@/components/DangerZoneCollapsible";
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

type VmPowerMenuItem = {
  label: string;
  destructive?: boolean;
  destructiveTone?: "orange" | "red";
  onSelect: () => void;
};

function VmPowerMenu({
  idleLabel,
  loadingLabel,
  isLoading,
  disabled,
  disabledTitle,
  triggerClassName,
  menuAriaLabel,
  items,
}: {
  idleLabel: string;
  loadingLabel: string;
  isLoading: boolean;
  disabled: boolean;
  disabledTitle?: string;
  triggerClassName: string;
  menuAriaLabel: string;
  items: VmPowerMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  /** Avoid effects that close-on-disable; derives visibility and listener wiring. */
  const menuVisible = open && !disabled;
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!menuVisible) return;

    const onPointerDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) close();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuVisible, close]);

  return (
    <div className="relative inline-block align-top" ref={rootRef}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${triggerClassName} ${
          isLoading ? "animate-pulse" : ""
        }`}
        aria-expanded={menuVisible}
        aria-haspopup="menu"
        aria-controls={menuId}
        disabled={disabled}
        title={disabled ? disabledTitle : `Open ${idleLabel} options`}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
      >
        <span>{isLoading ? loadingLabel : idleLabel}</span>
        <svg
          className={`h-4 w-4 shrink-0 opacity-80 transition-transform ${menuVisible ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {menuVisible ? (
        <div
          id={menuId}
          role="menu"
          aria-label={menuAriaLabel}
          className="absolute left-0 z-[60] mt-1 max-w-[min(20rem,calc(100vw-1.5rem))] min-w-[12rem] rounded-lg border border-[var(--card-border)] bg-[var(--card)] py-1 shadow-lg sm:left-0"
        >
          {items.map(({ label, destructive, destructiveTone, onSelect }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className={`block min-h-10 w-full px-3 py-2 text-left text-sm hover:bg-[var(--background)] sm:min-h-0 ${
                destructive
                  ? destructiveTone === "red"
                    ? "text-red-400 hover:text-red-300"
                    : "text-orange-400 hover:text-orange-300"
                  : "text-[var(--foreground)]"
              }`}
              onClick={() => {
                close();
                onSelect();
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function VPSControl({
  orderId,
  deleteButton,
  onPowerFlowPending,
  powerLocked = false,
  powerLockedTitle,
}: {
  orderId: string;
  /** Two grid cells (e.g. Reinstall + Delete), equal width inside {@link VPSControl}. */
  deleteButton?: ReactNode;
  /**
   * Set when a power action begins (`action`). On API/timeout failure pass `null`.
   * Do not clear on success — parent clears after `VMRunningStatus` sees the target state.
   */
  onPowerFlowPending?: (pending: VmPowerControlAction | null) => void;
  /** When true, power actions and console are disabled (e.g. plan change in progress). */
  powerLocked?: boolean;
  powerLockedTitle?: string;
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
    if (!user || powerLocked) return;
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
    "flex w-full items-center justify-center rounded-lg border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-3 py-1.5 text-sm text-[var(--accent)]";

  const hwLocked = powerLocked;
  const lockExplain = hwLocked
    ? typeof powerLockedTitle === "string" && powerLockedTitle.trim().length > 0
      ? powerLockedTitle.trim()
      : "Unavailable while another operation runs on this VPS."
    : undefined;

  const powerMenusDisabled = loading !== null || !isRunning || hwLocked;
  const powerMenuDisabledTitle = hwLocked
    ? lockExplain
    : !isRunning
      ? offHint
      : loading !== null
        ? "Please wait for the current operation"
        : undefined;

  function btnOpacityWhen(actionName: Action) {
    return loading === actionName ? "" : "disabled:opacity-50";
  }

  function btnPulseWhen(actionName: Action) {
    return loading === actionName ? "animate-pulse" : "";
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="grid w-max max-w-full grid-cols-1 gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => runAction("start")}
            disabled={loading !== null || isRunning || hwLocked}
            title={
              hwLocked ? lockExplain : isRunning ? "VM is already running" : undefined
            }
            className={`rounded-lg bg-green-600/20 px-3 py-1.5 text-sm text-green-400 hover:bg-green-600/30 disabled:cursor-not-allowed ${btnPulseWhen(
              "start"
            )} ${btnOpacityWhen("start")}`}
          >
            {loading === "start" ? LOADING_BUTTON_LABEL.start : "Start"}
          </button>
          <VmPowerMenu
            idleLabel="Restart"
            loadingLabel={
              loading === "reset"
                ? LOADING_BUTTON_LABEL.reset
                : LOADING_BUTTON_LABEL.reboot
            }
            isLoading={
              loading === "reboot" ||
              loading === "reset"
            }
            disabled={powerMenusDisabled}
            disabledTitle={powerMenuDisabledTitle}
            menuAriaLabel="Restart options"
            triggerClassName="bg-blue-600/20 text-blue-400 hover:bg-blue-600/30"
            items={[
              {
                label: "Restart (guest)",
                onSelect: () => void runAction("reboot"),
              },
              {
                label: "Force restart…",
                destructive: true,
                onSelect: () =>
                  forceRestartDialogRef.current?.showModal(),
              },
            ]}
          />
          <VmPowerMenu
            idleLabel="Shutdown"
            loadingLabel={
              loading === "force_shutdown"
                ? LOADING_BUTTON_LABEL.force_shutdown
                : LOADING_BUTTON_LABEL.shutdown
            }
            isLoading={
              loading === "shutdown" || loading === "force_shutdown"
            }
            disabled={powerMenusDisabled}
            disabledTitle={powerMenuDisabledTitle}
            menuAriaLabel="Shutdown options"
            triggerClassName="bg-yellow-600/20 text-yellow-400 hover:bg-yellow-600/30"
            items={[
              {
                label: "Shutdown (guest)",
                onSelect: () => void runAction("shutdown"),
              },
              {
                label: "Force shutdown…",
                destructive: true,
                destructiveTone: "red",
                onSelect: () =>
                  forceShutdownDialogRef.current?.showModal(),
              },
            ]}
          />
        </div>
        <div className="min-w-0">
          {isRunning && !hwLocked ? (
            <Link
              href={`/dashboard/${orderId}/console`}
              className={`${linkBase} hover:bg-[var(--accent)]/25`}
            >
              Console
            </Link>
          ) : (
            <button
              type="button"
              disabled
              title={
                hwLocked ? lockExplain : offHint
              }
              className={`${linkBase} cursor-not-allowed disabled:opacity-50`}
            >
              Console
            </button>
          )}
        </div>
        {deleteButton ? (
          <DangerZoneCollapsible>
            <div className="grid min-w-0 grid-cols-2 gap-2">{deleteButton}</div>
          </DangerZoneCollapsible>
        ) : null}
        </div>
        {actionError && (
          <p className="text-sm text-red-400" role="alert">
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
