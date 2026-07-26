import { NextRequest, NextResponse } from "next/server";
import {
  commitSubscriptionRenewalWithTxRecord,
  getOrder,
  getRenewalTxByHash,
  getService,
  getSubscriptionByOrder,
  normalizeRenewalTxHashHex,
} from "@/lib/db";
import {
  monthlyAmountNanosForOrder,
  monthlyTotalUsdCentsForOrder,
} from "@/lib/service-pricing";
import {
  verifyBasicTransferPaymentToRecipient,
  verifyDaoCoinTransferToRecipient,
} from "@/lib/deso-tx-verify";
import { getDesoPaymentRecipientPublicKey } from "@/lib/payment-public-key";
import {
  computeNextPaymentAfterRenewal,
  parseRenewalMonths,
  renewMemoPayload,
} from "@/lib/renewal-months";
import { resumeOrderAfterPayment } from "@/lib/order-lifecycle";
import { requireUser } from "@/lib/api-auth";
import { DUSDC, parsePaymentToken } from "@/lib/deso-tokens";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";

function skipTxVerify(): boolean {
  const v = process.env.BILLING_SKIP_TX_VERIFY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;
    const publicKey = auth.publicKey;

    const body = await req.json();
    const orderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
    const txHashRaw =
      typeof body.txHash === "string" ? body.txHash.trim() : "";
    const months = parseRenewalMonths(body.months);
    const paymentToken = parsePaymentToken(body.paymentToken);

    if (!orderId || !txHashRaw) {
      return NextResponse.json(
        { error: "orderId and txHash are required" },
        { status: 400 }
      );
    }

    if (paymentToken === "PAYPAL") {
      // This route only verifies on-chain DeSo/dUSDC transfers. PayPal
      // renewals go through /api/paypal/renew-subscribe and the webhook.
      return NextResponse.json(
        {
          error:
            "PayPal renewals are handled through the PayPal endpoints, not this route.",
        },
        { status: 400 }
      );
    }

    const normalizedHash = normalizeRenewalTxHashHex(txHashRaw);
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      return NextResponse.json(
        {
          error:
            "txHash must be a 64-character hex transaction id (TxnHashHex from DeSo Identity)",
        },
        { status: 400 }
      );
    }

    const payee = getDesoPaymentRecipientPublicKey();
    if (!payee) {
      return NextResponse.json(
        { error: "Payment recipient not configured (DESO_PAYMENT_PUBLIC_KEY)" },
        { status: 503 }
      );
    }

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (order.userId !== publicKey && !auth.isAdmin) {
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
        { error: "No active subscription to renew" },
        { status: 400 }
      );
    }

    const existing = await getRenewalTxByHash(normalizedHash);
    if (existing) {
      if (existing.orderId !== orderId) {
        return NextResponse.json(
          { error: "This transaction was already used for another order" },
          { status: 409 }
        );
      }
      const sub = await getSubscriptionByOrder(orderId);
      await resumeOrderAfterPayment(orderId).catch((e) =>
        console.error("[billing/renew] resume (idempotent):", e)
      );
      return NextResponse.json({
        success: true,
        idempotent: true,
        nextPaymentAt: sub?.nextPaymentAt ?? null,
        months: existing.months ?? 1,
      });
    }

    const service = await getService(order.serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    const monthlyNanos = await monthlyAmountNanosForOrder(
      service,
      order.extraDisksGb
    );
    const requiredNanos = monthlyNanos * months;
    const memoMarker = renewMemoPayload(orderId, months);

    if (!skipTxVerify()) {
      if (paymentToken === "DUSDC") {
        // dUSDC is USD-pegged: 1 dUSDC = $1 = 10^18 base units, 1 cent = 10^16.
        const rate = await getUsdPerDeso();
        const monthlyUsdCents = monthlyTotalUsdCentsForOrder(
          service,
          rate.usdPerDeso,
          order.extraDisksGb
        );
        const requiredCents = BigInt(monthlyUsdCents) * BigInt(months);
        const requiredBaseUnits = requiredCents * 10n ** 16n;
        const v = await verifyDaoCoinTransferToRecipient({
          transactionIdHexOrBase58: txHashRaw,
          senderPublicKeyBase58: publicKey,
          recipientPublicKeyBase58: payee,
          tokenCreatorPublicKeyBase58: DUSDC.creatorPublicKey,
          minAmountBaseUnits: requiredBaseUnits,
          memoIncludesSubstring: memoMarker,
        });
        if (!v.ok) {
          return NextResponse.json({ error: v.reason }, { status: 400 });
        }
      } else {
        const v = await verifyBasicTransferPaymentToRecipient({
          transactionIdHexOrBase58: txHashRaw,
          senderPublicKeyBase58: publicKey,
          recipientPublicKeyBase58: payee,
          minAmountNanosToRecipient: requiredNanos,
          memoIncludesSubstring: memoMarker,
        });
        if (!v.ok) {
          return NextResponse.json({ error: v.reason }, { status: 400 });
        }
      }
    } else {
      console.warn(
        "BILLING_SKIP_TX_VERIFY: accepted renewal without on-chain verification (dev only)"
      );
    }

    const nextPaymentAt = computeNextPaymentAfterRenewal(
      subscription.nextPaymentAt,
      months
    );
    const now = new Date().toISOString();

    try {
      const outcome = await commitSubscriptionRenewalWithTxRecord({
        txHashHex: normalizedHash,
        orderId,
        subscriptionId: subscription.id,
        totalPaidNanos: requiredNanos,
        months,
        subscriptionMonthlyNanos: monthlyNanos,
        paymentToken,
        lastPaymentAt: now,
        nextPaymentAt,
      });
      await resumeOrderAfterPayment(orderId).catch((e) =>
        console.error("[billing/renew] resume after payment:", e)
      );
      const sub = await getSubscriptionByOrder(orderId);
      return NextResponse.json({
        success: true,
        idempotent: outcome === "idempotent",
        nextPaymentAt: sub?.nextPaymentAt ?? nextPaymentAt,
        months,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "TX_CONFLICT_ORDER") {
        return NextResponse.json(
          { error: "This transaction was already used for another order" },
          { status: 409 }
        );
      }
      if (msg === "SUBSCRIPTION_GONE") {
        return NextResponse.json(
          { error: "Subscription no longer exists" },
          { status: 400 }
        );
      }
      throw e;
    }
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Renewal processing failed" },
      { status: 500 }
    );
  }
}
