import {
  addSubscription,
  getOrder,
  getService,
  getSubscriptionByOrder,
  updateOrder,
  type VPSService,
  type Order,
} from "@/lib/db";
import {
  applyServiceHardwareToVM,
  cloneVM,
  destroyVM,
  getNextVMID,
  getVMStatus,
  pickBestProvisioningNode,
  stopVM,
} from "@/lib/proxmox";
import {
  cloudInitNetworkForIp,
  getPublicIpNameserverParam,
  type CloudInitPublicNetwork,
} from "@/lib/public-ip-pool";
import { updatePublicIpMachineForOrder } from "@/lib/public-ip-store";
import { monthlyAmountNanosForOrder } from "@/lib/service-pricing";
import { privateLanPrefixLen } from "@/lib/private-user-lan";

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
async function applyHardwareToProvisionedVm(
  order: Order,
  service: VPSService
): Promise<void> {
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

  const bridge =
    process.env.PROXMOX_PRIVATE_LAN_BRIDGE?.trim() || "vmbr0";
  const privateLan =
    order.privateLanEnabled &&
    order.privateLanIp?.trim() &&
    typeof order.privateLanVlan === "number" &&
    order.privateLanVlan >= 1 &&
    order.privateLanVlan <= 4094
      ? {
          ip: order.privateLanIp.trim(),
          prefixLen: privateLanPrefixLen(),
          vlanTag: order.privateLanVlan,
          bridge,
        }
      : undefined;

  const hardwareOpts: Parameters<typeof applyServiceHardwareToVM>[3] = {
    ...hwOpts,
    ...(privateLan ? { privateLan } : {}),
  };

  await applyServiceHardwareToVM(
    order.node,
    order.vmid,
    {
      vcpu: service.vcpu,
      ramMb: service.ram,
      storageGb: service.storage,
    },
    Object.keys(hardwareOpts).length > 0 ? hardwareOpts : undefined
  );
}

/**
 * Re-apply plan + cloud-init + optional private LAN from Firestore to Proxmox without
 * changing subscription status or marking the order active.
 */
export async function syncProvisionedVmConfigFromOrder(
  orderId: string
): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (!order.vmid || order.vmid <= 0) {
    throw new Error("Order has no VM yet — cannot sync");
  }
  if (!order.node || order.node === "pending") {
    throw new Error("Order has no Proxmox node");
  }
  const service = await getService(order.serviceId);
  if (!service) throw new Error(`Service ${order.serviceId} not found`);
  await applyHardwareToProvisionedVm(order, service);
}

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

  await applyHardwareToProvisionedVm(order, service);

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

const VM_STOP_WAIT_MS = 120_000;

async function stopVmGracefully(node: string, vmid: number): Promise<void> {
  try {
    const s = await getVMStatus(node, vmid);
    if (s.status === "stopped") return;
    if (s.status === "running" || s.status === "paused") {
      await stopVM(node, vmid);
    }
  } catch {
    return;
  }
  const deadline = Date.now() + VM_STOP_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const s = await getVMStatus(node, vmid);
      if (s.status === "stopped") return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await stopVM(node, vmid, { overruleShutdown: true });
  await new Promise((r) => setTimeout(r, 2000));
}

function destroyNotFoundOk(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /404|does not exist|no such vm/i.test(msg);
}

/**
 * Destroy the current VM, clone a fresh full VM from the service template, then re-apply
 * the same plan (CPU/RAM/disk), cloud-init (credentials, IP, SSH keys), and extra disks.
 * Public IPv4 on the order is kept. Subscriptions are unchanged.
 *
 * The HTTP reinstall route sets `provisioning` and runs this in the background.
 */
export async function replaceOrderVmFromTemplate(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`Order ${orderId} not found`);
  if (order.status === "cancelled") {
    throw new Error("Cannot reinstall a cancelled VPS");
  }
  if (!order.vmid || order.vmid <= 0) {
    throw new Error("No provisioned VM to replace");
  }
  if (!order.node || order.node === "pending") {
    throw new Error("Order has no Proxmox node recorded");
  }

  const service = await getService(order.serviceId);
  if (!service) throw new Error(`Service ${order.serviceId} not found`);

  const target = resolveProvisionTarget(service);
  if (!target) {
    throw new Error(
      "Provisioning target not configured (set template/node on the service or env defaults)."
    );
  }

  const previousStatus = order.status;
  const oldNode = order.node;
  const provisionNode = target.node;
  const provisionTemplateVmid = target.templateVmid;

  await updateOrder(orderId, { status: "provisioning", provisionError: "" });

  try {
    await stopVmGracefully(oldNode, order.vmid);

    try {
      await destroyVM(oldNode, order.vmid);
    } catch (destroyErr) {
      if (!destroyNotFoundOk(destroyErr)) {
        throw destroyErr;
      }
    }

    const newVmid = await getNextVMID();
    const vmName = `deso-${orderId.slice(0, 8)}`;
    let targetNode = await pickBestProvisioningNode(provisionNode, {
      ramMb: service.ram,
      vcpu: service.vcpu,
    });

    async function runClone(withTarget?: string) {
      await cloneVM(
        provisionNode,
        provisionTemplateVmid,
        newVmid,
        vmName,
        true,
        withTarget && withTarget !== provisionNode
          ? { target: withTarget }
          : undefined
      );
    }

    try {
      await runClone(targetNode);
    } catch (firstErr) {
      if (targetNode !== provisionNode) {
        console.warn(
          "[reinstall] clone with target node failed; retrying on template node:",
          firstErr
        );
        targetNode = provisionNode;
        await runClone(undefined);
      } else {
        throw firstErr;
      }
    }

    await updateOrder(orderId, { vmid: newVmid, node: targetNode });

    await configureProvisionedVM(orderId);

    if (previousStatus === "suspended") {
      await updateOrder(orderId, { status: "suspended" });
    }
  } catch (err) {
    const msg = provisionErrorMessage(err);
    if (/Proxmox clone task timed out/i.test(msg)) {
      console.warn(
        `${orderId}: reinstall clone task poll ended before PVE finished (VM may still be cloning).`
      );
      await updateOrder(orderId, {
        status: "pending",
        provisionError:
          msg +
          " If a VM appears in Proxmox shortly, contact support to link it to your order.",
        vmid: 0,
        node: provisionNode,
      });
      return;
    }
    console.error(`[replaceOrderVmFromTemplate] ${orderId}:`, err);
    await updateOrder(orderId, {
      status: "pending",
      provisionError: msg,
      vmid: 0,
      node: provisionNode,
    });
    throw err;
  }
}
