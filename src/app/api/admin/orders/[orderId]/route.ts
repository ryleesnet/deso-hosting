import { NextRequest, NextResponse } from "next/server";
import { getOrder, updateOrder } from "@/lib/db";
import { requireAdmin } from "@/lib/api-auth";
import { sanitizeImageProfilesInput } from "@/lib/image-profiles";

/** Admin-only: PATCH order fields relevant to infra (OS templates live on VPS, not the plan). */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const body = (await req.json()) as {
      imageProfiles?: unknown;
    };

    if (!("imageProfiles" in body)) {
      return NextResponse.json(
        { error: "Only imageProfiles is supported on this endpoint." },
        { status: 400 }
      );
    }

    const imageProfiles =
      body.imageProfiles == null || body.imageProfiles === ""
        ? []
        : sanitizeImageProfilesInput(body.imageProfiles);

    const updated = await updateOrder(orderId, { imageProfiles });
    return NextResponse.json({ ok: true, order: updated });
  } catch (err) {
    console.error("[admin PATCH order]", err);
    return NextResponse.json(
      { error: "Failed to update order" },
      { status: 500 }
    );
  }
}
