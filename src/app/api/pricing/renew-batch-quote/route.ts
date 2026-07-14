import { NextRequest, NextResponse } from "next/server";
import { getOrder, getService, getSubscriptionByOrder } from "@/lib/db";
import { monthlyTotalUsdCentsForOrder } from "@/lib/service-pricing";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import {
  formatDesoFromNanos,
  formatUsdCents,
  usdCentsToNanos,
} from "@/lib/pricing";
import {
  MAX_BATCH_RENEWAL_ORDERS,
  parseRenewalMonths,
  renewBatchMemoFull,
  sortRenewBatchItems,
  type RenewBatchItem,
} from "@/lib/renewal-months";
import { requireUser } from "@/lib/api-auth";
import { formatDusdcAmount, usdCentsToDusdcHex } from "@/lib/deso-tokens";

type BatchItemResult = {
  orderId: string;
  serviceName: string;
  months: number;
  monthlyUsdCents: number;
  monthlyUsdFormatted: string;
  totalUsdCents: number;
  totalUsdFormatted: string;
  monthlyAmountNanos: number;
  amountNanos: number;
  desoFormatted: string;
  dusdcFormatted: string;
  nextPaymentAt: string;
  subscriptionStatus: string;
};

/**
 * Uniform interface accepts either a single `months` value applied to every
 * `orderIds` entry, or a `batch` JSON payload with per-order months. All items
 * must belong to the authenticated user.
 */
function parseItems(searchParams: URLSearchParams): {
  ok: true;
  items: RenewBatchItem[];
} | { ok: false; error: string } {
  const rawBatch = searchParams.get("batch")?.trim();
  if (rawBatch) {
    try {
      const parsed = JSON.parse(rawBatch);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return { ok: false, error: "batch must be a non-empty array" };
      }
      const items: RenewBatchItem[] = [];
      for (const row of parsed) {
        if (!row || typeof row !== "object") {
          return { ok: false, error: "batch items must be objects" };
        }
        const orderId =
          typeof (row as { orderId?: unknown }).orderId === "string"
            ? ((row as { orderId: string }).orderId).trim()
            : "";
        if (!orderId) return { ok: false, error: "batch item missing orderId" };
        items.push({
          orderId,
          months: parseRenewalMonths((row as { months?: unknown }).months),
        });
      }
      return { ok: true, items };
    } catch {
      return { ok: false, error: "batch must be valid JSON" };
    }
  }

  const rawIds = searchParams.get("orderIds")?.trim() ?? "";
  const months = parseRenewalMonths(searchParams.get("months"));
  const ids = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, error: "Provide orderIds or a batch payload" };
  }
  return {
    ok: true,
    items: ids.map((orderId) => ({ orderId, months })),
  };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const parsed = parseItems(new URL(req.url).searchParams);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const items = parsed.items;
    if (items.length > MAX_BATCH_RENEWAL_ORDERS) {
      return NextResponse.json(
        { error: `Too many orders (max ${MAX_BATCH_RENEWAL_ORDERS} per batch).` },
        { status: 400 }
      );
    }
    const uniqueOrderIds = new Set(items.map((i) => i.orderId));
    if (uniqueOrderIds.size !== items.length) {
      return NextResponse.json(
        { error: "Duplicate orderId in batch" },
        { status: 400 }
      );
    }

    const rate = await getUsdPerDeso();
    let totalUsdCents = 0;
    let totalAmountNanos = 0;
    const rows: BatchItemResult[] = [];

    for (const item of items) {
      const order = await getOrder(item.orderId);
      if (!order) {
        return NextResponse.json(
          { error: `Order ${item.orderId} not found` },
          { status: 404 }
        );
      }
      if (order.userId !== auth.publicKey && !auth.isAdmin) {
        return NextResponse.json(
          { error: `Not authorized for order ${item.orderId}` },
          { status: 403 }
        );
      }
      if (order.status === "cancelled") {
        return NextResponse.json(
          { error: `Order ${item.orderId} is cancelled` },
          { status: 400 }
        );
      }
      const subscription = await getSubscriptionByOrder(item.orderId);
      if (
        !subscription ||
        (subscription.status !== "active" && subscription.status !== "past_due")
      ) {
        return NextResponse.json(
          { error: `Order ${item.orderId} has no active subscription to renew` },
          { status: 400 }
        );
      }
      const service = await getService(order.serviceId);
      if (!service) {
        return NextResponse.json(
          { error: `Service missing for order ${item.orderId}` },
          { status: 404 }
        );
      }

      const monthlyUsdCents = monthlyTotalUsdCentsForOrder(
        service,
        rate.usdPerDeso,
        order.extraDisksGb
      );
      const monthlyAmountNanos = usdCentsToNanos(monthlyUsdCents, rate.usdPerDeso);
      const perItemUsdCents = monthlyUsdCents * item.months;
      const perItemNanos = monthlyAmountNanos * item.months;
      totalUsdCents += perItemUsdCents;
      totalAmountNanos += perItemNanos;

      rows.push({
        orderId: item.orderId,
        serviceName: service.name,
        months: item.months,
        monthlyUsdCents,
        monthlyUsdFormatted: formatUsdCents(monthlyUsdCents),
        totalUsdCents: perItemUsdCents,
        totalUsdFormatted: formatUsdCents(perItemUsdCents),
        monthlyAmountNanos,
        amountNanos: perItemNanos,
        desoFormatted: formatDesoFromNanos(perItemNanos),
        dusdcFormatted: formatDusdcAmount(perItemUsdCents),
        nextPaymentAt: subscription.nextPaymentAt,
        subscriptionStatus: subscription.status,
      });
    }

    const sortedItems = sortRenewBatchItems(items);
    const memoFull = renewBatchMemoFull(sortedItems);

    return NextResponse.json({
      count: items.length,
      items: rows,
      totalUsdCents,
      totalUsdFormatted: formatUsdCents(totalUsdCents),
      totalAmountNanos,
      totalDesoFormatted: formatDesoFromNanos(totalAmountNanos),
      totalDusdcFormatted: formatDusdcAmount(totalUsdCents),
      totalDusdcAmountHex: usdCentsToDusdcHex(totalUsdCents),
      usdPerDeso: rate.usdPerDeso,
      rateSource: rate.source,
      memoFull,
      maxBatchOrders: MAX_BATCH_RENEWAL_ORDERS,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not build batch renewal quote";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
