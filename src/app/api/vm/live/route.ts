import { NextRequest, NextResponse } from "next/server";
import { getOrderForLiveStatus } from "@/lib/db";
import { snapshotVmsForOrders } from "@/lib/vm-live";
import { requireUser } from "@/lib/api-auth";

const MAX_IDS = 40;
/** Order ids are UUIDs today; keep the check wide enough for older ids, and reject commas. */
const ORDER_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Power state and display name for VMs the caller already listed.
 * Ownership comes from the in-memory order cache filled by `/api/orders`
 * (one document read on a cache miss). Proxmox is the only remote call on
 * the steady 15s poll.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  const ids = [
    ...new Set(
      (req.nextUrl.searchParams.get("ids") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((id) => ORDER_ID_RE.test(id))
    ),
  ].slice(0, MAX_IDS);

  if (ids.length === 0) {
    return NextResponse.json({ byOrderId: {} });
  }

  try {
    const orders = [];
    for (const id of ids) {
      const order = await getOrderForLiveStatus(id, auth.publicKey);
      if (!order || order.vmid <= 0 || order.status === "cancelled") continue;
      orders.push(order);
    }
    const byOrderId = await snapshotVmsForOrders(orders);
    return NextResponse.json({ byOrderId });
  } catch (err) {
    console.error("[vm/live]", err);
    return NextResponse.json(
      { error: "Failed to load VM status" },
      { status: 500 }
    );
  }
}
