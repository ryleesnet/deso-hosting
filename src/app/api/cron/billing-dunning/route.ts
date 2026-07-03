import { NextRequest, NextResponse } from "next/server";
import { runBillingDunning } from "@/lib/order-lifecycle";

/**
 * POST /api/cron/billing-dunning
 * Authorization: Bearer CRON_SECRET — or ?secret= (for simple schedulers).
 * Marks overdue subscriptions `past_due`, then suspends active orders past the grace period after due.
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
    const result = await runBillingDunning();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[cron/billing-dunning]", e);
    return NextResponse.json(
      {
        error: "Job failed",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 500 }
    );
  }
}
