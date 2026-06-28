/**
 * Proxmox VE API Client
 * Docs: https://pve.proxmox.com/wiki/Proxmox_VE_API
 */

import * as https from "node:https";
import axios, { type AxiosInstance } from "axios";
import { normalizeExtraDisksGb } from "@/lib/extra-disks";
import type { CloudInitPublicNetwork } from "@/lib/public-ip-pool";
import { resolveProxmoxDiskStoragePool, getProxmoxHostConfig } from "@/lib/proxmox-host-config";

const PROXMOX_HOST = process.env.PROXMOX_HOST || "localhost";
const PROXMOX_PORT = process.env.PROXMOX_PORT || "8006";
const PROXMOX_USERNAME = process.env.PROXMOX_USERNAME || "root@pam";
const PROXMOX_PASSWORD = process.env.PROXMOX_PASSWORD;
const PROXMOX_TOKEN_ID = process.env.PROXMOX_TOKEN_ID;
const PROXMOX_TOKEN_SECRET = process.env.PROXMOX_TOKEN_SECRET;

const BASE_URL = `https://${PROXMOX_HOST}:${PROXMOX_PORT}/api2/json`;

/**
 * application/x-www-form-urlencoded encoder for Proxmox.
 *
 * `URLSearchParams.toString()` encodes spaces as `+`. Several Proxmox endpoints
 * (notably `sshkeys`) decode values with Perl's `URI::Escape::uri_unescape`,
 * which only handles `%XX` escapes and treats `+` as a literal `+`. That makes
 * pasted SSH keys come through as `ssh-ed25519+AAAA...` and PVE returns 400.
 *
 * Use percent-encoded form bodies (spaces -> `%20`) so PVE round-trips values
 * containing spaces, newlines, or `+` correctly.
 */
function pveFormEncode(params: Record<string, string>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    out.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return out.join("&");
}

/**
 * Replace values for known sensitive form keys with `[REDACTED]` so error logs
 * never contain plaintext passwords / SSH keys. Keeps the rest of the body
 * intact for debugging.
 */
const SENSITIVE_PVE_FIELDS = [
  "cipassword",
  "sshkeys",
  "password",
  "vncticket",
];
function redactPveFormBody(body: string): string {
  let out = body;
  for (const f of SENSITIVE_PVE_FIELDS) {
    const re = new RegExp(`(^|&)(${f})=[^&]*`, "gi");
    out = out.replace(re, `$1$2=[REDACTED]`);
  }
  return out;
}

type AuthResult =
  | { type: "token"; authorization: string }
  | { type: "ticket"; ticket: string; csrfToken: string };

async function authenticate(): Promise<AuthResult> {
  if (PROXMOX_TOKEN_ID && PROXMOX_TOKEN_SECRET) {
    return {
      type: "token",
      authorization: `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`,
    };
  }

  const response = await axios.post(
    `${BASE_URL}/access/ticket`,
    new URLSearchParams({
      username: PROXMOX_USERNAME,
      password: PROXMOX_PASSWORD || "",
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      httpsAgent: new (await import("https")).Agent({
        rejectUnauthorized: false,
      }),
    }
  );

  return {
    type: "ticket",
    ticket: response.data.data.ticket,
    csrfToken: response.data.data.CSRFPreventionToken,
  };
}

function getAxiosConfig() {
  return {
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  };
}

export async function getProxmoxClient(): Promise<AxiosInstance> {
  const auth = await authenticate();

  const headers: Record<string, string> =
    auth.type === "token"
      ? { Authorization: auth.authorization }
      : {
          Cookie: `PVEAuthCookie=${auth.ticket}`,
          CSRFPreventionToken: auth.csrfToken,
        };

  const client = axios.create({
    baseURL: BASE_URL,
    ...getAxiosConfig(),
    headers,
  });

  client.interceptors.response.use(
    (r) => r,
    async (err) => {
      if (err.response?.status === 401 && auth.type === "ticket") {
        const freshAuth = await authenticate();
        if (freshAuth.type === "ticket") {
          err.config.headers.Cookie = `PVEAuthCookie=${freshAuth.ticket}`;
          err.config.headers.CSRFPreventionToken = freshAuth.csrfToken;
          return axios(err.config);
        }
      }
      const status = err.response?.status;
      if (status && status >= 400) {
        const data = err.response?.data;
        const cfg = err.config ?? {};
        console.error(
          `[Proxmox] ${cfg.method?.toUpperCase?.() ?? "REQ"} ${cfg.url ?? "?"} -> ${status} ${err.response?.statusText ?? ""}`
        );
        if (data !== undefined) {
          try {
            console.error("[Proxmox] response data:", JSON.stringify(data));
          } catch {
            console.error("[Proxmox] response data: [unserializable]");
          }
        }
        if (typeof cfg.data === "string" && cfg.data.length < 4000) {
          console.error("[Proxmox] request body:", redactPveFormBody(cfg.data));
        }
        const inner =
          (data && typeof data === "object" && (data as { errors?: unknown }).errors) || null;
        if (inner && typeof inner === "object") {
          for (const [field, msg] of Object.entries(inner)) {
            console.error(`[Proxmox] field error ${field}:`, msg);
          }
        }
      }
      throw err;
    }
  );

  return client;
}

/** Human-readable message from Proxmox axios errors (for API responses). */
export function formatProxmoxApiError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;

  const axiosErr = err as {
    response?: {
      status?: number;
      statusText?: string;
      data?: Record<string, unknown>;
    };
    message?: string;
  };

  const data = axiosErr.response?.data;
  if (data && typeof data === "object") {
    const msg = data.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();

    const errs = data.errors;
    if (errs && typeof errs === "object") {
      for (const v of Object.values(errs)) {
        if (typeof v === "string" && v.trim()) return v.trim();
        if (
          v &&
          typeof v === "object" &&
          "message" in v &&
          typeof (v as { message: unknown }).message === "string"
        ) {
          const m = (v as { message: string }).message.trim();
          if (m) return m;
        }
      }
    }
  }

  const status = axiosErr.response?.status;
  const statusText = axiosErr.response?.statusText;
  if (status) {
    return statusText
      ? `Proxmox error ${status}: ${statusText}`
      : `Proxmox error ${status}`;
  }

  if (typeof axiosErr.message === "string" && axiosErr.message) {
    return axiosErr.message;
  }

  return "Failed to execute VM action";
}

export interface VMStatus {
  vmid: number;
  node: string;
  status: "running" | "stopped" | "paused";
  name?: string;
  cpu?: number;
  mem?: number;
  maxmem?: number;
}

/** PVE qemu status/current returns lowercase in docs; normalize for robust UI checks. */
function normalizeQemuStatusField(raw: unknown): VMStatus["status"] {
  if (typeof raw !== "string") return "stopped";
  const s = raw.trim().toLowerCase();
  if (s === "running" || s === "stopped" || s === "paused") return s;
  return "stopped";
}

export async function getVMStatus(
  node: string,
  vmid: number
): Promise<VMStatus> {
  const client = await getProxmoxClient();
  const { data } = await client.get(
    `/nodes/${node}/qemu/${vmid}/status/current`
  );
  return {
    vmid,
    node,
    status: normalizeQemuStatusField(data.data.status),
    name: data.data.name,
    cpu: data.data.cpu,
    mem: data.data.mem,
    maxmem: data.data.maxmem,
  };
}

/**
 * Graceful ACPI shutdown, then force stop if needed. Returns whether the guest was running
 * before this call (caller may want to start again after maintenance).
 */
export async function haltVmForPlanMaintenance(
  node: string,
  vmid: number
): Promise<{ wasRunning: boolean }> {
  const client = await getProxmoxClient();
  let status: ReturnType<typeof normalizeQemuStatusField>;
  try {
    const { data } = await client.get(
      `/nodes/${node}/qemu/${vmid}/status/current`
    );
    status = normalizeQemuStatusField(data.data?.status);
  } catch {
    return { wasRunning: false };
  }

  if (status === "stopped") {
    return { wasRunning: false };
  }

  const wasRunning = status === "running" || status === "paused";

  await shutdownVM(node, vmid);
  try {
    await waitUntilVmStopped(client, node, vmid);
  } catch {
    await stopVM(node, vmid, { overruleShutdown: true });
    await waitUntilVmStopped(client, node, vmid);
  }

  return { wasRunning };
}

/** Parsed hardware from Proxmox VM config (/nodes/{node}/qemu/{vmid}/config). */
export interface VMParsedSpecs {
  vcpus: number;
  memoryMb: number;
  /** Ordered boot/data disks only (/CD-ROM / EFI-only / tpm excluded). Sizes in GB. */
  disksGb: number[];
}

const DISK_BUS_KEY =
  /^(?<bus>virtio|scsi|sata|ide)(?<idx>\d+)$/i;

function parseSizeToGb(fragment: string): number | null {
  if (/media=cdrom/i.test(fragment)) return null;
  const m = fragment.match(/(?:^|,)size=(?<n>[0-9.]+)(?<u>[KMGT])?(?=,|$)/i);
  if (!m?.groups?.n) return null;
  let value = parseFloat(m.groups.n);
  const unit = (m.groups.u || "G").toUpperCase();
  if (unit === "T") value *= 1024;
  else if (unit === "M") value /= 1024;
  else if (unit === "K") value /= 1024 * 1024;
  // G or default
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1000) / 1000;
}

function diskSortKey(bus: string, idx: number): number {
  const rank: Record<string, number> = {
    virtio: 0,
    scsi: 1,
    sata: 2,
    ide: 3,
  };
  return (rank[bus.toLowerCase()] ?? 50) * 1000 + idx;
}

/** Read qemu guest config from Proxmox and extract vCPU count, RAM, disk sizes (GB). */
export async function getVMParsedSpecs(
  node: string,
  vmid: number
): Promise<VMParsedSpecs> {
  const client = await getProxmoxClient();
  const { data } = await client.get(
    `/nodes/${node}/qemu/${vmid}/config`
  );
  const cfg = data.data as Record<string, unknown>;

  const cores = Math.max(
    1,
    parseInt(String(cfg.cores ?? 1), 10) || 1
  );
  const sockets = Math.max(
    1,
    parseInt(String(cfg.sockets ?? 1), 10) || 1
  );
  const vcpus = cores * sockets;

  const memoryMb = Math.max(
    0,
    parseInt(String(cfg.memory ?? 0), 10) || 0
  );

  const disks: { order: number; gb: number }[] = [];

  for (const [key, raw] of Object.entries(cfg)) {
    if (/^(efidisk|tpmstate|unused)/i.test(key)) continue;

    const busMatch = key.match(DISK_BUS_KEY);
    if (!busMatch?.groups?.bus || busMatch.groups.idx === undefined)
      continue;
    if (typeof raw !== "string") continue;

    const gb = parseSizeToGb(raw);
    if (gb === null) continue;

    const bus = busMatch.groups.bus;
    const idx = parseInt(busMatch.groups.idx, 10);
    disks.push({
      order: diskSortKey(bus, idx),
      gb,
    });
  }

  disks.sort((a, b) => a.order - b.order);
  const disksGb = disks.map((d) => d.gb);

  return { vcpus, memoryMb, disksGb };
}

/** Max time to poll a Proxmox async task (`upid`). `<= 0` in env → wait indefinitely. */
function parseTimeoutEnv(
  raw: string | undefined,
  fallback: number
): number | null {
  if (raw == null || raw.trim() === "") return fallback;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return null;
  return n;
}

function cloneTaskPollTimeoutMs(): number | null {
  return parseTimeoutEnv(
    process.env.PROXMOX_CLONE_TASK_TIMEOUT_MS,
    7_200_000 // 2h — full clones often exceed 2 minutes
  );
}

function vmStopWaitTimeoutMs(): number | null {
  return parseTimeoutEnv(process.env.PROXMOX_VM_STOP_TIMEOUT_MS, 900_000); // 15 min
}

function hardwareTaskPollTimeoutMs(): number | null {
  return parseTimeoutEnv(process.env.PROXMOX_HARDWARE_TASK_TIMEOUT_MS, 600_000); // 10 min
}

export function findPrimaryDiskKey(cfg: Record<string, unknown>): string | null {
  const candidates: { order: number; key: string }[] = [];

  for (const [key, raw] of Object.entries(cfg)) {
    if (/^(efidisk|tpmstate|unused)/i.test(key)) continue;

    const busMatch = key.match(DISK_BUS_KEY);
    if (!busMatch?.groups?.bus || busMatch.groups.idx === undefined) continue;
    if (typeof raw !== "string") continue;

    if (parseSizeToGb(raw) === null) continue;

    const bus = busMatch.groups.bus;
    const idx = parseInt(busMatch.groups.idx, 10);
    candidates.push({ order: diskSortKey(bus, idx), key });
  }

  candidates.sort((a, b) => a.order - b.order);
  return candidates[0]?.key ?? null;
}

/** First volume segment `pool:...` from a qemu disk line (not import-from / paths). */
function parseStoragePoolFromDiskValue(frag: string): string | null {
  if (!frag || /import-from/i.test(frag)) return null;
  const head = frag.split(",")[0].trim();
  const idx = head.indexOf(":");
  if (idx <= 0) return null;
  const pool = head.slice(0, idx).trim();
  if (!pool || pool.includes("/")) return null;
  return pool;
}

async function resolveDiskStoragePoolForGuest(
  cfg: Record<string, unknown>,
  primaryDiskKey: string | null
): Promise<string> {
  if (primaryDiskKey) {
    const raw = cfg[primaryDiskKey];
    if (typeof raw === "string") {
      const p = parseStoragePoolFromDiskValue(raw);
      if (p) return p;
    }
  }
  return resolveProxmoxDiskStoragePool();
}

function maxSuffixIndexForBus(
  cfg: Record<string, unknown>,
  busLc: string
): number {
  const prefix = busLc.toLowerCase();
  let max = -1;
  const re = new RegExp(`^${prefix}(\\d+)$`, "i");
  for (const k of Object.keys(cfg)) {
    const m = k.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

function pickExtraDiskAttachBus(primaryKey: string | null): string {
  if (!primaryKey) return "virtio";
  const m = primaryKey.match(DISK_BUS_KEY);
  const bus = (m?.groups?.bus || "virtio").toLowerCase();
  if (bus === "ide") return "virtio";
  return bus;
}

/**
 * Extra data volumes excluding the VM boot/root disk — same conventions as attachExtraDataDisksToVM
 * (`pickExtraDiskAttachBus`/slot numbering). Sorted by ascending slot index.
 */
export function listManagedExtraGuestDiskVolumes(
  cfg: Record<string, unknown>
): { key: string; sizeGb: number }[] {
  const primaryDiskKey = findPrimaryDiskKey(cfg);
  const attachBus = pickExtraDiskAttachBus(primaryDiskKey);
  const re = new RegExp(`^${attachBus}(\\d+)$`, "i");

  const primaryLc = primaryDiskKey?.toLowerCase() ?? null;
  const hits: { key: string; sizeGb: number; idx: number }[] = [];

  for (const [keyRaw, raw] of Object.entries(cfg)) {
    if (/^(unused|efidisk|tpmstate)/i.test(keyRaw)) continue;
    const m = keyRaw.match(re);
    if (!m?.[2] || typeof raw !== "string") continue;
    const gb = parseSizeToGb(raw);
    if (gb === null) continue;

    const keyNorm = keyRaw.toLowerCase();
    if (primaryLc && keyNorm === primaryLc) continue;

    const idx = parseInt(m[2], 10);
    hits.push({ key: keyRaw, sizeGb: gb, idx });
  }

  hits.sort((a, b) => a.idx - b.idx);
  return hits.map(({ key, sizeGb }) => ({ key, sizeGb }));
}

export async function attachExtraDataDisksToVM(
  client: AxiosInstance,
  node: string,
  vmid: number,
  cfg: Record<string, unknown>,
  primaryDiskKey: string | null,
  sizesGb: number[]
): Promise<void> {
  if (sizesGb.length === 0) return;
  const pool = await resolveDiskStoragePoolForGuest(cfg, primaryDiskKey);
  const attachBus = pickExtraDiskAttachBus(primaryDiskKey);
  let slot = maxSuffixIndexForBus(cfg, attachBus) + 1;

  const params: Record<string, string> = {};
  for (const gb of sizesGb) {
    params[`${attachBus}${slot}`] = `${pool}:${gb}`;
    slot += 1;
  }

  const res = await client.post(
    `/nodes/${node}/qemu/${vmid}/config`,
    pveFormEncode(params),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const upid = res.data?.data;
  if (typeof upid === "string" && upid.startsWith("UPID:")) {
    await waitForTask(
      client,
      upid,
      node,
      hardwareTaskPollTimeoutMs(),
      "qemu-config"
    );
  }
}

/** Remove a QEMU guest disk attachment (`virtioX` / `scsiX`, …); does not reclaim storage chunks on nodes. */
export async function detachQemuGuestDiskAttachment(
  node: string,
  vmid: number,
  diskKey: string
): Promise<void> {
  const client = await getProxmoxClient();
  const body = new URLSearchParams();
  body.set("delete", diskKey);
  const res = await client.post(
    `/nodes/${node}/qemu/${vmid}/config`,
    body.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  const upid = res.data?.data;
  if (typeof upid === "string" && upid.startsWith("UPID:")) {
    await waitForTask(
      client,
      upid,
      node,
      hardwareTaskPollTimeoutMs(),
      "qemu-disk-detach"
    );
  }
}

async function waitUntilVmStopped(
  client: AxiosInstance,
  node: string,
  vmid: number,
  timeoutMs: number | null = vmStopWaitTimeoutMs()
): Promise<void> {
  const start = Date.now();
  while (timeoutMs === null || Date.now() - start < timeoutMs) {
    const { data } = await client.get(
      `/nodes/${node}/qemu/${vmid}/status/current`
    );
    const status = data.data?.status;
    if (status === "stopped") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timeout waiting for VM to stop");
}

async function resizeVmDiskAbsolute(
  client: AxiosInstance,
  node: string,
  vmid: number,
  diskKey: string,
  sizeSpec: string
): Promise<void> {
  const body = new URLSearchParams();
  body.set("disk", diskKey);
  body.set("size", sizeSpec);
  const opts = {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };

  try {
    await client.put(`/nodes/${node}/qemu/${vmid}/resize`, body.toString(), opts);
    return;
  } catch (putErr: unknown) {
    const status = (putErr as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === 405 || status === 501) {
      await client.post(
        `/nodes/${node}/qemu/${vmid}/resize`,
        body.toString(),
        opts
      );
      return;
    }
    throw putErr;
  }
}

/**
 * Apply plan vCPU, RAM (MB), and root disk size (GB) after a full clone.
 * Stops the VM if it is running, updates config, then grows the primary disk if needed (no shrink).
 * Optional cloud-init user/password requires a template with cloud-init (e.g. nocloud on ide2 scsi).
 * Optional cloud-init `network` sets Proxmox `ipconfig0` (static IP + gateway) for the guest.
 * Optional extraDisksGb: additional virtio/scsi volumes on the primary disk storage pool after root resize.
 */
export async function applyServiceHardwareToVM(
  node: string,
  vmid: number,
  specs: { vcpu: number; ramMb: number; storageGb: number },
  options?: {
    cloudInit?: {
      ciuser: string;
      cipassword: string;
      network?: CloudInitPublicNetwork;
      nameserver?: string;
      /** OpenSSH authorized_keys lines; Proxmox expects URL-encoding via form body. */
      sshkeys?: string;
    };
    extraDisksGb?: unknown;
    /**
     * Second virtio NIC (typically `net1`) on a VLAN-tagged bridge for private VM-to-VM networking.
     * Requires a VLAN-aware Proxmox bridge (see PROXMOX_PRIVATE_LAN_BRIDGE).
     */
    privateLan?: {
      ip: string;
      prefixLen: number;
      vlanTag: number;
      bridge?: string;
    };
    /**
     * When true (e.g. plan change): do not attach new extra-data volumes — they already exist.
     */
    skipAttachExtraVolumes?: boolean;
  }
): Promise<void> {
  const client = await getProxmoxClient();

  try {
    const { data } = await client.get(
      `/nodes/${node}/qemu/${vmid}/status/current`
    );
    const status = data.data?.status;
    if (status === "running" || status === "paused") {
      await stopVM(node, vmid);
      await waitUntilVmStopped(client, node, vmid);
    }
  } catch {
    /* New clone may briefly lack status; continue with config */
  }

  const { data: cfgRes } = await client.get(
    `/nodes/${node}/qemu/${vmid}/config`
  );
  let cfg = cfgRes.data as Record<string, unknown>;

  if (!options?.privateLan) {
    const del: string[] = [];
    if (typeof cfg.net1 === "string") del.push("net1");
    if (typeof cfg.ipconfig1 === "string") del.push("ipconfig1");
    if (del.length > 0) {
      const body = new URLSearchParams();
      body.set("delete", del.join(","));
      await client.post(
        `/nodes/${node}/qemu/${vmid}/config`,
        body.toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }
      );
      const { data: cfgFresh } = await client.get(
        `/nodes/${node}/qemu/${vmid}/config`
      );
      cfg = cfgFresh.data as Record<string, unknown>;
    }
  }

  const configParams: Record<string, string> = {
    cores: String(Math.max(1, Math.floor(specs.vcpu))),
    sockets: "1",
    memory: String(Math.max(32, Math.floor(specs.ramMb))),
  };

  const ci = options?.cloudInit;
  if (ci?.ciuser && ci.cipassword) {
    configParams.ciuser = ci.ciuser;
    configParams.cipassword = ci.cipassword;
  }
  if (ci?.network?.ip) {
    configParams.ipconfig0 = `ip=${ci.network.ip}/${ci.network.prefixLen},gw=${ci.network.gateway}`;
  }
  if (ci?.nameserver?.trim()) {
    configParams.nameserver = ci.nameserver.trim();
  }
  if (ci?.sshkeys?.trim()) {
    // Proxmox quirk: the `sshkeys` parameter is declared as type `urlencoded`. The PVE HTTP
    // layer form-decodes the body once (so `%20` -> ` `), and the validator then expects the
    // value to *still* be URL-encoded — PVE itself runs `uri_unescape` on it before writing
    // the cloud-init drive. We must pre-encode here so the post-form-decode value is the
    // percent-encoded form PVE wants. (Without this we get `400 invalid urlencoded string`.)
    configParams.sshkeys = encodeURIComponent(ci.sshkeys.trim());
  }

  const pl = options?.privateLan;
  if (
    pl &&
    pl.ip?.trim() &&
    Number.isInteger(pl.prefixLen) &&
    pl.prefixLen > 0 &&
    Number.isInteger(pl.vlanTag) &&
    pl.vlanTag >= 1 &&
    pl.vlanTag <= 4094
  ) {
    const bridge =
      pl.bridge?.trim() ||
      process.env.PROXMOX_PRIVATE_LAN_BRIDGE?.trim() ||
      "vmbr0";
    configParams.net1 = `virtio,bridge=${bridge},tag=${pl.vlanTag}`;
    configParams.ipconfig1 = `ip=${pl.ip.trim()}/${pl.prefixLen}`;
  }

  await client.post(
    `/nodes/${node}/qemu/${vmid}/config`,
    pveFormEncode(configParams),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  const diskKey = findPrimaryDiskKey(cfg);

  if (
    diskKey &&
    specs.storageGb > 0 &&
    typeof cfg[diskKey] === "string"
  ) {
    const raw = cfg[diskKey] as string;
    const currentGb = parseSizeToGb(raw);
    if (currentGb !== null && specs.storageGb > currentGb + 1e-9) {
      const deltaGb = specs.storageGb - currentGb;
      const deltaMb = Math.max(1, Math.ceil(deltaGb * 1024));
      await resizeVmDiskAbsolute(
        client,
        node,
        vmid,
        diskKey,
        `+${deltaMb}M`
      );
    }
  }

  const extraGb = normalizeExtraDisksGb(options?.extraDisksGb);
  if (!options?.skipAttachExtraVolumes && extraGb.length > 0) {
    const { data: cfgAfterRes } = await client.get(
      `/nodes/${node}/qemu/${vmid}/config`
    );
    const cfgAfter = cfgAfterRes.data as Record<string, unknown>;
    const primaryStill = diskKey ?? findPrimaryDiskKey(cfgAfter);

    await attachExtraDataDisksToVM(
      client,
      node,
      vmid,
      cfgAfter,
      primaryStill,
      extraGb
    );
  }

  const needCiDrive =
    Boolean(ci?.ciuser && ci?.cipassword) ||
    Boolean(ci?.network?.ip) ||
    Boolean(ci?.sshkeys?.trim()) ||
    Boolean(options?.privateLan?.ip?.trim());
  if (needCiDrive) {
    await regenerateCloudInitDrive(client, node, vmid);
  }
}

async function regenerateCloudInitDrive(
  client: AxiosInstance,
  node: string,
  vmid: number
): Promise<void> {
  const path = `/nodes/${node}/qemu/${vmid}/cloudinit`;
  const hdr = {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
  try {
    await client.put(path, "", hdr);
    return;
  } catch (putErr) {
    try {
      await client.post(path, "", hdr);
      return;
    } catch {
      throw putErr;
    }
  }
}

/**
 * Read cloud-init linux user from QEMU config (fallback when portal did not persist vmLoginUsername).
 */
export async function getQemuCloudInitCiuser(
  node: string,
  vmid: number
): Promise<string | null> {
  const client = await getProxmoxClient();
  const { data } = await client.get(`/nodes/${node}/qemu/${vmid}/config`);
  const ci = (data.data as Record<string, unknown>)?.ciuser;
  return typeof ci === "string" && ci.trim() ? ci.trim() : null;
}

/**
 * Set ciuser/cipassword, regenerate the cloud-init drive, restart if the guest was running.
 * VM should be halted for consistent ISO regen — we shutdown gracefully when possible.
 */
export async function applyCloudInitPasswordAndRegenerate(
  node: string,
  vmid: number,
  ciuser: string,
  cipassword: string
): Promise<void> {
  const client = await getProxmoxClient();

  let wasRunning = false;
  try {
    const { data } = await client.get(
      `/nodes/${node}/qemu/${vmid}/status/current`
    );
    const status = data.data?.status as string | undefined;
    wasRunning = status === "running" || status === "paused";
  } catch {
    /* Treat as not running */
  }

  if (wasRunning) {
    await shutdownVM(node, vmid);
    await waitUntilVmStopped(client, node, vmid);
  }

  await client.post(
    `/nodes/${node}/qemu/${vmid}/config`,
    pveFormEncode({ ciuser, cipassword }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );

  await regenerateCloudInitDrive(client, node, vmid);

  if (wasRunning) {
    await startVM(node, vmid);
  }
}

/**
 * Set or clear cloud-init `sshkeys`, regenerate the cloud-init drive, restart the VM if it was running.
 *
 * - `sshkeys = ""`/`null` clears the keys (`delete=sshkeys` against PVE).
 * - Otherwise the value is `encodeURIComponent`-pre-encoded so PVE's `urlencoded` parameter validator
 *   accepts it (see `applyServiceHardwareToVM` for the full explanation).
 *
 * The VM is shut down gracefully (so cloud-init regen is consistent) and started again when needed.
 */
export async function applyCloudInitSshKeysAndRegenerate(
  node: string,
  vmid: number,
  sshkeys: string | null
): Promise<void> {
  const client = await getProxmoxClient();

  let wasRunning = false;
  try {
    const { data } = await client.get(
      `/nodes/${node}/qemu/${vmid}/status/current`
    );
    const status = data.data?.status as string | undefined;
    wasRunning = status === "running" || status === "paused";
  } catch {
    /* Treat as not running */
  }

  if (wasRunning) {
    await shutdownVM(node, vmid);
    await waitUntilVmStopped(client, node, vmid);
  }

  const trimmed = sshkeys?.trim() ?? "";
  const body = trimmed
    ? pveFormEncode({ sshkeys: encodeURIComponent(trimmed) })
    : "delete=sshkeys";
  await client.post(
    `/nodes/${node}/qemu/${vmid}/config`,
    body,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  await regenerateCloudInitDrive(client, node, vmid);

  if (wasRunning) {
    await startVM(node, vmid);
  }
}

export async function startVM(node: string, vmid: number): Promise<void> {
  const client = await getProxmoxClient();
  await client.post(`/nodes/${node}/qemu/${vmid}/status/start`);
}

export async function stopVM(
  node: string,
  vmid: number,
  options?: { overruleShutdown?: boolean }
): Promise<void> {
  const client = await getProxmoxClient();
  if (options?.overruleShutdown) {
    const body = new URLSearchParams();
    body.set("overrule-shutdown", "1");
    await client.post(
      `/nodes/${node}/qemu/${vmid}/status/stop`,
      body.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    return;
  }
  await client.post(`/nodes/${node}/qemu/${vmid}/status/stop`);
}

export async function shutdownVM(node: string, vmid: number): Promise<void> {
  const client = await getProxmoxClient();
  await client.post(`/nodes/${node}/qemu/${vmid}/status/shutdown`);
}

export async function rebootVM(node: string, vmid: number): Promise<void> {
  const client = await getProxmoxClient();
  await client.post(`/nodes/${node}/qemu/${vmid}/status/reboot`);
}

export async function resetVM(node: string, vmid: number): Promise<void> {
  const client = await getProxmoxClient();
  await client.post(`/nodes/${node}/qemu/${vmid}/status/reset`);
}

function restoreTaskPollTimeoutMs(): number | null {
  return parseTimeoutEnv(
    process.env.PROXMOX_RESTORE_TASK_TIMEOUT_MS,
    7_200_000 // 2h — large backup restores can run a long time
  );
}

function formatBackupSizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const digits = u >= 2 ? 1 : 0;
  return `${n.toFixed(digits)} ${units[u]}`;
}

function formatBackupLabel(
  volid: string,
  ctimeSec: number,
  sizeBytes: number
): string {
  const base =
    ctimeSec > 0
      ? new Date(ctimeSec * 1000).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : volid.split("/").pop() ?? volid;
  const size = formatBackupSizeBytes(sizeBytes);
  return `${base} · ${size}`;
}

export type VmBackupListItem = {
  volid: string;
  label: string;
  sizeBytes: number;
  createdAt: string;
  format: string;
};

/** List vzdump archives for a guest on a Proxmox storage pool. */
export async function listVmBackups(
  node: string,
  vmid: number,
  storagePool: string
): Promise<VmBackupListItem[]> {
  const client = await getProxmoxClient();
  const { data } = await client.get(
    `/nodes/${node}/storage/${encodeURIComponent(storagePool)}/content`,
    { params: { content: "backup", vmid } }
  );
  const rows = Array.isArray(data.data) ? data.data : [];
  const items: VmBackupListItem[] = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const volid = rec.volid;
    if (typeof volid !== "string" || !volid.trim()) continue;

    const rowVmid =
      typeof rec.vmid === "number"
        ? rec.vmid
        : typeof rec.vmid === "string"
          ? parseInt(rec.vmid, 10)
          : NaN;
    if (Number.isFinite(rowVmid) && rowVmid !== vmid) continue;

    const vzMatch = volid.match(/vzdump-qemu-(\d+)-/);
    if (vzMatch && parseInt(vzMatch[1]!, 10) !== vmid) continue;

    const ctime =
      typeof rec.ctime === "number"
        ? rec.ctime
        : typeof rec.ctime === "string"
          ? parseInt(rec.ctime, 10)
          : 0;
    const size =
      typeof rec.size === "number"
        ? rec.size
        : typeof rec.size === "string"
          ? parseInt(rec.size, 10)
          : 0;
    const format =
      typeof rec.format === "string" && rec.format.trim()
        ? rec.format.trim()
        : "unknown";

    items.push({
      volid,
      label: formatBackupLabel(volid, ctime, size),
      sizeBytes: Number.isFinite(size) ? size : 0,
      createdAt: ctime > 0 ? new Date(ctime * 1000).toISOString() : "",
      format,
    });
  }

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items;
}

/**
 * Stop the guest, restore from a vzdump archive over the existing VMID, then start it again.
 */
export async function restoreVmFromBackup(
  node: string,
  vmid: number,
  archiveVolid: string
): Promise<void> {
  const client = await getProxmoxClient();

  try {
    const { data } = await client.get(
      `/nodes/${node}/qemu/${vmid}/status/current`
    );
    const status = data.data?.status as string | undefined;
    if (status === "running" || status === "paused") {
      await stopVM(node, vmid, { overruleShutdown: true });
      await waitUntilVmStopped(client, node, vmid);
    }
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status !== 404) throw err;
  }

  const params = new URLSearchParams();
  params.set("vmid", String(vmid));
  params.set("archive", archiveVolid);
  params.set("force", "1");
  params.set("start", "0");

  const res = await client.post(
    `/nodes/${node}/qemu`,
    params.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const upid = res.data?.data;
  if (typeof upid === "string" && upid.startsWith("UPID:")) {
    await waitForTask(
      client,
      upid,
      node,
      restoreTaskPollTimeoutMs(),
      "restore"
    );
  }

  await startVM(node, vmid);
}

export async function destroyVM(node: string, vmid: number): Promise<void> {
  const client = await getProxmoxClient();
  await client.delete(`/nodes/${node}/qemu/${vmid}`);
}

/**
 * Remove the private-LAN virtio NIC (`net1`) and cloud-init `ipconfig1`, then regenerate
 * cloud-init when other CI fields exist. Restarts the VM if it was running.
 */
export async function removePrivateLanFromVM(
  node: string,
  vmid: number
): Promise<void> {
  const client = await getProxmoxClient();

  let wasRunning = false;
  try {
    const { data } = await client.get(
      `/nodes/${node}/qemu/${vmid}/status/current`
    );
    const status = data.data?.status as string | undefined;
    wasRunning = status === "running" || status === "paused";
  } catch {
    /* treat as stopped */
  }

  if (wasRunning) {
    await stopVM(node, vmid);
    await waitUntilVmStopped(client, node, vmid);
  }

  const { data: cfgRes } = await client.get(
    `/nodes/${node}/qemu/${vmid}/config`
  );
  const cfg = cfgRes.data as Record<string, unknown>;

  const del: string[] = [];
  if (typeof cfg.net1 === "string") del.push("net1");
  if (typeof cfg.ipconfig1 === "string") del.push("ipconfig1");

  if (del.length > 0) {
    const body = new URLSearchParams();
    body.set("delete", del.join(","));
    await client.post(
      `/nodes/${node}/qemu/${vmid}/config`,
      body.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
  }

  const needRegen =
    Boolean(cfg.ciuser) ||
    Boolean(cfg.ipconfig0) ||
    Boolean(cfg.sshkeys);
  if (needRegen) {
    await regenerateCloudInitDrive(client, node, vmid);
  }

  if (wasRunning) {
    await startVM(node, vmid);
  }
}

/** Update guest display name in Proxmox (QEMU config `name`). */
export async function setVMDisplayName(
  node: string,
  vmid: number,
  name: string
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Name is required");
  }
  if (trimmed.length > 255) {
    throw new Error("Name must be at most 255 characters");
  }

  const client = await getProxmoxClient();
  const configParams = new URLSearchParams();
  configParams.set("name", trimmed);
  await client.post(
    `/nodes/${node}/qemu/${vmid}/config`,
    configParams.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
}

export async function getVNCProxy(
  node: string,
  vmid: number
): Promise<{ ticket: string; port: string; cert: string }> {
  const client = await getProxmoxClient();
  const { data } = await client.post(
    `/nodes/${node}/qemu/${vmid}/vncproxy`,
    new URLSearchParams({ websocket: "1" }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return data.data;
}

export async function getClusterResources(): Promise<
  Array<{
    vmid: number;
    node: string;
    name: string;
    status: string;
    type: string;
  }>
> {
  const client = await getProxmoxClient();
  const { data } = await client.get("/cluster/resources?type=vm");
  return data.data
    .filter((r: { type: string }) => r.type === "qemu")
    .map((r: { vmid: number; node: string; name: string; status: string }) => ({
      vmid: r.vmid,
      node: r.node,
      name: r.name,
      status: r.status,
      type: "qemu",
    }));
}

/** Per-hypervisor capacity from `/cluster/resources?type=node` (CPU + RAM). */
export interface ClusterNodeResources {
  node: string;
  status: string;
  maxcpu: number;
  cpu: number;
  maxmem: number;
  mem: number;
}

export async function getClusterNodeResources(): Promise<
  ClusterNodeResources[]
> {
  const client = await getProxmoxClient();
  const { data } = await client.get("/cluster/resources?type=node");
  if (!Array.isArray(data.data)) return [];
  return data.data
    .filter((r: { type?: string }) => r.type === "node")
    .map((r: Record<string, unknown>) => {
      let nodeName = "";
      if (typeof r.node === "string" && r.node.trim()) {
        nodeName = r.node.trim();
      } else if (
        typeof r.id === "string" &&
        r.id.toLowerCase().startsWith("node/")
      ) {
        nodeName = r.id.slice("node/".length).trim();
      }
      return {
        node: nodeName,
        status: String(r.status ?? ""),
        maxcpu: Number(r.maxcpu) || 0,
        cpu: Number(r.cpu) || 0,
        maxmem: Number(r.maxmem) || 0,
        mem: Number(r.mem) || 0,
      };
    })
    .filter(
      (r: { node: string; status: string; maxcpu: number; cpu: number; maxmem: number; mem: number }) =>
        r.node.length > 0
    );
}

function pickBestNodeForNewVm(
  onlineNodes: ClusterNodeResources[],
  templateNode: string,
  specs: { ramMb: number }
): string {
  const requiredBytes = Math.ceil(specs.ramMb * 1024 * 1024 * 1.05);
  const candidates = onlineNodes.filter(
    (n) =>
      n.maxmem > 0 &&
      n.maxcpu > 0 &&
      n.maxmem - n.mem >= requiredBytes
  );
  if (candidates.length === 0) {
    console.warn(
      "[Proxmox] No online node has enough free RAM for this plan; using template node",
      { templateNode, requiredBytes, ramMb: specs.ramMb }
    );
    return templateNode;
  }

  const scored = candidates.map((n) => {
    const freeMem = Math.max(0, n.maxmem - n.mem);
    const memRatio = freeMem / n.maxmem;
    const cpuUtil = Math.min(1, Math.max(0, n.cpu));
    const cpuHeadroom = 1 - cpuUtil;
    const score = 0.55 * memRatio + 0.45 * cpuHeadroom;
    return { node: n.node, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.node;
}

/**
 * Pick the hypervisor with the best headroom (free RAM + low CPU utilization) for a new VM.
 * When only one node is online, returns `templateNode`.
 * Cross-node provisioning uses Proxmox clone `target` (typically requires shared storage).
 * Set `PROXMOX_AUTO_PLACE_VMS=0` to disable and always clone on the template node.
 */
export async function pickBestProvisioningNode(
  templateNode: string,
  specs: { ramMb: number; vcpu: number }
): Promise<string> {
  const hostCfg = await getProxmoxHostConfig();
  if (!hostCfg.effectiveAutoPlaceNewVms) {
    return templateNode;
  }
  try {
    const nodes = await getClusterNodeResources();
    const online = nodes.filter((n) => n.status === "online");
    if (online.length <= 1) {
      return templateNode;
    }
    return pickBestNodeForNewVm(online, templateNode, { ramMb: specs.ramMb });
  } catch (e) {
    console.warn(
      "[Proxmox] pickBestProvisioningNode failed; using template node:",
      e
    );
    return templateNode;
  }
}

/** Get next available VMID (max existing + 1, min 100) */
export async function getNextVMID(): Promise<number> {
  const resources = await getClusterResources();
  const maxId = resources.length > 0
    ? Math.max(...resources.map((r) => r.vmid))
    : 99;
  return maxId + 1;
}

/** Clone VM from template. Returns new VMID when task completes. */
export async function cloneVM(
  node: string,
  templateVmid: number,
  newVmid: number,
  name?: string,
  fullClone = true,
  options?: { target?: string; storage?: string }
): Promise<number> {
  const client = await getProxmoxClient();
  const params = new URLSearchParams();
  params.set("newid", String(newVmid));
  params.set("full", fullClone ? "1" : "0");
  if (name) params.set("name", name);
  if (fullClone) {
    params.set(
      "storage",
      options?.storage?.trim() || (await resolveProxmoxDiskStoragePool())
    );
  }
  const target = options?.target?.trim();
  if (target && target !== node) {
    params.set("target", target);
  }

  // Proxmox requires x-www-form-urlencoded; JSON body returns 501
  const bodyString = params.toString();
  const url = `${BASE_URL}/nodes/${node}/qemu/${templateVmid}/clone`;
  console.log("[Proxmox] POST", url);
  console.log("[Proxmox] Request body:", bodyString);

  let res;
  try {
    res = await client.post(
      `/nodes/${node}/qemu/${templateVmid}/clone`,
      bodyString,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status: number; data: unknown } };
    console.log("[Proxmox] Response status:", axiosErr.response?.status ?? "N/A");
    console.log("[Proxmox] Response data:", JSON.stringify(axiosErr.response?.data ?? err, null, 2));
    throw err;
  }

  console.log("[Proxmox] Response status:", res.status);
  console.log("[Proxmox] Response data:", JSON.stringify(res.data, null, 2));

  const upid = res.data.data;
  await waitForTask(
    client,
    upid,
    node,
    cloneTaskPollTimeoutMs(),
    "clone"
  );
  return newVmid;
}

async function waitForTask(
  client: AxiosInstance,
  upid: string,
  node: string,
  timeoutMs: number | null = 120000,
  label = "task"
): Promise<void> {
  const start = Date.now();
  while (timeoutMs === null || Date.now() - start < timeoutMs) {
    const { data } = await client.get(
      `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`
    );
    const status = data.data?.status;
    if (status === "stopped") {
      const exitstatus = data.data?.exitstatus;
      if (exitstatus !== "OK") {
        throw new Error(`Proxmox task failed: ${exitstatus || "unknown"}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const limitLabel =
    timeoutMs === null ? "unbounded (misconfiguration)" : `${timeoutMs}ms`;
  throw new Error(`Proxmox ${label} task timed out after ${limitLabel}`);
}
