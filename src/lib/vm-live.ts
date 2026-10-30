/**
 * One Proxmox cluster listing for every VM the caller owns.
 * Replaces per-order status/current probes on the dashboard.
 */

import { updateOrder, type Order } from "@/lib/db";
import { getClusterResources } from "@/lib/proxmox";

export type VmLiveStatus = "running" | "stopped" | "paused";

export type VmLiveRow = {
  name: string | null;
  status: VmLiveStatus | null;
};

function normalizeLiveStatus(raw: string | undefined): VmLiveStatus | null {
  const s = raw?.trim().toLowerCase();
  if (s === "running" || s === "stopped" || s === "paused") return s;
  return null;
}

/**
 * Map order id → guest name and power state.
 * When a VM has been migrated, the stored node is updated in the background.
 */
export async function snapshotVmsForOrders(
  orders: Order[]
): Promise<Record<string, VmLiveRow>> {
  const tracked = orders.filter((o) => o.vmid > 0 && o.status !== "cancelled");
  const out: Record<string, VmLiveRow> = {};
  if (!tracked.length) return out;

  const resources = await getClusterResources();
  const byVmid = new Map(resources.map((r) => [r.vmid, r]));

  for (const order of tracked) {
    const row = byVmid.get(order.vmid);
    if (!row) {
      out[order.id] = { name: null, status: null };
      continue;
    }
    out[order.id] = {
      name: row.name?.trim() || null,
      status: normalizeLiveStatus(row.status),
    };

    const liveNode = row.node?.trim();
    const storedNode = order.node?.trim() ?? "";
    if (liveNode && liveNode !== storedNode) {
      void updateOrder(order.id, { node: liveNode }).catch((err) => {
        console.warn(
          "[vm-live] node sync failed",
          order.id,
          err instanceof Error ? err.message : err
        );
      });
    }
  }

  return out;
}
