import { NextRequest, NextResponse } from "next/server";
import {
  deleteHostedOsTemplate,
  updateHostedOsTemplate,
} from "@/lib/db";
import { requireAdmin } from "@/lib/api-auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      label?: string;
      templateVmid?: unknown;
      active?: unknown;
      sortOrder?: unknown;
    };
    const updates: Parameters<typeof updateHostedOsTemplate>[1] = {};
    if (typeof body.label === "string") updates.label = body.label;
    if (body.templateVmid != null) {
      const t =
        typeof body.templateVmid === "number"
          ? body.templateVmid
          : parseInt(String(body.templateVmid), 10);
      if (!Number.isFinite(t) || t <= 0) {
        return NextResponse.json(
          { error: "templateVmid must be a positive integer" },
          { status: 400 }
        );
      }
      updates.templateVmid = Math.floor(t);
    }
    if (typeof body.active === "boolean") updates.active = body.active;
    if (body.sortOrder != null)
      updates.sortOrder = Number.isFinite(Number(body.sortOrder))
        ? Math.floor(Number(body.sortOrder))
        : undefined;

    const out = await updateHostedOsTemplate(id, updates);
    if (!out) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
    if ("error" in out) {
      return NextResponse.json({ error: out.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, template: out });
  } catch (e) {
    console.error("[admin/os-templates PATCH]", e);
    return NextResponse.json({ error: "Failed to update template" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  try {
    const ok = await deleteHostedOsTemplate(id);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[admin/os-templates DELETE]", e);
    return NextResponse.json({ error: "Failed to delete template" }, { status: 500 });
  }
}
