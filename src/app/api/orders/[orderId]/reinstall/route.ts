import { NextRequest, NextResponse, after } from "next/server";
import { getOrder, getService, updateOrder } from "@/lib/db";
import { resolveProvisionTarget } from "@/lib/order-provision";
import { requireUser } from "@/lib/api-auth";

/**
 * User/admin: destroy the current QEMU guest, full-clone again from the catalogue template,
 * and re-apply hardware + cloud-init (same plan, IP, credentials, extra disks). Runs in the
 * background like initial provisioning (clone can take many minutes).
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

    if (order.status === "provisioning") {
      return NextResponse.json(
        { error: "This VPS is already being created or reinstalled." },
        { status: 409 }
      );
    }

    if (
      !order.vmid ||
      order.vmid <= 0 ||
      !order.node ||
      order.node === "pending"
    ) {
      return NextResponse.json(
        { error: "No provisioned VM to reinstall yet." },
        { status: 400 }
      );
    }

    const service = await getService(order.serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    if (!resolveProvisionTarget(service)) {
      return NextResponse.json(
        {
          error:
            "Reinstall is not configured for this plan (missing template or node).",
        },
        { status: 400 }
      );
    }

    await updateOrder(orderId, { status: "provisioning", provisionError: "" });

    after(() => {
      void import("@/lib/order-provision")
        .then(({ replaceOrderVmFromTemplate }) =>
          replaceOrderVmFromTemplate(orderId)
        )
        .catch((err) => {
          console.error(`[orders/${orderId}/reinstall]`, err);
        });
    });

    return NextResponse.json({
      success: true,
      message:
        "Reinstall started. The VM is being replaced with a fresh image from your plan template. This page will update automatically.",
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to start reinstall" },
      { status: 500 }
    );
  }
}
