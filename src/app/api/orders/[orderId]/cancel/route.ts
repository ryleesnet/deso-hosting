import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  updateOrder,
  getSubscriptionByOrder,
  deleteSubscription,
} from "@/lib/db";
import { destroyVM } from "@/lib/proxmox";
import { releasePublicIpAssignmentByOrderId } from "@/lib/public-ip-store";
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

    const canCancel = auth.isAdmin || order.userId === auth.publicKey;
    if (!canCancel) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (order.status === "cancelled") {
      const orphanedSub = await getSubscriptionByOrder(orderId);
      if (orphanedSub) {
        await deleteSubscription(orphanedSub.id);
      }
      return NextResponse.json({ success: true });
    }

    if (order.vmid > 0 && order.node && order.node !== "pending") {
      try {
        await destroyVM(order.node, order.vmid);
      } catch (err) {
        console.error("Proxmox destroy failed (VM may already be gone):", err);
      }
    }

    await releasePublicIpAssignmentByOrderId(orderId);

    const nowIso = new Date().toISOString();
    await updateOrder(orderId, {
      status: "cancelled",
      cancelledAt: nowIso,
    });

    const subscription = await getSubscriptionByOrder(orderId);
    if (subscription) {
      await deleteSubscription(subscription.id);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to cancel order" },
      { status: 500 }
    );
  }
}
