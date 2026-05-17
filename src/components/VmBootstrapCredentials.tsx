"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { apiFetch } from "@/lib/api-client";

type Props = {
  username?: string | null;
  password?: string | null;
  /** When set with userPublicKey, shows reset control (active VPS only from parent). */
  orderId?: string;
  userPublicKey?: string;
  allowReset?: boolean;
  onReload?: () => void;
  /** Merged onto root (default top margin is mt-4 when omitted). */
  className?: string;
  publicIpv4?: string | null;
  /** Cloud-init authorized_keys lines (newline-separated) currently on the VM. */
  cloudInitSshKeys?: string | null;
};

type SshAction = "set" | "generate" | "delete";

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Linux login from cloud-init + optional Proxmox password reset (regenerates cloud-init). */
export function VmBootstrapCredentials({
  username,
  password,
  orderId,
  userPublicKey,
  allowReset,
  onReload,
  className,
  publicIpv4,
  cloudInitSshKeys,
}: Props) {
  const [revealed, setRevealed] = useState(false);
  const [shownPassword, setShownPassword] = useState(password ?? "");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetErr, setResetErr] = useState<string | null>(null);

  const [shownSshKeys, setShownSshKeys] = useState<string>(
    cloudInitSshKeys ?? ""
  );
  const [sshBusy, setSshBusy] = useState<SshAction | null>(null);
  const [sshErr, setSshErr] = useState<string | null>(null);
  const [sshNotice, setSshNotice] = useState<string | null>(null);
  const [sshPasteOpen, setSshPasteOpen] = useState(false);
  const [sshPasteDraft, setSshPasteDraft] = useState("");
  const [sshKeyBundle, setSshKeyBundle] = useState<{
    privateKey: string;
    publicLine: string;
  } | null>(null);

  /** Same pattern as admin order copy buttons: brief fixed popup near the click. */
  const [copyToast, setCopyToast] = useState<{
    message: string;
    x: number;
    y: number;
    isError: boolean;
  } | null>(null);
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyToastTimerRef.current) {
        clearTimeout(copyToastTimerRef.current);
      }
    };
  }, []);

  function showCopyToast(
    message: string,
    clientX: number,
    clientY: number,
    isError: boolean
  ) {
    if (copyToastTimerRef.current) {
      clearTimeout(copyToastTimerRef.current);
    }
    setCopyToast({ message, x: clientX, y: clientY, isError });
    copyToastTimerRef.current = setTimeout(() => {
      setCopyToast(null);
      copyToastTimerRef.current = null;
    }, 1800);
  }

  async function copyVmLoginField(
    text: string,
    flashLabel: string,
    e: MouseEvent<HTMLButtonElement>
  ) {
    const t = text.trim();
    if (!t) return;
    const { clientX, clientY } = e;
    try {
      await navigator.clipboard.writeText(t);
      showCopyToast(`Copied ${flashLabel}`, clientX, clientY, false);
    } catch {
      showCopyToast(
        "Copy failed — check browser permissions",
        clientX,
        clientY,
        true
      );
    }
  }

  useEffect(() => {
    setShownPassword(password ?? "");
  }, [password]);

  useEffect(() => {
    setShownSshKeys(cloudInitSshKeys ?? "");
  }, [cloudInitSshKeys]);

  if (!username) return null;
  if (!password && !allowReset) return null;

  const resetAvailable = Boolean(allowReset && orderId && userPublicKey);
  const sshControlsAvailable = Boolean(
    allowReset && orderId && userPublicKey
  );
  const hasSshKey = shownSshKeys.trim().length > 0;

  async function handleReset() {
    if (!orderId || !userPublicKey) return;
    setResetErr(null);
    if (
      !confirm(
        "This will generate a new password, update cloud-init on Proxmox, and regenerate the cloud-init drive. If the VM is running, it will shut down briefly and start again. Continue?"
      )
    ) {
      return;
    }
    setResetBusy(true);
    try {
      const res = await apiFetch(`/api/vm/${orderId}/reset-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        error?: string;
        vmLoginPassword?: string;
      };
      if (!res.ok) throw new Error(data.error || "Reset failed");
      if (data.vmLoginPassword) {
        setShownPassword(data.vmLoginPassword);
        setRevealed(true);
      }
      onReload?.();
    } catch (e) {
      setResetErr(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setResetBusy(false);
    }
  }

  async function callSshKeysEndpoint(
    action: SshAction,
    sshPublicKey?: string
  ): Promise<{
    ok: true;
    cloudInitSshKeys: string | null;
    generatedSshPrivateKey?: string;
    generatedSshPublicKeyLine?: string;
  } | { ok: false; error: string }> {
    if (!orderId || !userPublicKey) {
      return { ok: false, error: "Missing order context" };
    }
    try {
      const res = await apiFetch(`/api/vm/${orderId}/ssh-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(sshPublicKey ? { sshPublicKey } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        cloudInitSshKeys?: string | null;
        generatedSshPrivateKey?: string;
        generatedSshPublicKeyLine?: string;
      };
      if (!res.ok) {
        return {
          ok: false,
          error: data.error || `Request failed (${res.status})`,
        };
      }
      return {
        ok: true,
        cloudInitSshKeys: data.cloudInitSshKeys ?? null,
        generatedSshPrivateKey: data.generatedSshPrivateKey,
        generatedSshPublicKeyLine: data.generatedSshPublicKeyLine,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  async function handleGenerateSsh() {
    if (!sshControlsAvailable) return;
    if (
      !confirm(
        "Generate a new SSH key pair, install the public key via cloud-init, and reboot the VM. The previous key (if any) will be replaced. Continue?"
      )
    ) {
      return;
    }
    setSshErr(null);
    setSshNotice(null);
    setSshBusy("generate");
    const r = await callSshKeysEndpoint("generate");
    setSshBusy(null);
    if (!r.ok) {
      setSshErr(r.error);
      return;
    }
    setShownSshKeys(r.cloudInitSshKeys ?? "");
    if (r.generatedSshPrivateKey && r.generatedSshPublicKeyLine) {
      setSshKeyBundle({
        privateKey: r.generatedSshPrivateKey,
        publicLine: r.generatedSshPublicKeyLine,
      });
    }
    setSshNotice("New key installed. The VM was rebooted to apply it.");
    onReload?.();
  }

  async function handleDeleteSsh() {
    if (!sshControlsAvailable) return;
    if (
      !confirm(
        "Delete the SSH public key from cloud-init and reboot the VM? Existing logged-in sessions are unaffected."
      )
    ) {
      return;
    }
    setSshErr(null);
    setSshNotice(null);
    setSshBusy("delete");
    const r = await callSshKeysEndpoint("delete");
    setSshBusy(null);
    if (!r.ok) {
      setSshErr(r.error);
      return;
    }
    setShownSshKeys("");
    setSshNotice("SSH key removed. The VM was rebooted.");
    onReload?.();
  }

  async function handleSetPasted() {
    if (!sshControlsAvailable) return;
    const pasted = sshPasteDraft.trim();
    if (!pasted) {
      setSshErr("Paste at least one OpenSSH public key line.");
      return;
    }
    setSshErr(null);
    setSshNotice(null);
    setSshBusy("set");
    const r = await callSshKeysEndpoint("set", pasted);
    setSshBusy(null);
    if (!r.ok) {
      setSshErr(r.error);
      return;
    }
    setShownSshKeys(r.cloudInitSshKeys ?? "");
    setSshPasteDraft("");
    setSshPasteOpen(false);
    setSshNotice("Key replaced. The VM was rebooted.");
    onReload?.();
  }

  const ip = publicIpv4?.trim() ?? "";

  return (
    <div
      className={`rounded-xl border border-[var(--card-border)] bg-[var(--background)]/40 p-4 ${className ?? "mt-4"}`}
    >
      <h4 className="text-sm font-semibold text-[var(--foreground)]">VM login</h4>
      <dl className="mt-3 space-y-3 text-sm">
        {ip ? (
          <div>
            <dt className="text-[var(--muted)]">Public IP</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">{ip}</span>
              <button
                type="button"
                onClick={(e) => void copyVmLoginField(ip, "public IP", e)}
                className="rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--card-border)]/60"
              >
                Copy
              </button>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-[var(--muted)]">Username</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono font-medium">{username}</span>
            <button
              type="button"
              onClick={(e) => void copyVmLoginField(username, "username", e)}
              className="rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--card-border)]/60"
            >
              Copy
            </button>
          </dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Password</dt>
          <dd className="mt-1 flex flex-col gap-2">
            {shownPassword ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all font-mono font-medium">
                  {revealed ? shownPassword : "••••••••••••••••••••••••"}
                </span>
                <button
                  type="button"
                  onClick={() => setRevealed((r) => !r)}
                  className="rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--card-border)]/60"
                >
                  {revealed ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  onClick={(e) =>
                    void copyVmLoginField(shownPassword, "password", e)
                  }
                  className="rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--card-border)]/60"
                >
                  Copy
                </button>
              </div>
            ) : (
              <p className="text-xs text-yellow-400/95">
                No password stored for this order. Use reset to generate one and push it to
                cloud-init.
              </p>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">SSH public key</dt>
          <dd className="mt-1 flex flex-col gap-2">
            {hasSshKey ? (
              <div className="rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs">
                <div className="break-all">{shownSshKeys}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) =>
                      void copyVmLoginField(shownSshKeys, "SSH public key", e)
                    }
                    className="rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--card-border)]/60"
                  >
                    Copy
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-[var(--muted)]">
                No SSH public key installed. Use the controls below to add one (cloud-init will
                regenerate and the VM will reboot to apply).
              </p>
            )}
          </dd>
        </div>
      </dl>

      {sshControlsAvailable && (
        <div className="mt-4 border-t border-[var(--card-border)] pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={sshBusy !== null}
              onClick={() => {
                setSshErr(null);
                setSshNotice(null);
                setSshPasteOpen((v) => !v);
              }}
              className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--card)] disabled:opacity-50"
            >
              {hasSshKey ? "Replace key…" : "Add key…"}
            </button>
            <button
              type="button"
              disabled={sshBusy !== null}
              onClick={() => void handleGenerateSsh()}
              className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--card)] disabled:opacity-50"
            >
              {sshBusy === "generate"
                ? "Generating…"
                : hasSshKey
                  ? "Regenerate key"
                  : "Generate key"}
            </button>
            {hasSshKey && (
              <button
                type="button"
                disabled={sshBusy !== null}
                onClick={() => void handleDeleteSsh()}
                className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50"
              >
                {sshBusy === "delete" ? "Deleting…" : "Delete key"}
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Key changes update cloud-init on Proxmox and reboot the VM (graceful shutdown
            first when running).
          </p>
          {sshPasteOpen && (
            <div className="mt-3">
              <label className="block text-xs font-medium text-[var(--muted)]">
                OpenSSH public key(s); one per line
              </label>
              <textarea
                value={sshPasteDraft}
                onChange={(e) => setSshPasteDraft(e.target.value)}
                rows={4}
                placeholder="ssh-ed25519 AAAA... user@host"
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={sshBusy !== null}
                  onClick={() => void handleSetPasted()}
                  className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
                >
                  {sshBusy === "set" ? "Applying…" : "Save & reboot"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSshPasteOpen(false);
                    setSshPasteDraft("");
                    setSshErr(null);
                  }}
                  className="rounded-lg border border-[var(--card-border)] px-3 py-2 text-sm hover:bg-[var(--card)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {sshErr && (
            <p className="mt-2 break-all text-xs text-red-400">{sshErr}</p>
          )}
          {sshNotice && !sshErr && (
            <p className="mt-2 text-xs text-green-400">{sshNotice}</p>
          )}
        </div>
      )}

      {resetAvailable && (
        <div className="mt-4 border-t border-[var(--card-border)] pt-3">
          <button
            type="button"
            disabled={resetBusy}
            onClick={() => void handleReset()}
            className="rounded-lg border border-orange-500/50 bg-orange-500/10 px-3 py-2 text-sm font-medium text-orange-300 hover:bg-orange-500/20 disabled:opacity-50"
          >
            {resetBusy ? "Resetting…" : "Reset Password (requires restart)"}
          </button>
          {resetErr ? (
            <p className="mt-2 text-xs text-red-400">{resetErr}</p>
          ) : null}
        </div>
      )}

      {sshKeyBundle && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ssh-key-save-title-vm"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl">
            <h2
              id="ssh-key-save-title-vm"
              className="text-lg font-semibold text-orange-400"
            >
              Download your new SSH private key
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
              This key is shown <span className="font-medium text-[var(--foreground)]">only now</span>.
              We never store it. Save the file somewhere safe, or you will lose SSH access via this
              key (password/console login still works).
            </p>
            <p className="mt-3 text-xs text-[var(--muted)]">
              Public key installed on the VM:
            </p>
            <div className="mt-1 break-all rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs">
              {sshKeyBundle.publicLine}
            </div>
            <label className="mt-4 block text-xs font-medium text-[var(--muted)]">
              Private key
            </label>
            <textarea
              readOnly
              className="mt-1 max-h-48 w-full resize-y rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)]"
              value={sshKeyBundle.privateKey}
              rows={10}
            />
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)]"
                onClick={() =>
                  downloadTextFile(
                    `deso-hosting-${(orderId ?? "vm").slice(0, 8)}.key`,
                    sshKeyBundle.privateKey
                  )
                }
              >
                Download private key
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--background)]"
                onClick={(e) =>
                  void copyVmLoginField(
                    sshKeyBundle.privateKey,
                    "private key",
                    e
                  )
                }
              >
                Copy private key
              </button>
            </div>
            <button
              type="button"
              className="mt-6 w-full rounded-lg border border-[var(--card-border)] py-3 text-sm font-medium hover:bg-[var(--background)]"
              onClick={() => {
                setSshKeyBundle(null);
              }}
            >
              I&apos;ve saved it — close
            </button>
          </div>
        </div>
      )}

      {copyToast ? (
        <div
          role="status"
          aria-live="polite"
          className={
            copyToast.isError
              ? "pointer-events-none fixed z-[10000] max-w-[18rem] rounded-lg border border-red-500/35 bg-[var(--card)] px-2.5 py-1.5 text-xs text-red-400 shadow-lg"
              : "pointer-events-none fixed z-[10000] max-w-[18rem] rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-2.5 py-1.5 text-xs text-green-400 shadow-lg"
          }
          style={{
            left: copyToast.x + 12,
            top: copyToast.y + 12,
          }}
        >
          {copyToast.message}
        </div>
      ) : null}
    </div>
  );
}
