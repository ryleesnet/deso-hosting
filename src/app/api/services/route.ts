import { NextRequest, NextResponse } from "next/server";
import { getServices, addService } from "@/lib/db";
import { enrichServicesForPublic } from "@/lib/service-pricing";
import { normalizeRamMb } from "@/lib/service-ram";
import { requireAdmin, requireUser } from "@/lib/api-auth";
import { sanitizeImageProfilesInput } from "@/lib/image-profiles";

/**
 * Default response (used by the public catalog and dashboards):
 *   - Admins see active plans plus every testing plan (the `testing` flag is
 *     itself the admin-only visibility gate, so purely inactive non-testing
 *     plans stay hidden even from admins).
 *   - Everyone else sees only active, non-testing plans.
 *
 * Pass `?all=true` (admin-only) to get every plan regardless of state — used
 * by the admin catalog editor so admins can still see and re-activate
 * inactive plans.
 */
export async function GET(req: NextRequest) {
  const hasJwt = !!req.headers.get("authorization");
  let isAdmin = false;
  if (hasJwt) {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;
    isAdmin = auth.isAdmin;
  }

  const wantAll =
    new URL(req.url).searchParams.get("all")?.toLowerCase() === "true";
  const services = await getServices();
  const filtered =
    isAdmin && wantAll
      ? services
      : isAdmin
        ? services.filter((s) => s.active || s.testing)
        : services.filter((s) => s.active && !s.testing);
  const payload = await enrichServicesForPublic(filtered);
  return NextResponse.json(payload);
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const service = await req.json();
    const priceUsdCents = Math.round(Number(service.priceUsdCents));
    if (!Number.isFinite(priceUsdCents) || priceUsdCents < 0) {
      return NextResponse.json(
        { error: "priceUsdCents is required (cents per month, e.g. 999 for $9.99)" },
        { status: 400 }
      );
    }

    const sanitizedProfiles =
      service.imageProfiles != null
        ? sanitizeImageProfilesInput(service.imageProfiles)
        : [];

    const newService = await addService({
      name: service.name,
      description: service.description || "",
      vcpu: service.vcpu || 1,
      ram: normalizeRamMb(
        service.ram != null ? Number(service.ram) : 1024
      ),
      storage: service.storage || 20,
      priceUsdCents,
      proxmoxTemplate: service.proxmoxTemplate,
      proxmoxNode: service.proxmoxNode,
      active: service.active !== false,
      ...(service.testing === true ? { testing: true } : {}),
      ...(sanitizedProfiles.length > 0 ? { imageProfiles: sanitizedProfiles } : {}),
    });

    const [enriched] = await enrichServicesForPublic([newService]);
    return NextResponse.json(enriched);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to add service" },
      { status: 500 }
    );
  }
}
