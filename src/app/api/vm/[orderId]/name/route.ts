import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/db";
import { setVMDisplayName, formatProxmoxApiError } from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { requireUser } from "@/lib/api-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    const { name } = await req.json();

    if (typeof name !== "string") {
      return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (trimmed.length > 255) {
      return NextResponse.json(
        { error: "Name must be at most 255 characters" },
        { status: 400 }
      );
    }

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.userId !== auth.publicKey && !auth.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (!order.node?.trim()) {
      return NextResponse.json(
        { error: "VM node is not set for this order" },
        { status: 400 }
      );
    }
    if (!order.vmid || order.vmid <= 0) {
      return NextResponse.json(
        { error: "VM is not provisioned yet" },
        { status: 400 }
      );
    }

    const { node } = await resolveOrderVmLocation(order);
    await setVMDisplayName(node, order.vmid, trimmed);
    return NextResponse.json({ success: true, name: trimmed });
  } catch (err) {
    console.error("[vm/name]", err);
    const message = formatProxmoxApiError(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
