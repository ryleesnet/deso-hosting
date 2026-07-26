import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/db";
import {
  startVM,
  stopVM,
  shutdownVM,
  rebootVM,
  resetVM,
  formatProxmoxApiError,
} from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { requireUser } from "@/lib/api-auth";

type Action =
  | "start"
  | "stop"
  | "shutdown"
  | "force_shutdown"
  | "reboot"
  | "reset";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    const { action } = await req.json();

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.userId !== auth.publicKey && !auth.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (order.status === "suspended" && !auth.isAdmin) {
      return NextResponse.json(
        {
          error:
            "This VPS is suspended. Renew your subscription to restore access.",
        },
        { status: 403 }
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
        { error: "VM is not provisioned yet (invalid VM ID)" },
        { status: 400 }
      );
    }

    const validActions: Action[] = [
      "start",
      "stop",
      "shutdown",
      "force_shutdown",
      "reboot",
      "reset",
    ];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: "Invalid action" },
        { status: 400 }
      );
    }

    const { node } = await resolveOrderVmLocation(order);

    switch (action) {
      case "start":
        await startVM(node, order.vmid);
        break;
      case "stop":
        await shutdownVM(node, order.vmid); // Graceful stop
        break;
      case "shutdown":
        await shutdownVM(node, order.vmid);
        break;
      case "force_shutdown":
        await stopVM(node, order.vmid, { overruleShutdown: true });
        break;
      case "reboot":
        await rebootVM(node, order.vmid); // Graceful reboot
        break;
      case "reset":
        await resetVM(node, order.vmid); // Force stop/restart
        break;
    }

    return NextResponse.json({ success: true, action });
  } catch (err) {
    console.error("[vm/control]", err);
    const message = formatProxmoxApiError(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
