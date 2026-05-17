/**
 * Firestore `orders` in status `cancelled` are kept for a retention period, then purged (doc delete).
 * Subscriptions are removed immediately on cancel — see `/api/orders/[orderId]/cancel`.
 */

import { deleteOrder, getOrders, type Order } from "@/lib/db";

/** Days to retain a cancelled order document before deletion. */
export function cancelledOrderRetentionDays(): number {
  const raw = process.env.CANCELLED_ORDER_RETENTION_DAYS?.trim();
  const n = raw ? parseInt(raw, 10) : 90;
  return Number.isFinite(n) && n > 0 ? n : 90;
}

function cancelledAtMs(order: Order): number | undefined {
  if (!order.cancelledAt?.trim()) return undefined;
  const t = new Date(order.cancelledAt).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Deletes `orders` docs that are `cancelled` and whose `cancelledAt` is older than the retention window.
 * Orders cancelled before `cancelledAt` existed are never purged automatically.
 */
export async function purgeCancelledOrdersPastRetention(): Promise<{
  deletedOrderIds: string[];
}> {
  const retentionMs = cancelledOrderRetentionDays() * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  const orders = await getOrders();
  const deletedOrderIds: string[] = [];

  for (const o of orders) {
    if (o.status !== "cancelled") continue;
    const ts = cancelledAtMs(o);
    if (ts == null || ts > cutoff) continue;
    await deleteOrder(o.id);
    deletedOrderIds.push(o.id);
  }

  return { deletedOrderIds };
}
