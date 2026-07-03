import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { sendManualPastDueBillingDm } from "@/lib/billing-notifications";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    const result = await sendManualPastDueBillingDm(orderId);

    if (result.ok) {
      return NextResponse.json({ success: true });
    }

    const status = result.disabled ? 503 : 400;
    return NextResponse.json({ error: result.error }, { status });
  } catch (err) {
    console.error("[admin/notify-past-due]", err);
    const msg =
      err instanceof Error ? err.message : "Failed to send past due notification";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
