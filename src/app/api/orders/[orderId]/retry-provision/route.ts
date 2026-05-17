import { NextRequest, NextResponse } from "next/server";
import { getOrder, updateOrder } from "@/lib/db";
import { configureProvisionedVM } from "@/lib/order-provision";
import { requireUser } from "@/lib/api-auth";

/**
 * Re-run the post-clone configuration step (hardware, cloud-init, subscription) against an
 * existing VM. Use when the initial auto-provision flow cloned a VM but failed to apply
 * cloud-init / hardware updates. Avoids re-cloning so the VM keeps its identity / IP.
 */
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

    if (order.status === "cancelled") {
      return NextResponse.json(
        { error: "This order is cancelled" },
        { status: 400 }
      );
    }
    if (!order.vmid || order.vmid <= 0) {
      return NextResponse.json(
        {
          error:
            "Order has no VM yet. Cancel and re-order, or have an admin clone manually.",
        },
        { status: 400 }
      );
    }
    if (!order.node || order.node === "pending") {
      return NextResponse.json(
        { error: "Order has no Proxmox node recorded" },
        { status: 400 }
      );
    }

    await updateOrder(orderId, { status: "provisioning", provisionError: "" });

    try {
      await configureProvisionedVM(orderId);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Configuration failed";
      console.error(`[orders/${orderId}/retry-provision] failed:`, err);
      await updateOrder(orderId, {
        status: "pending",
        provisionError: msg.slice(0, 1000),
      });
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    const fresh = await getOrder(orderId);
    return NextResponse.json({ success: true, order: fresh });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to retry provisioning" },
      { status: 500 }
    );
  }
}
