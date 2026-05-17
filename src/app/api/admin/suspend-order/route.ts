import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/db";
import { suspendOrderById } from "@/lib/order-lifecycle";
import { requireAdmin } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await req.json();
    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
        { status: 400 }
      );
    }

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.status === "suspended") {
      return NextResponse.json({ success: true, alreadySuspended: true });
    }

    await suspendOrderById(orderId);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[admin/suspend-order]", err);
    const msg = err instanceof Error ? err.message : "Suspend failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
