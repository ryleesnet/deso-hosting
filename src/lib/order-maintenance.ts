/**
 * Hardware jobs (plan resize, extra disks, backup restore) set boolean flags
 * on the order. If the Node process dies mid-job, those flags stay set and
 * the dashboard would read Firestore until the tab closes. Stamp a start
 * time and clear the flags once that time is too old.
 */

import { updateOrder, type Order } from "@/lib/db";

/** Past this, a still-set maintenance flag is treated as a crashed job. */
export const MAINTENANCE_STALE_MS = 45 * 60 * 1000;

export function maintenanceFlagsActive(order: Pick<
  Order,
  "adjustingPlan" | "hardwareMaintenance" | "backupRestoreInProgress"
>): boolean {
  return !!(
    order.adjustingPlan ||
    order.hardwareMaintenance ||
    order.backupRestoreInProgress
  );
}

/**
 * Leave an in-progress job alone. Give a legacy flag (no start time) a clock
 * on the first poll. Clear flags that have outlived `MAINTENANCE_STALE_MS`.
 */
export async function settleStaleMaintenance(order: Order): Promise<Order> {
  if (!maintenanceFlagsActive(order)) return order;

  const raw = order.asyncJobStartedAt?.trim() ?? "";
  const started = Date.parse(raw);
  if (!raw || !Number.isFinite(started)) {
    const stamped = await updateOrder(order.id, {
      asyncJobStartedAt: new Date().toISOString(),
    });
    return stamped ?? order;
  }

  if (Date.now() - started < MAINTENANCE_STALE_MS) return order;

  const cleared = await updateOrder(order.id, {
    adjustingPlan: false,
    hardwareMaintenance: false,
    backupRestoreInProgress: false,
    asyncJobStartedAt: "",
    provisionError: order.provisionError?.trim()
      ? order.provisionError
      : "Maintenance did not finish in time. Check the VPS, then try again.",
  });
  return cleared ?? order;
}
