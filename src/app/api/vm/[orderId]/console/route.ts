import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/db";
import { getVMStatus, getVNCProxy } from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { createConsoleToken } from "@/lib/console-tokens.js";
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

    if (order.status === "suspended" && !auth.isAdmin) {
      return NextResponse.json(
        {
          error:
            "This VPS is suspended. Renew your subscription to restore access.",
        },
        { status: 403 }
      );
    }

    const { node } = await resolveOrderVmLocation(order);

    const vmStatus = await getVMStatus(node, order.vmid);
    if (vmStatus.status !== "running") {
      return NextResponse.json(
        { error: "VM must be running to access console. Start the VM first." },
        { status: 400 }
      );
    }

    if (!process.env.PROXMOX_TOKEN_ID || !process.env.PROXMOX_TOKEN_SECRET) {
      return NextResponse.json(
        {
          error: "Proxmox API token required for console",
          detail:
            "Set PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET. The console authenticates the WebSocket with the API token (no separate session/cookie is needed).",
        },
        { status: 503 }
      );
    }

    const proxy = await getVNCProxy(node, order.vmid);
    const token = createConsoleToken(
      proxy.ticket,
      proxy.port,
      node,
      order.vmid
    );

    // The vncticket also doubles as QEMU's VNC password (DES-encrypted in the
    // RFB auth handshake); noVNC needs it as `credentials.password`.
    return NextResponse.json({
      proxyPath: `/api/proxmox-ws?token=${token}`,
      vncPassword: proxy.ticket,
    });
  } catch (err) {
    console.error("[Console API]", err);
    const message =
      err instanceof Error ? err.message : "Failed to get console access";
    const detail =
      err && typeof err === "object" && "response" in err
        ? (err as { response?: { status?: number; data?: unknown } }).response
            ?.data
        : null;
    return NextResponse.json(
      {
        error: "Failed to get console access",
        detail: detail ? String(detail) : message,
      },
      { status: 500 }
    );
  }
}
