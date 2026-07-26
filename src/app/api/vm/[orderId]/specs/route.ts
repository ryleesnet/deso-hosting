import { NextRequest, NextResponse } from "next/server";
import { getOrder, getService } from "@/lib/db";
import { getVMParsedSpecs } from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { requireUser } from "@/lib/api-auth";

export async function GET(
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

    const service = await getService(order.serviceId);
    const planFallback = {
      vcpus: service?.vcpu ?? 0,
      memoryMb: service?.ram ?? 0,
      disksGb:
        service && service.storage > 0 ? [service.storage] : ([] as number[]),
      source: "plan" as const,
    };

    if (!order.node?.trim() || !order.vmid || order.vmid <= 0) {
      return NextResponse.json(planFallback);
    }

    try {
      const { node } = await resolveOrderVmLocation(order);
      const parsed = await getVMParsedSpecs(node, order.vmid);
      const disksGb =
        parsed.disksGb.length > 0 ? parsed.disksGb : planFallback.disksGb;
      const memoryMb =
        parsed.memoryMb > 0 ? parsed.memoryMb : planFallback.memoryMb;
      const vcpus = parsed.vcpus > 0 ? parsed.vcpus : planFallback.vcpus;

      return NextResponse.json({
        vcpus,
        memoryMb,
        disksGb,
        source: "proxmox",
      });
    } catch {
      return NextResponse.json(planFallback);
    }
  } catch (err) {
    console.error("[vm/specs]", err);
    return NextResponse.json(
      { error: "Failed to load VM specs" },
      { status: 500 }
    );
  }
}
