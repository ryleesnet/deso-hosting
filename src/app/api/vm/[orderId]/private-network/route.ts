import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getFirestoreDb } from "@/lib/firebase-admin";
import { getOrder } from "@/lib/db";
import { requireUser } from "@/lib/api-auth";
import { removePrivateLanFromVM } from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import {
  allocatePrivateLanIpv4ForOrder,
  getOrCreatePrivateVlanForUser,
} from "@/lib/private-user-lan";
import { syncProvisionedVmConfigFromOrder } from "@/lib/order-provision";

const ORDERS = "orders";

/**
 * Enable or disable a second virtio NIC on the user's dedicated private VLAN with a
 * host address from 10.200.0.0/24 (isolated per DeSo account on the Proxmox bridge).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      enabled?: boolean;
    };
    const enabled = body.enabled === true;

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (order.userId !== auth.publicKey && !auth.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (order.status === "cancelled") {
      return NextResponse.json(
        { error: "Order is cancelled" },
        { status: 400 }
      );
    }
    if (order.status === "provisioning" || order.status === "pending") {
      return NextResponse.json(
        {
          error:
            "Wait until the VM is ready before changing VM-to-VM private networking.",
        },
        { status: 409 }
      );
    }
    if (
      !order.vmid ||
      order.vmid <= 0 ||
      !order.node?.trim() ||
      order.node === "pending"
    ) {
      return NextResponse.json({ error: "VM not provisioned" }, { status: 400 });
    }

    if (!enabled) {
      const { node } = await resolveOrderVmLocation(order);
      await removePrivateLanFromVM(node, order.vmid);
      await getFirestoreDb().collection(ORDERS).doc(orderId).update({
        privateLanEnabled: false,
        privateLanIp: FieldValue.delete(),
        privateLanVlan: FieldValue.delete(),
      });
      return NextResponse.json({ success: true, enabled: false });
    }

    const vlan = await getOrCreatePrivateVlanForUser(order.userId);
    const ip = await allocatePrivateLanIpv4ForOrder(
      order.userId,
      orderId,
      order.privateLanIp
    );

    await getFirestoreDb().collection(ORDERS).doc(orderId).update({
      privateLanEnabled: true,
      privateLanVlan: vlan,
      privateLanIp: ip,
    });

    await syncProvisionedVmConfigFromOrder(orderId);

    const fresh = await getOrder(orderId);
    return NextResponse.json({
      success: true,
      enabled: true,
      privateLanVlan: fresh?.privateLanVlan,
      privateLanIp: fresh?.privateLanIp,
    });
  } catch (err) {
    console.error("[private-network]", err);
    const msg = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
