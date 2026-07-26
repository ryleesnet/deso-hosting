import { NextRequest, NextResponse } from "next/server";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import {
  formatDesoFromNanos,
  formatUsdCents,
  usdCentsToNanos,
} from "@/lib/pricing";
import {
  paypalSurchargeCents,
  paypalSurchargeConfig,
} from "@/lib/paypal-surcharge";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const raw = searchParams.get("usdCents");
    const usdCents = raw != null ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(usdCents) || usdCents < 0 || usdCents > 99_999_999) {
      return NextResponse.json(
        { error: "Invalid usdCents (0–99999999)" },
        { status: 400 }
      );
    }

    const { usdPerDeso, source } = await getUsdPerDeso();
    const amountNanos = usdCentsToNanos(usdCents, usdPerDeso);
    const surchargeCfg = paypalSurchargeConfig();
    const paypalSurcharge = paypalSurchargeCents(usdCents, surchargeCfg);
    const paypalUsdCents = usdCents + paypalSurcharge;

    return NextResponse.json({
      usdCents,
      usdFormatted: formatUsdCents(usdCents),
      amountNanos,
      desoFormatted: formatDesoFromNanos(amountNanos),
      desoAmount: amountNanos / 1e9,
      usdPerDeso,
      rateSource: source,
      // PayPal fields (present even when PayPal is not configured — the UI just
      // hides the button; these keep the checkout math consistent regardless).
      paypalSurchargeCents: paypalSurcharge,
      paypalSurchargeFormatted: formatUsdCents(paypalSurcharge),
      paypalUsdCents,
      paypalUsdFormatted: formatUsdCents(paypalUsdCents),
      paypalSurchargePercent: surchargeCfg.percent,
      paypalSurchargeFixedCents: surchargeCfg.fixedCents,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not compute DeSo quote";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
