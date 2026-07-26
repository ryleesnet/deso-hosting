/**
 * Called by the browser inside `paypal.Buttons({ createSubscription })`.
 *
 * Given a `serviceId` and optional order shape (extra disks), we
 *  1. compute the PayPal-charged monthly USD cents (catalog + surcharge),
 *  2. ensure a PayPal Product + Plan exist for that priced snapshot,
 *  3. return the plan id so the client can hand it to PayPal directly.
 *
 * Auth: the DeSo user must be logged in — same as the DeSo/dUSDC checkout.
 * The user's DeSo public key is the identity we bind the eventual PayPal
 * subscription to (see /api/paypal/capture-order).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import {
  getOrder,
  getService,
  getSubscriptionByOrder,
} from "@/lib/db";
import { normalizeTieredExtraDisksGb } from "@/lib/extra-disks";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import { monthlyTotalUsdCentsForOrder } from "@/lib/service-pricing";
import {
  ensurePaypalPlanForService,
  paypalEnv,
  paypalIsConfigured,
} from "@/lib/paypal";
import {
  paypalSurchargeCents,
  paypalSurchargeConfig,
} from "@/lib/paypal-surcharge";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    if (!paypalIsConfigured()) {
      return NextResponse.json(
        { error: "PayPal is not configured on this server." },
        { status: 503 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      /** "new_order" | "renew" */
      intent?: unknown;
      serviceId?: unknown;
      extraDisksGb?: unknown;
      /** Present when intent = "renew". Ignored otherwise. */
      orderId?: unknown;
    };

    const intent =
      typeof body.intent === "string" && body.intent === "renew"
        ? "renew"
        : "new_order";

    // Resolve the priced service snapshot (extra disks change the total).
    let serviceId: string;
    let extraDisksGb: number[];
    if (intent === "renew") {
      const orderId =
        typeof body.orderId === "string" ? body.orderId.trim() : "";
      if (!orderId) {
        return NextResponse.json(
          { error: "orderId is required for renewal" },
          { status: 400 }
        );
      }
      const order = await getOrder(orderId);
      if (!order) {
        return NextResponse.json(
          { error: "Order not found" },
          { status: 404 }
        );
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
      const sub = await getSubscriptionByOrder(orderId);
      if (
        !sub ||
        (sub.status !== "active" && sub.status !== "past_due")
      ) {
        return NextResponse.json(
          { error: "No active subscription to renew" },
          { status: 400 }
        );
      }
      serviceId = order.serviceId;
      extraDisksGb = order.extraDisksGb ?? [];
    } else {
      serviceId =
        typeof body.serviceId === "string" ? body.serviceId.trim() : "";
      if (!serviceId) {
        return NextResponse.json(
          { error: "serviceId is required" },
          { status: 400 }
        );
      }
      extraDisksGb = normalizeTieredExtraDisksGb(body.extraDisksGb);
    }

    const service = await getService(serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }
    if (service.testing && !auth.isAdmin) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }
    if (!service.testing && !service.active) {
      return NextResponse.json(
        { error: "Service is not available" },
        { status: 400 }
      );
    }

    const rate = await getUsdPerDeso();
    const baseUsdCents = monthlyTotalUsdCentsForOrder(
      service,
      rate.usdPerDeso,
      extraDisksGb
    );
    const surchargeCfg = paypalSurchargeConfig();
    const surchargeCents = paypalSurchargeCents(baseUsdCents, surchargeCfg);
    const monthlyUsdCents = baseUsdCents + surchargeCents;

    const { paypalPlanId, paypalProductId } = await ensurePaypalPlanForService(
      service,
      monthlyUsdCents
    );

    return NextResponse.json({
      env: paypalEnv(),
      paypalPlanId,
      paypalProductId,
      baseUsdCents,
      surchargeCents,
      monthlyUsdCents,
      surcharge: surchargeCfg,
    });
  } catch (err) {
    console.error("[paypal/create-subscription]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "PayPal setup failed" },
      { status: 500 }
    );
  }
}
