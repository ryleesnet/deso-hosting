import { NextRequest, NextResponse } from "next/server";
import { getServices, addService } from "@/lib/db";
import { enrichServicesForPublic } from "@/lib/service-pricing";
import { normalizeRamMb } from "@/lib/service-ram";
import { requireAdmin, requireUser } from "@/lib/api-auth";
import { sanitizeImageProfilesInput } from "@/lib/image-profiles";

/**
 * Admins (logged in) see all services including inactive ones; everyone else sees the
 * active catalog. Anonymous callers (no JWT) get only active services so the catalog page
 * still works for visitors.
 */
export async function GET(req: NextRequest) {
  const hasJwt = !!req.headers.get("authorization");
  let isAdmin = false;
  if (hasJwt) {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;
    isAdmin = auth.isAdmin;
  }

  const services = await getServices();
  const filtered = isAdmin ? services : services.filter((s) => s.active);
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
