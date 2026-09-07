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

function optionalTemplateVmid(raw: unknown): number | undefined {
  const n =
    typeof raw === "number"
      ? Math.floor(raw)
      : parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function profileRecord(
  id: string,
  label: string,
  imageFile: string,
  templateVmid?: number
): ServiceImageProfile {
  return {
    id,
    label,
    imageFile,
    ...(templateVmid != null ? { templateVmid } : {}),
  };
}

/** Normalize & validate incoming JSON for Firestore PATCH/POST (returns [] when invalid shapes). */
export function sanitizeImageProfilesInput(raw: unknown): ServiceImageProfile[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  const out: ServiceImageProfile[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PROFILES) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim().slice(0, 160) : "";
    const imageFile = sanitizeImageFileValue(o.imageFile);
    if (!PROFILE_ID_RE.test(id) || !label || !imageFile) continue;
    if (ids.has(id)) continue;
    ids.add(id);
    out.push(profileRecord(id, label, imageFile, optionalTemplateVmid(o.templateVmid)));
  }
  return out;
}

/**
 * Parses `process.env.TEMPLATE_CATALOG_JSON`. Used after Firestore collection `os_templates`
 * and per-order overrides when building the OS image catalogue.
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
  return sanitizeImageProfilesInput(service.imageProfiles);
}

/**
 * Resolves the effective OS image catalogue (cloud-image files only):
 * persisted `orders.imageProfiles` → Firestore `os_templates` (active rows) →
 * `TEMPLATE_CATALOG_JSON` → leftover plan catalogue.
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

export function profileByIdInList(
  profiles: ServiceImageProfile[],
  id: string | null | undefined
): ServiceImageProfile | undefined {
  const pid = typeof id === "string" ? id.trim() : "";
  if (!pid) return undefined;
  return profiles.find((p) => p.id === pid);
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
  /** @deprecated Ignored except as a fallback match against leftover stored VMIDs. */
  templateVmid?: unknown;
};

/** Validates checkout/reinstall POST body against a resolved profile list. */
export function resolveCloneChoiceFromBody(
  profiles: ServiceImageProfile[],
  body: CheckoutCloneBody,
  opts?: { allowDefaultFallback?: boolean }
): { profile: ServiceImageProfile } | null {
  if (profiles.length === 0) return null;

  const allowDefault = opts?.allowDefaultFallback !== false;

  const pid =
    typeof body.imageProfileId === "string"
      ? body.imageProfileId.trim()
      : "";
  if (pid) {
    const p = profiles.find((x) => x.id === pid);
    return p ? { profile: p } : null;
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
    return p ? { profile: p } : null;
  }

  if (!allowDefault) return null;

  const p0 = profiles[0];
  return p0 ? { profile: p0 } : null;
}

export type ReinstallCloneBody = CheckoutCloneBody;

/** For reinstall: explicit body overrides; otherwise reuse the stored image profile. */
export function resolveCloneChoiceForReinstall(
  templateCatalog: ServiceImageProfile[],
  order: Pick<Order, "cloneTemplateVmid" | "cloneImageProfileId">,
  body: ReinstallCloneBody
): { profile: ServiceImageProfile } | null {
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

  const storedId = order.cloneImageProfileId?.trim();
  if (storedId) {
    const match = templateCatalog.find((p) => p.id === storedId);
    if (match) return { profile: match };
  }

  const stored = order.cloneTemplateVmid;
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    const match = templateCatalog.find((p) => p.templateVmid === Math.floor(stored));
    if (match) return { profile: match };
  }

  const p0 = templateCatalog[0];
  return p0 ? { profile: p0 } : null;
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
  }
  if (profiles.length === 1) return profiles[0]!.label;
  return null;
}
