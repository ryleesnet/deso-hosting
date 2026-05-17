import { NextRequest, NextResponse } from "next/server";
import {
  adminPatchPublicIpRecord,
  listPublicIpRecords,
} from "@/lib/public-ip-store";
import { requireAdmin } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const records = await listPublicIpRecords();
    const sorted = [...records].sort((a, b) =>
      a.address.localeCompare(b.address, undefined, { numeric: true })
    );
    return NextResponse.json(sorted);
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to list public IPs" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const address = typeof body.address === "string" ? body.address.trim() : "";
    const status = body.status as
      | "available"
      | "assigned"
      | "reserved"
      | undefined;

    if (!address) {
      return NextResponse.json({ error: "address is required" }, { status: 400 });
    }
    if (!status || !["available", "assigned", "reserved"].includes(status)) {
      return NextResponse.json(
        {
          error:
            "status is required and must be available, assigned, or reserved",
        },
        { status: 400 }
      );
    }

    const userId =
      typeof body.userId === "string" || body.userId == null
        ? (body.userId as string | null | undefined)
        : String(body.userId);
    const orderId =
      typeof body.orderId === "string" || body.orderId == null
        ? (body.orderId as string | null | undefined)
        : String(body.orderId);

    let vmid: number | null | undefined;
    if (body.vmid === "" || body.vmid == null) {
      vmid = null;
    } else {
      const n = Number(body.vmid);
      vmid = Number.isFinite(n) ? n : null;
    }

    await adminPatchPublicIpRecord({
      address,
      status,
      userId: userId ?? undefined,
      orderId: orderId ?? undefined,
      vmid,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update public IP";
    const status = message.includes("No public_ips") ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
