import { NextRequest, NextResponse } from "next/server";
import {
  getPublicIpPoolConfig,
  setPublicIpPoolConfig,
} from "@/lib/public-ip-config";
import { requireAdmin } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const cfg = await getPublicIpPoolConfig();
    return NextResponse.json(cfg);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read public IP config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const patch: Parameters<typeof setPublicIpPoolConfig>[0] = {};

    if (Object.prototype.hasOwnProperty.call(body, "gateway")) {
      const v = body.gateway;
      patch.gateway = v == null || v === "" ? null : String(v);
    }
    if (Object.prototype.hasOwnProperty.call(body, "prefixLen")) {
      const v = body.prefixLen;
      if (v == null || v === "") {
        patch.prefixLen = null;
      } else {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          return NextResponse.json(
            { error: "prefixLen must be a number 0–32" },
            { status: 400 }
          );
        }
        patch.prefixLen = n;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "dns")) {
      const v = body.dns;
      patch.dns = v == null || v === "" ? null : String(v);
    }

    const updated = await setPublicIpPoolConfig(patch);
    return NextResponse.json(updated);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update public IP config";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
