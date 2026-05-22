import { NextRequest, NextResponse } from "next/server";
import {
  createHostedOsTemplate,
  listHostedOsTemplatesAdmin,
} from "@/lib/db";
import { requireAdmin } from "@/lib/api-auth";
import { suggestHostedTemplateDocId } from "@/lib/os-template-admin";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const rows = await listHostedOsTemplatesAdmin();
    return NextResponse.json({ templates: rows });
  } catch (e) {
    console.error("[admin/os-templates GET]", e);
    return NextResponse.json({ error: "Failed to list templates" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const body = (await req.json()) as {
      id?: string;
      label?: string;
      templateVmid?: unknown;
      active?: unknown;
      sortOrder?: unknown;
    };
    const label = typeof body.label === "string" ? body.label : "";
    const tvmid = body.templateVmid;
    const templateVmid =
      typeof tvmid === "number"
        ? tvmid
        : tvmid != null
          ? parseInt(String(tvmid), 10)
          : NaN;
    let id =
      typeof body.id === "string" && body.id.trim()
        ? body.id.trim().toLowerCase()
        : suggestHostedTemplateDocId(label);
    const active = body.active !== false;
    const sortOrder =
      body.sortOrder != null && Number.isFinite(Number(body.sortOrder))
        ? Math.floor(Number(body.sortOrder))
        : 0;

    const tryCreate = await createHostedOsTemplate({
      id,
      label,
      templateVmid,
      active,
      sortOrder,
    });
    if ("error" in tryCreate) {
      if (
        /already exists/i.test(tryCreate.error) &&
        !body.id?.trim()
      ) {
        id = `${id}_${Math.random().toString(36).slice(2, 7)}`;
        const retry = await createHostedOsTemplate({
          id,
          label,
          templateVmid,
          active,
          sortOrder,
        });
        if ("error" in retry) {
          return NextResponse.json({ error: retry.error }, { status: 400 });
        }
        return NextResponse.json({ ok: true, template: retry });
      }
      return NextResponse.json({ error: tryCreate.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, template: tryCreate });
  } catch (e) {
    console.error("[admin/os-templates POST]", e);
    return NextResponse.json({ error: "Failed to create template" }, { status: 500 });
  }
}
