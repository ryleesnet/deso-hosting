/**
 * Server-side JSONL file logger with rolling daily files and 30-day retention.
 *
 * Files: `{LOG_DIR}/app-YYYY-MM-DD.jsonl` (default `./logs`).
 * Console.warn / console.error on the Node runtime are mirrored into the file
 * so existing failure sites are captured without rewriting every call.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export const LOG_CATEGORIES = [
  "proxmox",
  "payment",
  "billing",
  "provision",
  "vm",
  "network",
  "admin",
  "auth",
  "system",
] as const;

export type LogCategory = (typeof LOG_CATEGORIES)[number];
export type LogLevel = "info" | "warn" | "error";

export const LOG_CATEGORY_LABELS: Record<LogCategory, string> = {
  proxmox: "Proxmox",
  payment: "Payment",
  billing: "Billing",
  provision: "Provision",
  vm: "VM",
  network: "Network",
  admin: "Admin",
  auth: "Auth",
  system: "System",
};

export type LogContext = {
  userId?: string;
  actorId?: string;
  username?: string;
  orderId?: string;
  vmid?: number;
  node?: string;
  category?: LogCategory;
};

export type AppLogEntry = {
  id: string;
  ts: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  userId?: string;
  actorId?: string;
  username?: string;
  orderId?: string;
  vmid?: number;
  node?: string;
  details?: string;
};

export type QueryAppLogsOptions = {
  category?: LogCategory | "";
  user?: string;
  level?: LogLevel | "";
  q?: string;
  limit?: number;
  before?: string;
};

const DEFAULT_RETENTION_DAYS = 30;
const FILE_RE = /^app-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DESO_KEY_RE =
  /[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{50,120}/;
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const als = new AsyncLocalStorage<LogContext>();

const CAPTURE_FLAG = "__desoHostingFileLogCapture" as const;

type CaptureGlobals = typeof globalThis & {
  [CAPTURE_FLAG]?: {
    error: typeof console.error;
    warn: typeof console.warn;
  };
};

function captureState(): CaptureGlobals[typeof CAPTURE_FLAG] | undefined {
  return (globalThis as CaptureGlobals)[CAPTURE_FLAG];
}

let originalConsoleError: typeof console.error | null =
  captureState()?.error ?? null;
let originalConsoleWarn: typeof console.warn | null =
  captureState()?.warn ?? null;
let writeChain: Promise<void> = Promise.resolve();
let lastPrunedAt = 0;

function isNodeServer(): boolean {
  return (
    typeof window === "undefined" &&
    typeof process !== "undefined" &&
    process.env.NEXT_RUNTIME !== "edge"
  );
}

export function logRetentionDays(): number {
  const raw = process.env.LOG_RETENTION_DAYS?.trim();
  const n = raw ? parseInt(raw, 10) : DEFAULT_RETENTION_DAYS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export function logDirPath(): string {
  const configured = process.env.LOG_DIR?.trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), "logs");
}

export function mergeLogContext(patch: LogContext): void {
  if (!isNodeServer()) return;
  const cur = als.getStore();
  if (cur) {
    Object.assign(cur, patch);
    return;
  }
  als.enterWith({ ...patch });
}

export function withLogContext<T>(patch: LogContext, fn: () => T): T {
  const parent = als.getStore() ?? {};
  return als.run({ ...parent, ...patch }, fn);
}

export function currentLogContext(): LogContext {
  return { ...(als.getStore() ?? {}) };
}

function newLogId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function utcDateStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function logFileForDate(dateStamp: string): string {
  return path.join(logDirPath(), `app-${dateStamp}.jsonl`);
}

function redactSecrets(text: string): string {
  return text
    .replace(
      /(authorization|token|secret|password|passwd|api[_-]?key)\s*[:=]\s*("?)[^"\s,]+/gi,
      "$1=$2[redacted]"
    )
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
}

export function stringifyLogArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || arg.message || String(arg);
  }
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  if (arg == null) return String(arg);
  try {
    return JSON.stringify(arg);
  } catch {
    try {
      return String(arg);
    } catch {
      return "[unserializable]";
    }
  }
}

function inferCategory(message: string, hint?: LogCategory): LogCategory {
  if (hint) return hint;
  const m = message;
  if (/proxmox/i.test(m)) return "proxmox";
  if (/paypal|payment|deso-tx|deso-usd|capture-order|orders\/create/i.test(m)) {
    return "payment";
  }
  if (/billing|dunning|auto-suspend|renew|past.?due/i.test(m)) return "billing";
  if (/provision|reinstall|import-existing|importdisk/i.test(m)) {
    return "provision";
  }
  if (
    /\[vm\/|backups|console api|vnc|private-network|reset-login/i.test(m)
  ) {
    return "vm";
  }
  if (/public.?ip|ip pool|ipconfig/i.test(m)) return "network";
  if (/\[admin/i.test(m)) return "admin";
  if (/deso-jwt|auth|unauthorized/i.test(m)) return "auth";
  return "system";
}

function enrichFromMessage(message: string, ctx: LogContext): LogContext {
  const next: LogContext = { ...ctx };
  if (!next.orderId) {
    const uuid = message.match(UUID_RE);
    if (uuid) next.orderId = uuid[0];
  }
  if (!next.userId) {
    const key = message.match(DESO_KEY_RE);
    if (key) next.userId = key[0];
  }
  if (next.vmid == null) {
    const vm = message.match(/\bvmid[=:\s]+(\d+)/i) || message.match(/\bVM\s+(\d+)/i);
    if (vm) next.vmid = parseInt(vm[1]!, 10);
  }
  return next;
}

function buildEntry(
  level: LogLevel,
  message: string,
  extra?: {
    category?: LogCategory;
    details?: string;
    context?: LogContext;
  }
): AppLogEntry {
  const ctx = enrichFromMessage(message, {
    ...currentLogContext(),
    ...(extra?.context ?? {}),
  });
  const category = inferCategory(message, extra?.category ?? ctx.category);
  const entry: AppLogEntry = {
    id: newLogId(),
    ts: new Date().toISOString(),
    level,
    category,
    message: redactSecrets(message).slice(0, 4000),
  };
  if (ctx.userId) entry.userId = ctx.userId;
  if (ctx.actorId) entry.actorId = ctx.actorId;
  if (ctx.username) entry.username = ctx.username;
  if (ctx.orderId) entry.orderId = ctx.orderId;
  if (typeof ctx.vmid === "number" && ctx.vmid > 0) entry.vmid = ctx.vmid;
  if (ctx.node) entry.node = ctx.node;
  if (extra?.details) {
    entry.details = redactSecrets(extra.details).slice(0, 8000);
  }
  return entry;
}

async function ensureLogDir(): Promise<string> {
  const dir = logDirPath();
  await mkdir(dir, { recursive: true });
  return dir;
}

function enqueueWrite(task: () => Promise<void>): void {
  writeChain = writeChain.then(task).catch(() => {
    /* swallow — logging must never crash the app */
  });
}

async function appendEntry(entry: AppLogEntry): Promise<void> {
  if (!isNodeServer()) return;
  await ensureLogDir();
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(logFileForDate(utcDateStamp()), line, "utf8");
  const now = Date.now();
  if (now - lastPrunedAt > 60 * 60 * 1000) {
    lastPrunedAt = now;
    await pruneExpiredLogFiles();
  }
}

export function writeAppLog(entry: AppLogEntry): void {
  enqueueWrite(() => appendEntry(entry));
}

export function logApp(
  level: LogLevel,
  message: string,
  extra?: {
    category?: LogCategory;
    details?: unknown;
    error?: unknown;
    context?: LogContext;
  }
): void {
  let details: string | undefined;
  if (extra?.details !== undefined) details = stringifyLogArg(extra.details);
  if (extra?.error !== undefined) {
    const errText = stringifyLogArg(extra.error);
    details = details ? `${details}\n${errText}` : errText;
  }
  const entry = buildEntry(level, message, {
    category: extra?.category,
    details,
    context: extra?.context,
  });
  writeAppLog(entry);

  const printer =
    level === "error"
      ? originalConsoleError ?? console.error
      : level === "warn"
        ? originalConsoleWarn ?? console.warn
        : console.info;
  if (extra?.error !== undefined) printer(message, extra.error);
  else if (extra?.details !== undefined) printer(message, extra.details);
  else printer(message);
}

export function logError(
  category: LogCategory,
  message: string,
  error?: unknown,
  context?: LogContext
): void {
  logApp("error", message, { category, error, context });
}

export function logWarn(
  category: LogCategory,
  message: string,
  details?: unknown,
  context?: LogContext
): void {
  logApp("warn", message, { category, details, context });
}

function consoleArgsToMessage(args: unknown[]): {
  message: string;
  details?: string;
} {
  if (args.length === 0) return { message: "" };
  const [first, ...rest] = args;
  const message = stringifyLogArg(first);
  if (rest.length === 0) {
    if (first instanceof Error) {
      return { message: first.message || message, details: first.stack };
    }
    return { message };
  }
  return {
    message,
    details: rest.map(stringifyLogArg).join(" "),
  };
}

function shouldSkipConsoleCapture(message: string): boolean {
  // Avoid feedback loops if a file write somehow logs, and skip noisy client-ish tags.
  return message.includes("[app-log]");
}

export function installFileLogCapture(): void {
  if (!isNodeServer() || captureState()) return;
  originalConsoleError = console.error.bind(console);
  originalConsoleWarn = console.warn.bind(console);
  (globalThis as CaptureGlobals)[CAPTURE_FLAG] = {
    error: originalConsoleError,
    warn: originalConsoleWarn,
  };

  console.error = (...args: unknown[]) => {
    originalConsoleError!(...args);
    try {
      const { message, details } = consoleArgsToMessage(args);
      if (shouldSkipConsoleCapture(message)) return;
      writeAppLog(buildEntry("error", message, { details }));
    } catch {
      /* ignore */
    }
  };

  console.warn = (...args: unknown[]) => {
    originalConsoleWarn!(...args);
    try {
      const { message, details } = consoleArgsToMessage(args);
      if (shouldSkipConsoleCapture(message)) return;
      writeAppLog(buildEntry("warn", message, { details }));
    } catch {
      /* ignore */
    }
  };
}

export async function pruneExpiredLogFiles(): Promise<{ deleted: string[] }> {
  if (!isNodeServer()) return { deleted: [] };
  const dir = logDirPath();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return { deleted: [] };
  }

  const cutoff = Date.now() - logRetentionDays() * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00.000Z`);
    if (!Number.isFinite(t) || t >= cutoff) continue;
    try {
      await unlink(path.join(dir, name));
      deleted.push(name);
    } catch {
      /* ignore */
    }
  }
  return { deleted };
}

function parseLogLine(line: string): AppLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as Partial<AppLogEntry>;
    if (!raw || typeof raw.ts !== "string" || typeof raw.message !== "string") {
      return null;
    }
    const category = LOG_CATEGORIES.includes(raw.category as LogCategory)
      ? (raw.category as LogCategory)
      : "system";
    const level: LogLevel =
      raw.level === "info" || raw.level === "warn" || raw.level === "error"
        ? raw.level
        : "error";
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : newLogId(),
      ts: raw.ts,
      level,
      category,
      message: raw.message,
      userId: typeof raw.userId === "string" ? raw.userId : undefined,
      actorId: typeof raw.actorId === "string" ? raw.actorId : undefined,
      username: typeof raw.username === "string" ? raw.username : undefined,
      orderId: typeof raw.orderId === "string" ? raw.orderId : undefined,
      vmid: typeof raw.vmid === "number" ? raw.vmid : undefined,
      node: typeof raw.node === "string" ? raw.node : undefined,
      details: typeof raw.details === "string" ? raw.details : undefined,
    };
  } catch {
    return null;
  }
}

function matchesQuery(entry: AppLogEntry, opts: QueryAppLogsOptions): boolean {
  if (opts.category && entry.category !== opts.category) return false;
  if (opts.level && entry.level !== opts.level) return false;
  if (opts.before) {
    const beforeTs = Date.parse(opts.before);
    if (Number.isFinite(beforeTs) && Date.parse(entry.ts) >= beforeTs) {
      return false;
    }
  }
  if (opts.user?.trim()) {
    const q = opts.user.trim().toLowerCase().replace(/^@/, "");
    const hay = [
      entry.userId,
      entry.actorId,
      entry.username,
      entry.orderId,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (opts.q?.trim()) {
    const q = opts.q.trim().toLowerCase();
    const hay = [entry.message, entry.details, entry.orderId, entry.node]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

async function listLogDateStamps(): Promise<string[]> {
  const dir = logDirPath();
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - logRetentionDays() * 24 * 60 * 60 * 1000;
  const stamps: string[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00.000Z`);
    if (!Number.isFinite(t) || t < cutoff) continue;
    stamps.push(m[1]!);
  }
  stamps.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return stamps;
}

export async function queryAppLogs(opts: QueryAppLogsOptions = {}): Promise<{
  entries: AppLogEntry[];
  hasMore: boolean;
  retentionDays: number;
}> {
  const limitRaw = opts.limit ?? 150;
  const limit = Math.min(Math.max(1, limitRaw), 500);
  const stamps = await listLogDateStamps();
  const entries: AppLogEntry[] = [];
  let hasMore = false;

  for (const stamp of stamps) {
    let text = "";
    try {
      text = await readFile(logFileForDate(stamp), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const entry = parseLogLine(lines[i]!);
      if (!entry) continue;
      if (!matchesQuery(entry, opts)) continue;
      if (entries.length >= limit) {
        hasMore = true;
        break;
      }
      entries.push(entry);
    }
    if (hasMore || entries.length >= limit) {
      hasMore = hasMore || entries.length >= limit;
      break;
    }
  }

  return { entries, hasMore, retentionDays: logRetentionDays() };
}

/** Attach customer/order fields so later console.error/warn lines are filterable. */
export function attachOrderLogContext(order: {
  id: string;
  userId: string;
  vmid?: number;
  node?: string;
  vmLoginUsername?: string;
}): void {
  mergeLogContext({
    userId: order.userId,
    orderId: order.id,
    vmid: order.vmid && order.vmid > 0 ? order.vmid : undefined,
    node: order.node && order.node !== "pending" ? order.node : undefined,
    username: order.vmLoginUsername?.trim() || undefined,
  });
}

if (isNodeServer()) {
  installFileLogCapture();
}
