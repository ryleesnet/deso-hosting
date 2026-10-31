import { NextRequest, NextResponse } from "next/server";
import { getOrder } from "@/lib/db";
import { settleStaleMaintenance } from "@/lib/order-maintenance";
import { requireUser } from "@/lib/api-auth";

/**
 * One order document. The dashboard uses this while a VM is provisioning or
 * in hardware maintenance, instead of re-reading every order and subscription.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
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

  const settled = await settleStaleMaintenance(order);
  return NextResponse.json(settled);
}
