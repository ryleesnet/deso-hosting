import {
  getOrder,
  getService,
  getSubscriptionByOrder,
  updateOrder,
  updateSubscription,
} from "@/lib/db";
import {
  provisioningExtraDiskLimits,
  isAllowedExtraDiskTierGb,
} from "@/lib/extra-disks";
import {
  attachExtraDataDisksToVM,
  detachQemuGuestDiskAttachment,
  findPrimaryDiskKey,
  getProxmoxClient,
  haltVmForPlanMaintenance,
  listManagedExtraGuestDiskVolumes,
  startVM,
} from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { monthlyAmountNanosForOrder } from "@/lib/service-pricing";

function approxDiskGbMatch(a: number, b: number): boolean {
  const tol = Math.max(2, Math.round(0.05 * Math.max(a, b)));
  return Math.round(a) === Math.round(b) || Math.abs(a - b) <= tol;
}

async function syncSubscriptionExtraPricing(
  orderId: string,
  serviceId: string,
  extraDisksGb: number[] | undefined
): Promise<void> {
  const service = await getService(serviceId);
  if (!service) return;
  const subscription = await getSubscriptionByOrder(orderId);
  if (
    !subscription ||
    subscription.status === "cancelled" ||
    !(subscription.status === "active" || subscription.status === "past_due")
  ) {
    return;
  }
  const amountNanos = await monthlyAmountNanosForOrder(
    service,
    extraDisksGb?.length ? extraDisksGb : undefined
  );
  await updateSubscription(subscription.id, { amountNanos });
}

async function reconcileExtraKeysWithOrderExtras(
  node: string,
  vmid: number,
  expectedSizes: number[]
): Promise<{ key: string; sizeGb: number }[]> {
  const client = await getProxmoxClient();
  const { data: cfgRes } = await client.get(
    `/nodes/${node}/qemu/${vmid}/config`
  );
  const cfg = cfgRes.data as Record<string, unknown>;
  const volumes = listManagedExtraGuestDiskVolumes(cfg);
  if (volumes.length !== expectedSizes.length) {
    throw new Error(
      `Extra disk count on the host (${volumes.length}) does not match this order (${expectedSizes.length}). Contact support before changing disks.`
    );
  }
  for (let i = 0; i < volumes.length; i++) {
    if (!approxDiskGbMatch(volumes[i]!.sizeGb, expectedSizes[i]!)) {
      throw new Error(
        `Extra disk ${i + 1} size on the host does not match our records. Contact support before removing disks.`
      );
    }
  }
  return volumes;
}

/**
 * Halt the guest, attach one new data volume, append `sizeGb` to `order.extraDisksGb`, refresh
 * subscription nanos when applicable, then restart if the guest was running.
 */
export async function performExtraDiskAdd(
  orderId: string,
  sizeGbRaw: number
): Promise<{ wasRunning: boolean }> {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.status !== "active") {
    throw new Error("Extra disks can only be changed for active VPS.");
  }
  if (!order.vmid || order.vmid <= 0 || !order.node?.trim()) {
    throw new Error("No provisioned VM.");
  }
  const { maxCount } = provisioningExtraDiskLimits();
  const existing = order.extraDisksGb ?? [];
  if (existing.length >= maxCount) {
    throw new Error(`At most ${maxCount} extra data disks.`);
  }
  const gb = Math.floor(Number(sizeGbRaw));
  if (!Number.isFinite(gb) || !isAllowedExtraDiskTierGb(gb)) {
    throw new Error(
      "Extra disk size must be 100 GB, 200 GB, 500 GB, 1 TB, or 2 TB."
    );
  }

  const { node } = await resolveOrderVmLocation(order);
  const vmid = order.vmid;
  const { wasRunning } = await haltVmForPlanMaintenance(node, vmid);

  try {
    const client = await getProxmoxClient();
    const { data: cfgRes } = await client.get(
      `/nodes/${node}/qemu/${vmid}/config`
    );
    const cfg = cfgRes.data as Record<string, unknown>;
    const primary = findPrimaryDiskKey(cfg);

    await attachExtraDataDisksToVM(client, node, vmid, cfg, primary, [gb]);

    const nextExtra = [...existing, gb];
    await updateOrder(orderId, {
      extraDisksGb: nextExtra,
      provisionError: "",
    });
    await syncSubscriptionExtraPricing(orderId, order.serviceId, nextExtra);

    if (wasRunning) await startVM(node, vmid);
    return { wasRunning };
  } catch (err) {
    if (wasRunning) {
      try {
        await startVM(node, vmid);
      } catch (e) {
        console.error(
          `[performExtraDiskAdd] restart after error ${orderId}:`,
          e
        );
      }
    }
    throw err;
  }
}

/**
 * Halt the guest, detach extra volume at `diskIndex`, update Firestore extras + billing, restart if needed.
 * **Destructive**: all filesystem data on that volume is permanently lost from the VM's perspective.
 */
export async function performExtraDiskRemove(
  orderId: string,
  diskIndex: number
): Promise<{ wasRunning: boolean }> {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.status !== "active") {
    throw new Error("Extra disks can only be changed for active VPS.");
  }
  if (!order.vmid || order.vmid <= 0 || !order.node?.trim()) {
    throw new Error("No provisioned VM.");
  }
  const existing = order.extraDisksGb ?? [];
  if (diskIndex < 0 || diskIndex >= existing.length) {
    throw new Error("Invalid extra disk index.");
  }

  const { node } = await resolveOrderVmLocation(order);
  const vmid = order.vmid;
  const { wasRunning } = await haltVmForPlanMaintenance(node, vmid);

  try {
    const volumes = await reconcileExtraKeysWithOrderExtras(node, vmid, existing);
    const keyToRemove = volumes[diskIndex]!.key;

    await detachQemuGuestDiskAttachment(node, vmid, keyToRemove);

    const nextExtra = existing.filter((_, i) => i !== diskIndex);
    await updateOrder(orderId, {
      extraDisksGb: nextExtra.length > 0 ? nextExtra : [],
      provisionError: "",
    });
    await syncSubscriptionExtraPricing(
      orderId,
      order.serviceId,
      nextExtra.length > 0 ? nextExtra : undefined
    );

    if (wasRunning) await startVM(node, vmid);
    return { wasRunning };
  } catch (err) {
    if (wasRunning) {
      try {
        await startVM(node, vmid);
      } catch (e) {
        console.error(
          `[performExtraDiskRemove] restart after error ${orderId}:`,
          e
        );
      }
    }
    throw err;
  }
}
