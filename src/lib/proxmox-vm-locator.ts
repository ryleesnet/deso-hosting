/**
 * Locate a VM inside a Proxmox cluster after a manual migration.
 *
 * Every order stores the node it was provisioned on (`orders.node`). When an
 * operator migrates a VM between hosts (via `qm migrate`, the PVE web UI, or
 * HA failover) the VM's node changes but our Firestore row does not. Any
 * subsequent API call that uses `/nodes/${order.node}/qemu/${vmid}/...` then
 * 404s and the site "loses" the VM.
 *
 * The pattern below is the fix:
 *
 *   const { node } = await resolveOrderVmLocation(order);
 *   await startVM(node, order.vmid);
 *
 * `resolveOrderVmLocation` does two things:
 *   1. Asks Proxmox for the VM's current node (fast-path uses `order.node`,
 *      slow-path scans `/cluster/resources?type=vm`).
 *   2. If the node drifted, transparently updates `orders.node` in Firestore
 *      so the next call goes straight to the fast-path.
 *
 * That means every VM-related endpoint self-heals after a manual migration —
 * you don't need to touch anything in the admin UI when you move a VM.
 */

import { resolveCurrentNodeForVmid } from "@/lib/proxmox";
import { updateOrder, type Order } from "@/lib/db";

export interface ResolvedVmLocation {
  /** Node that currently hosts the VM according to Proxmox. */
  node: string;
  /** VMID (unchanged; convenience passthrough for call sites). */
  vmid: number;
  /** True when the answer differed from `order.node` (i.e. the VM was migrated). */
  moved: boolean;
  /**
   * True when we found no live location in Proxmox (VM was destroyed, VMID
   * mistyped, cluster resource endpoint unavailable, etc.). Callers should
   * fall back to the stored `order.node` and accept that the operation may
   * fail — this only happens for genuinely broken states.
   */
  missing: boolean;
}

/**
 * Resolve the current live node for an order's VM.
 *
 * When the VM has moved, `orders.node` is transparently updated in Firestore
 * (best-effort — a persistence failure never blocks the caller).
 *
 * When the VM cannot be located anywhere in the cluster, returns
 * `{ node: order.node, missing: true }` so the caller can still attempt the
 * operation (or handle the failure with its usual error path).
 */
export async function resolveOrderVmLocation(
  order: Pick<Order, "id" | "vmid" | "node">
): Promise<ResolvedVmLocation> {
  const hint = order.node?.trim() || "";
  const vmid = Number(order.vmid) || 0;

  if (vmid <= 0) {
    return { node: hint, vmid, moved: false, missing: true };
  }

  let result: { node: string; moved: boolean } | null = null;
  try {
    result = await resolveCurrentNodeForVmid(vmid, hint);
  } catch (e) {
    console.warn("[proxmox-vm-locator] resolve failed; using stored node hint", {
      orderId: order.id,
      vmid,
      hint,
      error: e instanceof Error ? e.message : e,
    });
    return { node: hint, vmid, moved: false, missing: false };
  }

  if (!result) {
    return { node: hint, vmid, moved: false, missing: true };
  }

  if (result.moved) {
    console.log(
      `[proxmox-vm-locator] Order ${order.id} VM ${vmid} moved: ${hint || "(none)"} -> ${result.node}. Syncing Firestore.`
    );
    try {
      await updateOrder(order.id, { node: result.node });
    } catch (e) {
      console.warn(
        "[proxmox-vm-locator] Failed to persist moved node (non-fatal)",
        { orderId: order.id, error: e instanceof Error ? e.message : e }
      );
    }
  }

  return { node: result.node, vmid, moved: result.moved, missing: false };
}

/**
 * Convenience: resolve and return only the node string.
 *
 * Prefer `resolveOrderVmLocation` when callers need to know whether the VM was
 * missing / moved. This helper exists for the common "I just need a valid node
 * name to plug into a Proxmox call" case.
 */
export async function getCurrentNodeForOrder(
  order: Pick<Order, "id" | "vmid" | "node">
): Promise<string> {
  const r = await resolveOrderVmLocation(order);
  return r.node;
}
