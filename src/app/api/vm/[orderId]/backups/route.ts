import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/db";
import { listVmBackups, formatProxmoxApiError } from "@/lib/proxmox";
import { resolveProxmoxBackupStoragePool } from "@/lib/proxmox-host-config";
import { requireUser } from "@/lib/api-auth";

async function loadAuthorizedOrder(req: NextRequest, orderId: string) {
  const auth = await requireUser(req);
  if (!auth.ok) return { error: auth.response };

  const order = await getOrder(orderId);
  if (!order) {
    return {
      error: NextResponse.json({ error: "Order not found" }, { status: 404 }),
    };
  }

  if (order.userId !== auth.publicKey && !auth.isAdmin) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 403 }),
    };
  }

  if (order.status === "suspended" && !auth.isAdmin) {
    return {
      error: NextResponse.json(
        {
          error:
            "This VPS is suspended. Renew your subscription to restore access.",
        },
        { status: 403 }
      ),
    };
  }

  if (!order.node?.trim()) {
    return {
      error: NextResponse.json(
        { error: "VM node is not set for this order" },
        { status: 400 }
      ),
    };
  }

  if (!order.vmid || order.vmid <= 0) {
    return {
      error: NextResponse.json(
        { error: "VM is not provisioned yet (invalid VM ID)" },
        { status: 400 }
      ),
    };
  }

  return { order, auth };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const { orderId } = await params;
    const loaded = await loadAuthorizedOrder(req, orderId);
    if ("error" in loaded && loaded.error) return loaded.error;
    const { order } = loaded as { order: NonNullable<Awaited<ReturnType<typeof getOrder>>> };

    const storagePool = await resolveProxmoxBackupStoragePool();
    const backups = await listVmBackups(order.node, order.vmid, storagePool);

    return NextResponse.json({
      backups,
      storagePool,
    });
  } catch (err) {
    console.error("[vm/backups GET]", err);
    const message = formatProxmoxApiError(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
