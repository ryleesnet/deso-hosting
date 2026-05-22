import { NextRequest, NextResponse } from "next/server";
import { getService, updateService, deleteService } from "@/lib/db";
import { publicServiceById } from "@/lib/service-pricing";
import { normalizeRamMb } from "@/lib/service-ram";
import { requireAdmin } from "@/lib/api-auth";
import { sanitizeImageProfilesInput } from "@/lib/image-profiles";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const service = await getService(id);
  const enriched = await publicServiceById(service);
  if (!enriched) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }
  return NextResponse.json(enriched);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const updates = await req.json();
    const patch: Record<string, unknown> = { ...updates };
    delete patch.publicKey;

    if (patch.priceUsdCents !== undefined) {
      const c = Math.round(Number(patch.priceUsdCents));
      if (!Number.isFinite(c) || c < 0) {
        return NextResponse.json(
          { error: "priceUsdCents must be a non-negative integer (cents)" },
          { status: 400 }
        );
      }
      patch.priceUsdCents = c;
    }
    if (patch.ram !== undefined) {
      patch.ram = normalizeRamMb(Number(patch.ram));
    }
    if ("imageProfiles" in patch && patch.imageProfiles !== undefined) {
      patch.imageProfiles = sanitizeImageProfilesInput(patch.imageProfiles);
    }

    const updated = await updateService(id, patch as Parameters<typeof updateService>[1]);
    if (!updated) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }
    const enriched = await publicServiceById(updated);
    return NextResponse.json(enriched);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to update service" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { id } = await params;
    await deleteService(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to delete service" },
      { status: 500 }
    );
  }
}
