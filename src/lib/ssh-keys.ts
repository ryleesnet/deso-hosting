import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_SSH_KEYS_TOTAL_CHARS = 16_000;
const MAX_SSH_KEY_LINES = 8;

/** One line of `authorized_keys` / OpenSSH public key format. */
const OPENSSH_PUBLIC_KEY_LINE =
  /^(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+\S+/;

export type SshAuthForOrder = "none" | "paste" | "generate";

export function parseSshAuthFromBody(raw: unknown): SshAuthForOrder {
  if (raw === "paste" || raw === "generate" || raw === "none") return raw;
  return "none";
}

/**
 * Validate pasted authorized_keys material (one OpenSSH public key per line).
 * Returns a single string suitable for Proxmox `sshkeys` (newline-separated).
 */
export function normalizeAndValidateSshPublicKeysInput(
  raw: string
):
  | { ok: true; cloudInitSshKeys: string }
  | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Paste at least one SSH public key line." };
  }
  if (trimmed.length > MAX_SSH_KEYS_TOTAL_CHARS) {
    return {
      ok: false,
      error: `SSH keys are too long (max ${MAX_SSH_KEYS_TOTAL_CHARS} characters).`,
    };
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > MAX_SSH_KEY_LINES) {
    return {
      ok: false,
      error: `At most ${MAX_SSH_KEY_LINES} public keys.`,
    };
  }
  for (let i = 0; i < lines.length; i++) {
    if (!OPENSSH_PUBLIC_KEY_LINE.test(lines[i])) {
      return {
        ok: false,
        error: `Line ${i + 1} is not a recognized OpenSSH public key (ssh-ed25519, ssh-rsa, etc.).`,
      };
    }
  }
  return { ok: true, cloudInitSshKeys: lines.join("\n") };
}

/**
 * Build an `ssh-keygen -C` comment from a DeSo username (or fallback) so the generated
 * public key line ends with `<user>@desohosting` instead of the host login of the server
 * running the app. Strips characters that would break authorized_keys parsing.
 */
export function sshKeyCommentForDesoUser(
  desoUsername: string | null | undefined,
  publicKeyBase58?: string
): string {
  const cleanUsername = (desoUsername ?? "")
    .trim()
    .replace(/^@/, "")
    .replace(/[^A-Za-z0-9._-]/g, "");
  if (cleanUsername) return `${cleanUsername}@desohosting`;

  const slug = (publicKeyBase58 ?? "")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 16);
  return slug ? `${slug}@desohosting` : "user@desohosting";
}

/**
 * Uses system `ssh-keygen` (OpenSSH). Ensure `openssh-client` is installed where the app runs.
 *
 * `comment` populates the trailing `<comment>` on the public key line (`ssh-keygen -C ...`).
 * Pass a string built via `sshKeyCommentForDesoUser` so users see e.g. `desohandle@desohosting`
 * in their authorized_keys instead of the build host's login.
 */
export function generateEd25519SshKeypairForVm(
  comment?: string
): {
  privateKeyOpenssh: string;
  publicKeyLine: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "deso-ssh-"));
  const keyPath = join(dir, "key");
  try {
    const args = [
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      keyPath,
      "-q",
    ];
    const trimmedComment = comment?.trim();
    if (trimmedComment) {
      args.push("-C", trimmedComment);
    }
    execFileSync("ssh-keygen", args, {
      stdio: "ignore",
      timeout: 20_000,
    });
    const privateKeyOpenssh = readFileSync(keyPath, "utf8");
    const publicKeyLine = readFileSync(`${keyPath}.pub`, "utf8").trim();
    if (!publicKeyLine || !privateKeyOpenssh.includes("BEGIN OPENSSH PRIVATE KEY")) {
      throw new Error("ssh-keygen produced unexpected output");
    }
    return { privateKeyOpenssh, publicKeyLine };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not generate SSH keys (${msg}). Install OpenSSH client (ssh-keygen) on the server, or paste your own public key instead.`
    );
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
