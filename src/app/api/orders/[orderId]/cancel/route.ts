import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  updateOrder,
  getSubscriptionByOrder,
  deleteSubscription,
} from "@/lib/db";
import { destroyVM } from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { releasePublicIpAssignmentByOrderId } from "@/lib/public-ip-store";
import { requireUser } from "@/lib/api-auth";
import { cancelPaypalSubscription, paypalIsConfigured } from "@/lib/paypal";

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

    // Stop PayPal auto-billing FIRST, before we destroy anything — a failure
    // to cancel the PayPal subscription would leave the buyer being charged
    // for a VPS that no longer exists. We treat "already cancelled" errors
    // as soft-success.
    if (order.paypalSubscriptionId && paypalIsConfigured()) {
      try {
        await cancelPaypalSubscription(
          order.paypalSubscriptionId,
          "VPS cancelled by user"
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/422|400|not.*active/i.test(msg)) {
          console.error(
            "[order cancel] PayPal subscription cancel failed:",
            msg
          );
        }
      }
    }

    if (order.vmid > 0 && order.node && order.node !== "pending") {
      try {
        const { node } = await resolveOrderVmLocation(order);
        await destroyVM(node, order.vmid);
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
