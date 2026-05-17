import { NextResponse } from "next/server";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";

/** Header: native DESO / USD (from env or DeSo node exchange rate). */
export async function GET() {
  try {
    const { usdPerDeso, source } = await getUsdPerDeso();
    const formatted = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(usdPerDeso);

    return NextResponse.json({
      usdPerDeso,
      source,
      formatted,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not load DeSo price";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
