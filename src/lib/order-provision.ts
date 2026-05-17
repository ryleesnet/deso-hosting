import {
  addSubscription,
  getOrder,
  getService,
  getSubscriptionByOrder,
  updateOrder,
  type VPSService,
} from "@/lib/db";
import { applyServiceHardwareToVM } from "@/lib/proxmox";
import {
  cloudInitNetworkForIp,
  getPublicIpNameserverParam,
  type CloudInitPublicNetwork,
} from "@/lib/public-ip-pool";
import { updatePublicIpMachineForOrder } from "@/lib/public-ip-store";
import { monthlyAmountNanosForOrder } from "@/lib/service-pricing";

/**
 * Resolve the Proxmox node + template that should be used to provision a service order.
 * Falls back to PROXMOX_DEFAULT_NODE / PROXMOX_DEFAULT_TEMPLATE_VMID env vars when the
 * service record itself does not carry those fields (admin form leaves them optional).
 */
export function resolveProvisionTarget(service: VPSService): {
  node: string;
  templateVmid: number;
} | null {
  const envNode = process.env.PROXMOX_DEFAULT_NODE?.trim() || "";
  const envTemplateRaw = process.env.PROXMOX_DEFAULT_TEMPLATE_VMID?.trim() || "";
  const envTemplate = parseInt(envTemplateRaw, 10);

  const node = service.proxmoxNode?.trim() || envNode;
  const templateVmid =
    service.proxmoxTemplate != null && service.proxmoxTemplate > 0
      ? service.proxmoxTemplate
      : Number.isFinite(envTemplate) && envTemplate > 0
        ? envTemplate
        : 0;

  if (!node || templateVmid <= 0) {
    console.warn(
      `[provision] cannot auto-provision service ${service.id}: ` +
        `node=${node || "(missing)"} template=${templateVmid || "(missing)"}. ` +
        `Set proxmoxNode + proxmoxTemplate on the service or PROXMOX_DEFAULT_NODE / PROXMOX_DEFAULT_TEMPLATE_VMID in env.`
    );
    return null;
  }
  return { node, templateVmid };
}

/** Stringify a thrown value for storage on the order so the user/admin can see what failed. */
export function provisionErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.slice(0, 1000);
  try {
    return String(err).slice(0, 1000);
  } catch {
    return "Unknown provisioning error";
  }
}

/**
 * Run hardware + cloud-init + subscription steps against a VM that has already been cloned.
 * Idempotent: skips subscription creation if one already exists. Clears `provisionError`
 * on success so a retried order shows clean state.
 *
 * Used both by the initial post-clone path in `finalizeProvision` and by the explicit
 * `POST /api/orders/[id]/retry-provision` route, so users can recover when the configure
 * step failed (e.g. transient PVE errors) without re-cloning the VM.
 */
export async function configureProvisionedVM(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (!order.vmid || order.vmid <= 0) {
    throw new Error("Order has no VM yet — cannot configure");
  }
  if (!order.node || order.node === "pending") {
    throw new Error("Order has no Proxmox node");
  }

  const service = await getService(order.serviceId);
  if (!service) throw new Error(`Service ${order.serviceId} not found`);

  const hwOpts: {
    cloudInit?: {
      ciuser: string;
      cipassword: string;
      network?: CloudInitPublicNetwork;
      nameserver?: string;
      sshkeys?: string;
    };
    extraDisksGb?: unknown;
  } = {};
  if (order.vmLoginUsername && order.vmLoginPassword) {
    hwOpts.cloudInit = {
      ciuser: order.vmLoginUsername,
      cipassword: order.vmLoginPassword,
    };
    if (order.cloudInitSshKeys?.trim()) {
      hwOpts.cloudInit.sshkeys = order.cloudInitSshKeys.trim();
    }
    if (order.publicIpv4) {
      hwOpts.cloudInit.network = await cloudInitNetworkForIp(order.publicIpv4);
    }
    const ns = await getPublicIpNameserverParam();
    if (ns) {
      hwOpts.cloudInit.nameserver = ns;
    }
  }
  if (order.extraDisksGb?.length) {
    hwOpts.extraDisksGb = order.extraDisksGb;
  }

  await applyServiceHardwareToVM(
    order.node,
    order.vmid,
    {
      vcpu: service.vcpu,
      ramMb: service.ram,
      storageGb: service.storage,
    },
    Object.keys(hwOpts).length ? hwOpts : undefined
  );

  // Use "" rather than undefined so the merged Firestore doc actually clears any prior error;
  // forFirestore strips undefined fields, which would leave the old error in place.
  await updateOrder(orderId, {
    status: "active",
    provisionError: "",
  });

  if (order.publicIpv4) {
    await updatePublicIpMachineForOrder(orderId, order.vmid, order.node);
  }

  const existing = await getSubscriptionByOrder(orderId);
  if (!existing) {
    const nextPayment = new Date();
    nextPayment.setMonth(nextPayment.getMonth() + 1);
    const amountNanos = await monthlyAmountNanosForOrder(
      service,
      order.extraDisksGb
    );
    await addSubscription({
      orderId,
      userId: order.userId,
      lastPaymentAt: new Date().toISOString(),
      nextPaymentAt: nextPayment.toISOString(),
      amountNanos,
      status: "active",
    });
  }
}
