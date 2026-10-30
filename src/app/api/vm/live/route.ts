import { NextRequest, NextResponse } from "next/server";
import { getOrdersByUser } from "@/lib/db";
import { snapshotVmsForOrders } from "@/lib/vm-live";
import { requireUser } from "@/lib/api-auth";

/** Power state and display name for the caller's VMs, from one cluster listing. */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  try {
    const orders = await getOrdersByUser(auth.publicKey);
    const byOrderId = await snapshotVmsForOrders(orders);
    return NextResponse.json({ byOrderId });
  } catch (err) {
    console.error("[vm/live]", err);
    return NextResponse.json(
      { error: "Failed to load VM status" },
      { status: 500 }
    );
  }
}
