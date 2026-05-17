import { NextRequest, NextResponse } from "next/server";
import { purgeCancelledOrdersPastRetention } from "@/lib/cancelled-order-retention";

/**
 * POST /api/cron/purge-cancelled-orders
 * Authorization: Bearer CRON_SECRET — or ?secret= (same as billing-dunning).
 * Deletes Firestore `orders` documents that have been `cancelled` longer than CANCELLED_ORDER_RETENTION_DAYS (default 90).
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 }
    );
  }

  const auth = req.headers.get("authorization");
  const bearerOk = auth === `Bearer ${secret}`;
  const queryOk = req.nextUrl.searchParams.get("secret") === secret;
  if (!bearerOk && !queryOk) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { deletedOrderIds } = await purgeCancelledOrdersPastRetention();
    return NextResponse.json({
      ok: true,
      deletedCount: deletedOrderIds.length,
      deletedOrderIds,
    });
  } catch (e) {
    console.error("[cron/purge-cancelled-orders]", e);
    return NextResponse.json(
      {
        error: "Job failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
