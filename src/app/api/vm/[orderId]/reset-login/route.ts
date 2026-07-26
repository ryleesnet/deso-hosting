import { NextRequest, NextResponse } from "next/server";
import { getOrder, updateOrder, type Order } from "@/lib/db";
import { generateVmPassword } from "@/lib/vm-credentials";
import {
  applyCloudInitPasswordAndRegenerate,
  formatProxmoxApiError,
  getQemuCloudInitCiuser,
} from "@/lib/proxmox";
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
    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.userId !== auth.publicKey && !auth.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (order.status !== "active") {
      return NextResponse.json(
        { error: "Reset is only available for active VPS instances" },
        { status: 400 }
      );
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

    let ciuser = order.vmLoginUsername?.trim() || "";
    if (!ciuser) {
      ciuser = (await getQemuCloudInitCiuser(node, order.vmid)) || "";
    }
    if (!ciuser) {
      return NextResponse.json(
        {
          error:
            "No cloud-init user found. Ensure this VM template uses cloud-init and has ciuser configured.",
        },
        { status: 400 }
      );
    }

    const newPassword = generateVmPassword();
    await applyCloudInitPasswordAndRegenerate(
      node,
      order.vmid,
      ciuser,
      newPassword
    );

    const updates: Partial<Order> = { vmLoginPassword: newPassword };
    if (!order.vmLoginUsername?.trim()) {
      updates.vmLoginUsername = ciuser;
    }
    await updateOrder(orderId, updates);

    return NextResponse.json({
      success: true,
      vmLoginUsername: ciuser,
      vmLoginPassword: newPassword,
    });
  } catch (err) {
    console.error("[vm/reset-login]", err);
    const message = formatProxmoxApiError(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
