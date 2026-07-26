import { NextRequest, NextResponse } from "next/server";
import { getOrder, getService, getSubscriptionByOrder } from "@/lib/db";
import { monthlyTotalUsdCentsForOrder } from "@/lib/service-pricing";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import {
  formatDesoFromNanos,
  formatUsdCents,
  usdCentsToNanos,
} from "@/lib/pricing";
import { parseRenewalMonths, MAX_RENEWAL_MONTHS } from "@/lib/renewal-months";
import { requireUser } from "@/lib/api-auth";
import { formatDusdcAmount, usdCentsToDusdcHex } from "@/lib/deso-tokens";
import {
  paypalSurchargeCents,
  paypalSurchargeConfig,
} from "@/lib/paypal-surcharge";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get("orderId")?.trim() ?? "";
    const months = parseRenewalMonths(searchParams.get("months"));

    if (!orderId) {
      return NextResponse.json(
        { error: "orderId is required" },
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

    if (order.status === "cancelled") {
      return NextResponse.json(
        { error: "This order is cancelled" },
        { status: 400 }
      );
    }

    const subscription = await getSubscriptionByOrder(orderId);
    if (
      !subscription ||
      (subscription.status !== "active" && subscription.status !== "past_due")
    ) {
      return NextResponse.json(
        { error: "No active subscription to renew for this order" },
        { status: 400 }
      );
    }

    const service = await getService(order.serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    const rate = await getUsdPerDeso();
    const monthlyUsdCents = monthlyTotalUsdCentsForOrder(
      service,
      rate.usdPerDeso,
      order.extraDisksGb
    );
    const monthlyNanos = usdCentsToNanos(monthlyUsdCents, rate.usdPerDeso);
    const totalUsdCents = monthlyUsdCents * months;
    const amountNanos = monthlyNanos * months;

    const surchargeCfg = paypalSurchargeConfig();
    const paypalMonthlySurchargeCents = paypalSurchargeCents(
      monthlyUsdCents,
      surchargeCfg
    );
    const paypalMonthlyUsdCents = monthlyUsdCents + paypalMonthlySurchargeCents;

    return NextResponse.json({
      orderId,
      serviceName: service.name,
      months,
      maxRenewalMonths: MAX_RENEWAL_MONTHS,
      monthlyUsdCents,
      monthlyUsdFormatted: formatUsdCents(monthlyUsdCents),
      totalUsdCents,
      totalUsdFormatted: formatUsdCents(totalUsdCents),
      monthlyAmountNanos: monthlyNanos,
      amountNanos,
      monthlyDesoFormatted: formatDesoFromNanos(monthlyNanos),
      desoFormatted: formatDesoFromNanos(amountNanos),
      // dUSDC (wrapped USDC on DeSo) is USD-pegged, so no rate conversion is
      // needed — cents map 1:1. `dusdcAmountHex` is the exact uint256 the
      // client must pass as `DAOCoinToTransferNanos`.
      monthlyDusdcFormatted: formatDusdcAmount(monthlyUsdCents),
      dusdcFormatted: formatDusdcAmount(totalUsdCents),
      dusdcAmountHex: usdCentsToDusdcHex(totalUsdCents),
      monthlyDusdcAmountHex: usdCentsToDusdcHex(monthlyUsdCents),
      usdPerDeso: rate.usdPerDeso,
      rateSource: rate.source,
      nextPaymentAt: subscription.nextPaymentAt,
      subscriptionStatus: subscription.status,
      // PayPal renewal quote: PayPal auto-charges monthly, so we always quote
      // "1 month + surcharge" regardless of the `months` selector (PayPal
      // subscriptions don't take multi-month lump-sum payments).
      paypalMonthlySurchargeCents,
      paypalMonthlySurchargeFormatted: formatUsdCents(
        paypalMonthlySurchargeCents
      ),
      paypalMonthlyUsdCents,
      paypalMonthlyUsdFormatted: formatUsdCents(paypalMonthlyUsdCents),
      paypalSurchargePercent: surchargeCfg.percent,
      paypalSurchargeFixedCents: surchargeCfg.fixedCents,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not build renewal quote";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
