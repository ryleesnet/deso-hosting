/**
 * Admin: refund the most recent PayPal capture on this order and cancel the
 * subscription so PayPal doesn't try to charge again.
 *
 * The order is then marked cancelled via the same lifecycle path a user
 * cancellation would take (destroy VM, release IP, delete subscription).
 * The `PAYMENT.SALE.REFUNDED` webhook that PayPal fires after this call is
 * harmless because our idempotency key (`paypal_events/{event.id}`) prevents
 * double processing.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  getSubscriptionByOrder,
  deleteSubscription,
  updateOrder,
} from "@/lib/db";
import { requireAdmin } from "@/lib/api-auth";
import {
  cancelPaypalSubscription,
  paypalIsConfigured,
  refundLatestSubscriptionSale,
} from "@/lib/paypal";
import { destroyVM } from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { releasePublicIpAssignmentByOrderId } from "@/lib/public-ip-store";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    if (!paypalIsConfigured()) {
      return NextResponse.json(
        { error: "PayPal is not configured on this server." },
        { status: 503 }
      );
    }

    const { orderId } = await params;
    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (order.paymentProvider !== "paypal" || !order.paypalSubscriptionId) {
      return NextResponse.json(
        { error: "This order was not paid via PayPal" },
        { status: 400 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      reason?: unknown;
      /** When true, only cancel the PayPal subscription (no refund, no VPS destroy). */
      cancelOnly?: unknown;
    };
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim()
        : "Refund issued by administrator";
    const cancelOnly = body.cancelOnly === true;

    let refund: Awaited<ReturnType<typeof refundLatestSubscriptionSale>> = null;
    if (!cancelOnly) {
      try {
        refund = await refundLatestSubscriptionSale(
          order.paypalSubscriptionId,
          reason
        );
      } catch (e) {
        return NextResponse.json(
          {
            error:
              e instanceof Error ? e.message : "PayPal refund failed",
          },
          { status: 502 }
        );
      }
    }

    // Cancel the PayPal subscription so future auto-charges stop. If PayPal
    // already cancelled it (e.g. after refund + webhook), the cancel call
    // returns 4xx — we treat that as a soft success.
    try {
      await cancelPaypalSubscription(order.paypalSubscriptionId, reason);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/422|400|not.*active/i.test(msg)) {
        console.warn(
          "[paypal-refund] subscription cancel failed (continuing):",
          msg
        );
      }
    }

    if (cancelOnly) {
      // Do not destroy the VPS — admin only wanted to stop future PayPal
      // billing. Subscription is marked past_due; user can re-authorize.
      const subscription = await getSubscriptionByOrder(orderId);
      if (subscription) {
        await import("@/lib/db").then(({ updateSubscription }) =>
          updateSubscription(subscription.id, { status: "past_due" })
        );
      }
      return NextResponse.json({
        success: true,
        refund: null,
        cancelled: true,
      });
    }

    // Same cancellation lifecycle as `/api/orders/[orderId]/cancel`.
    if (order.vmid > 0 && order.node && order.node !== "pending") {
      try {
        const { node } = await resolveOrderVmLocation(order);
        await destroyVM(node, order.vmid);
      } catch (err) {
        console.error(
          "[paypal-refund] Proxmox destroy failed (VM may already be gone):",
          err
        );
      }
    }
    await releasePublicIpAssignmentByOrderId(orderId);
    await updateOrder(orderId, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
    });
    const subscription = await getSubscriptionByOrder(orderId);
    if (subscription) {
      await deleteSubscription(subscription.id);
    }

    return NextResponse.json({
      success: true,
      refund,
      cancelled: true,
    });
  } catch (err) {
    console.error("[paypal-refund]", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "PayPal refund failed",
      },
      { status: 500 }
    );
  }
}
