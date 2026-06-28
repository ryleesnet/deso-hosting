import { NextRequest, NextResponse, after } from "next/server";
import { getOrder, getService, updateOrder } from "@/lib/db";
import {
  performVpsPlanChange,
  provisionErrorMessage,
} from "@/lib/order-provision";
import { requireUser } from "@/lib/api-auth";

/**
 * User/admin: stop the VM gracefully, resize CPU/RAM/root disk for another catalogue tier,
 * update the order record and recurring subscription nanos when present, then start the VM again
 * if it was running. Runs in `after(...)` because Proxmox can take longer than typical HTTP limits.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    let body: { targetServiceId?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Expected JSON body with targetServiceId" },
        { status: 400 }
      );
    }
    const targetServiceId =
      typeof body.targetServiceId === "string"
        ? body.targetServiceId.trim()
        : "";
    if (!targetServiceId) {
      return NextResponse.json(
        { error: "targetServiceId is required" },
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

    if (order.status === "cancelled") {
      return NextResponse.json(
        { error: "This order is cancelled" },
        { status: 400 }
      );
    }

    if (order.status === "provisioning") {
      return NextResponse.json(
        {
          error:
            "This VPS is busy (provisioning or reinstall). Wait until it finishes.",
        },
        { status: 409 }
      );
    }

    if (order.adjustingPlan) {
      return NextResponse.json(
        { error: "A plan change is already running for this VPS." },
        { status: 409 }
      );
    }

    if (order.hardwareMaintenance || order.backupRestoreInProgress) {
      return NextResponse.json(
        {
          error: order.backupRestoreInProgress
            ? "Finish the backup restore before changing plans."
            : "Finish the current disk operation before changing plans.",
        },
        { status: 409 }
      );
    }

    if (order.status !== "active") {
      return NextResponse.json(
        {
          error:
            "Plan changes are only allowed for active VPS. Renew first if suspended.",
        },
        { status: 400 }
      );
    }

    if (!order.vmid || order.vmid <= 0 || !order.node?.trim()) {
      return NextResponse.json(
        { error: "No provisioned VM to resize" },
        { status: 400 }
      );
    }

    const previewTarget = await getService(targetServiceId);
    if (!previewTarget?.active) {
      return NextResponse.json(
        { error: "That plan does not exist or is not orderable." },
        { status: 400 }
      );
    }
    if (previewTarget.id === order.serviceId) {
      return NextResponse.json(
        { error: "Already on this plan." },
        { status: 400 }
      );
    }

    await updateOrder(orderId, {
      adjustingPlan: true,
      provisionError: "",
    });

    after(() => {
      void (async () => {
        try {
          await performVpsPlanChange(orderId, targetServiceId);
        } catch (err) {
          const msg = provisionErrorMessage(err);
          console.error(`[orders/${orderId}/change-plan]`, err);
          await updateOrder(orderId, { provisionError: msg });
        } finally {
          await updateOrder(orderId, { adjustingPlan: false });
        }
      })();
    });

    return NextResponse.json({
      success: true,
      message:
        "Plan change started. The VPS will shut down briefly while CPU, memory, and root disk sizing are applied. Refresh can take about a minute.",
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to start plan change" },
      { status: 500 }
    );
  }
}
