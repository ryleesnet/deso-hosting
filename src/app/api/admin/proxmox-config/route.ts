import { NextRequest, NextResponse } from "next/server";
import {
  getProxmoxHostConfig,
  setProxmoxHostConfig,
} from "@/lib/proxmox-host-config";
import { requireAdmin } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const cfg = await getProxmoxHostConfig();
    return NextResponse.json(cfg);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read Proxmox host config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const patch: Parameters<typeof setProxmoxHostConfig>[0] = {};

    if (Object.prototype.hasOwnProperty.call(body, "defaultCloneNode")) {
      const v = body.defaultCloneNode;
      patch.defaultCloneNode = v == null || v === "" ? null : String(v);
    }
    if (Object.prototype.hasOwnProperty.call(body, "autoPlaceNewVms")) {
      const v = body.autoPlaceNewVms;
      patch.autoPlaceNewVms =
        v == null || v === "" ? null : Boolean(v);
    }
    if (Object.prototype.hasOwnProperty.call(body, "defaultDiskStorage")) {
      const v = body.defaultDiskStorage;
      patch.defaultDiskStorage =
        v == null || v === "" ? null : String(v);
    }
    if (Object.prototype.hasOwnProperty.call(body, "backupStorage")) {
      const v = body.backupStorage;
      patch.backupStorage = v == null || v === "" ? null : String(v);
    }

    const updated = await setProxmoxHostConfig(patch);
    return NextResponse.json(updated);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update Proxmox host config";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
