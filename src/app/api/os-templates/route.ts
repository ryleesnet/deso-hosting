import { NextResponse } from "next/server";
import { readActiveOsTemplateProfiles } from "@/lib/db";

/** Active global OS catalogue (Firestore `os_templates`). Public read for checkout / dashboard. */
export async function GET() {
  try {
    const profiles = await readActiveOsTemplateProfiles();
    return NextResponse.json({ profiles });
  } catch (e) {
    console.error("[os-templates]", e);
    return NextResponse.json({ profiles: [], error: "catalog_unavailable" }, { status: 200 });
  }
}
