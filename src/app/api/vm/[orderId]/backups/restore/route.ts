import { NextRequest, NextResponse, after } from "next/server";
import { getOrder, updateOrder } from "@/lib/db";
import {
  listVmBackups,
  restoreVmFromBackup,
  formatProxmoxApiError,
} from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { resolveProxmoxBackupStoragePool } from "@/lib/proxmox-host-config";
import { provisionErrorMessage } from "@/lib/order-provision";
import { requireUser } from "@/lib/api-auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    let body: { volid?: unknown };
    try {
      body = (await req.json()) as { volid?: unknown };
    } catch {
      return NextResponse.json(
        { error: "Expected JSON body with volid" },
        { status: 400 }
      );
    }

    const volid =
      typeof body.volid === "string" ? body.volid.trim() : "";
    if (!volid) {
      return NextResponse.json(
        { error: "volid is required" },
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

    if (order.status !== "active") {
      return NextResponse.json(
        {
          error:
            "Backups can only be restored for an active VPS. Renew first if suspended.",
        },
        { status: 400 }
      );
    }

    if (order.adjustingPlan) {
      return NextResponse.json(
        { error: "Finish the current plan change before restoring a backup." },
        { status: 409 }
      );
    }

    if (order.hardwareMaintenance || order.backupRestoreInProgress) {
      return NextResponse.json(
        {
          error: order.backupRestoreInProgress
            ? "A backup restore is already running for this VPS."
            : "Another maintenance operation is already running for this VPS.",
        },
        { status: 409 }
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

    const storagePool = await resolveProxmoxBackupStoragePool();
    const { node: liveNode } = await resolveOrderVmLocation(order);
    const backups = await listVmBackups(liveNode, order.vmid, storagePool);
    const match = backups.find((b) => b.volid === volid);
    if (!match) {
      return NextResponse.json(
        { error: "Selected backup was not found for this VPS." },
        { status: 400 }
      );
    }

    await updateOrder(orderId, {
      hardwareMaintenance: true,
      backupRestoreInProgress: true,
      provisionError: "",
    });

    const node = liveNode;
    const vmid = order.vmid;
    const archive = volid;
    const oid = orderId;

    after(() => {
      void (async () => {
        try {
          await restoreVmFromBackup(node, vmid, archive);
        } catch (err) {
          const msg = provisionErrorMessage(err);
          console.error(`[vm/${oid}/backups/restore]`, err);
          await updateOrder(oid, { provisionError: msg });
        } finally {
          await updateOrder(oid, {
            hardwareMaintenance: false,
            backupRestoreInProgress: false,
          });
        }
      })();
    });

    return NextResponse.json({
      success: true,
      message:
        "Restore started — the VPS will shut down, restore from backup, then start again. This may take several minutes.",
    });
  } catch (err) {
    console.error("[vm/backups/restore]", err);
    const message = formatProxmoxApiError(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
