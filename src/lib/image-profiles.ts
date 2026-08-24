import type { Order, VPSService, ServiceImageProfile } from "@/lib/db";

export type { ServiceImageProfile } from "@/lib/db";

const PROFILE_ID_RE = /^[a-z][a-z0-9_-]{0,62}$/i;
const MAX_PROFILES = 20;

const IMAGE_FILE_INVALID_CHARS_RE = /[\s"'`;|&$<>*?()\\]/;

/**
 * Same validation as `db.validateOsTemplateImageFile` — kept local so this
 * module (used by both server + edge-adjacent bundles) stays free of
 * firebase-admin imports.
 */
function sanitizeImageFileValue(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (s.length > 512) return undefined;
  if (IMAGE_FILE_INVALID_CHARS_RE.test(s)) return undefined;
  if (s.includes("..")) return undefined;
  return s;
}

/** Normalize & validate incoming JSON for Firestore PATCH/POST (returns [] when invalid shapes). */
export function sanitizeImageProfilesInput(raw: unknown): ServiceImageProfile[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const vmids = new Set<number>();
  const out: ServiceImageProfile[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PROFILES) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 160) : "";
    const tvmidRaw = o.templateVmid;
    const templateVmid =
      typeof tvmidRaw === "number"
        ? Math.floor(tvmidRaw)
        : parseInt(String(tvmidRaw ?? "").trim(), 10);
    if (
      !PROFILE_ID_RE.test(id) ||
      !label ||
      !Number.isFinite(templateVmid) ||
      templateVmid <= 0
    ) {
      continue;
    }
    if (ids.has(id) || vmids.has(templateVmid)) continue;
    ids.add(id);
    vmids.add(templateVmid);
    const imageFile = sanitizeImageFileValue(o.imageFile);
    out.push({
      id,
      label,
      templateVmid,
      ...(imageFile ? { imageFile } : {}),
    });
  }
  return out;
}

/**
 * Parses `process.env.TEMPLATE_CATALOG_JSON`. Used after Firestore collection `os_templates`
 * and per-order overrides when building a clone catalogue.
 */
function effectiveTemplatesFromEnvironment(): ServiceImageProfile[] {
  const raw = process.env.TEMPLATE_CATALOG_JSON?.trim();
  if (!raw) return [];
  try {
    return sanitizeImageProfilesInput(JSON.parse(raw) as unknown);
  } catch {
    console.warn(
      "[image-profiles] TEMPLATE_CATALOG_JSON is set but invalid JSON — ignoring."
    );
    return [];
  }
}

function fallbackTemplatesFromPlanAndEnv(
  service: Pick<VPSService, "imageProfiles" | "proxmoxTemplate">
): ServiceImageProfile[] {
  const env = effectiveTemplatesFromEnvironment();
  if (env.length > 0) return env;
  const list = sanitizeImageProfilesInput(service.imageProfiles);
  if (list.length > 0) return list;
  const t = service.proxmoxTemplate;
  if (t != null && t > 0) {
    return [{ id: "default", label: "Default image", templateVmid: t }];
  }
  return [];
}

/**
 * Resolves the effective clone catalogue:
 * persisted `orders.imageProfiles` → Firestore `os_templates` (active rows) →
 * `TEMPLATE_CATALOG_JSON` → legacy plan catalogue.
 */
function resolveTemplateCatalog(
  order: Pick<Order, "imageProfiles"> | null,
  hostedFromFirestore: readonly ServiceImageProfile[],
  service: Pick<VPSService, "imageProfiles" | "proxmoxTemplate">
): ServiceImageProfile[] {
  if (order) {
    const vps = sanitizeImageProfilesInput(order.imageProfiles ?? []);
    if (vps.length > 0) return vps;
  }
  const hosted = sanitizeImageProfilesInput(Array.from(hostedFromFirestore ?? []));
  if (hosted.length > 0) return hosted;
  return fallbackTemplatesFromPlanAndEnv(service);
}

/** Pre-order picker: pass profiles from GET `/api/os-templates` plus the selected plan. */
export function effectiveTemplatesForCheckout(
  service: Pick<VPSService, "imageProfiles" | "proxmoxTemplate">,
  hostedFromFirestore: ServiceImageProfile[] = []
): ServiceImageProfile[] {
  return resolveTemplateCatalog(null, hostedFromFirestore, service);
}

export function effectiveTemplatesForOrder(
  order: Pick<Order, "imageProfiles">,
  service: Pick<VPSService, "imageProfiles" | "proxmoxTemplate">,
  hostedFromFirestore: ServiceImageProfile[] = []
): ServiceImageProfile[] {
  return resolveTemplateCatalog(order, hostedFromFirestore, service);
}

export function profileByTemplateVmidInList(
  profiles: ServiceImageProfile[],
  templateVmid: number
): ServiceImageProfile | undefined {
  const tvmidFloor = Math.floor(Number(templateVmid));
  if (!Number.isFinite(tvmidFloor) || tvmidFloor <= 0) return undefined;
  return profiles.find((p) => p.templateVmid === tvmidFloor);
}

export type CheckoutCloneBody = {
  imageProfileId?: unknown;
  templateVmid?: unknown;
};

/** Validates checkout/reinstall POST body against a resolved profile list. */
export function resolveCloneChoiceFromBody(
  profiles: ServiceImageProfile[],
  body: CheckoutCloneBody,
  opts?: { allowDefaultFallback?: boolean }
): { profile: ServiceImageProfile; templateVmid: number } | null {
  if (profiles.length === 0) return null;

  const allowDefault = opts?.allowDefaultFallback !== false;

  const pid =
    typeof body.imageProfileId === "string"
      ? body.imageProfileId.trim()
      : "";
  if (pid) {
    const p = profiles.find((x) => x.id === pid);
    return p ? { profile: p, templateVmid: p.templateVmid } : null;
  }

  const tvmidRaw = body.templateVmid;
  const tvmid =
    typeof tvmidRaw === "number"
      ? tvmidRaw
      : tvmidRaw != null && tvmidRaw !== ""
        ? parseInt(String(tvmidRaw).trim(), 10)
        : NaN;
  if (Number.isFinite(tvmid) && tvmid > 0) {
    const p = profiles.find((x) => x.templateVmid === Math.floor(tvmid));
    return p ? { profile: p, templateVmid: p.templateVmid } : null;
  }

  if (!allowDefault) return null;

  const p0 = profiles[0];
  return p0 ? { profile: p0, templateVmid: p0.templateVmid } : null;
}

export type ReinstallCloneBody = CheckoutCloneBody;

/** For reinstall: explicit body overrides; otherwise reuse the stored template VMID if it exists in catalogue. */
export function resolveCloneChoiceForReinstall(
  templateCatalog: ServiceImageProfile[],
  order: Pick<Order, "cloneTemplateVmid">,
  body: ReinstallCloneBody
): { profile: ServiceImageProfile; templateVmid: number } | null {
  if (templateCatalog.length === 0) return null;

  const hasExplicit =
    (typeof body.imageProfileId === "string" &&
      body.imageProfileId.trim() !== "") ||
    (body.templateVmid != null &&
      body.templateVmid !== "" &&
      Number.isFinite(Number(body.templateVmid)));

  if (hasExplicit) {
    return resolveCloneChoiceFromBody(templateCatalog, body, {
      allowDefaultFallback: false,
    });
  }

  const stored = order.cloneTemplateVmid;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    const match = templateCatalog.find((p) => p.templateVmid === Math.floor(stored));
    if (match) return { profile: match, templateVmid: match.templateVmid };
  }

  const p0 = templateCatalog[0];
  return p0 ? { profile: p0, templateVmid: p0.templateVmid } : null;
}

/** Dashboard line label for installed image */
export function displayCloneImageSummary(
  order: Pick<
    Order,
    "cloneTemplateVmid" | "cloneImageProfileId" | "imageProfiles"
  >,
  catalog: Pick<VPSService, "imageProfiles" | "proxmoxTemplate"> | undefined,
  hostedFromFirestore: ServiceImageProfile[] = []
): string | null {
  const planPick = catalog ?? {};
  const profiles = resolveTemplateCatalog(
    order as Pick<Order, "imageProfiles">,
    hostedFromFirestore,
    planPick
  );
  if (profiles.length === 0) return null;

  const pid =
    typeof order.cloneImageProfileId === "string"
      ? order.cloneImageProfileId.trim()
      : "";
  if (pid) {
    const p = profiles.find((x) => x.id === pid);
    if (p) return p.label;
  }
  const tvmid = order.cloneTemplateVmid;
  if (typeof tvmid === "number" && tvmid > 0) {
    const p = profiles.find((x) => x.templateVmid === tvmid);
    if (p) return p.label;
    return `Template VMID ${tvmid}`;
  }
  if (profiles.length === 1) return profiles[0]!.label;
  return null;
}
