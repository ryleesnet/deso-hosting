import { NextRequest, NextResponse, after } from "next/server";
import { getOrder, getService, updateOrder, readActiveOsTemplateProfiles } from "@/lib/db";
import { resolveProvisionTarget } from "@/lib/order-provision";
import {
  effectiveTemplatesForOrder,
  type ReinstallCloneBody,
} from "@/lib/image-profiles";
import { requireUser } from "@/lib/api-auth";

/**
 * User/admin: destroy the current QEMU guest, full-clone again from the selected catalogue image
 * profile (when configured), then re-apply hardware + cloud-init (same plan, IP, credentials,
 * extra disks). Runs in the background like initial provisioning (clone can take many minutes).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;

    let reinstallBody: ReinstallCloneBody = {};
    try {
      reinstallBody = (await req.json()) as ReinstallCloneBody;
    } catch {
      /* empty body OK — uses stored/default image */
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

    const hostedProfiles = await readActiveOsTemplateProfiles();
    const templates = effectiveTemplatesForOrder(order, service, hostedProfiles);
    if (!resolveProvisionTarget(service, null, templates)) {
      return NextResponse.json(
        {
          error:
            "Reinstall is not configured — add active OS templates in Admin, configure this order, set TEMPLATE_CATALOG_JSON / legacy catalogue, or PROXMOX_* env defaults.",
        },
        { status: 400 }
      );
    }
    await updateOrder(orderId, { status: "provisioning", provisionError: "" });

    after(() => {
      void import("@/lib/order-provision")
        .then(({ replaceOrderVmFromTemplate }) =>
          replaceOrderVmFromTemplate(orderId, reinstallBody)
        )
        .catch((err) => {
          console.error(`[orders/${orderId}/reinstall]`, err);
        });
    });

    return NextResponse.json({
      success: true,
      message:
        "Reinstall started. The VM is being replaced from your selected image profile. This page will update automatically.",
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to start reinstall" },
      { status: 500 }
    );
  }
}
