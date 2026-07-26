import {
  addSubscription,
  getOrder,
  getService,
  getSubscriptionByOrder,
  updateOrder,
  updateSubscription,
  readActiveOsTemplateProfiles,
  type Order,
  type VPSService,
  type ServiceImageProfile,
} from "@/lib/db";
import {
  applyServiceHardwareToVM,
  cloneVM,
  destroyVM,
  getNextVMID,
  getVMStatus,
  getVMParsedSpecs,
  haltVmForPlanMaintenance,
  pickBestProvisioningNode,
  startVM,
  stopVM,
} from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { getProxmoxHostConfig } from "@/lib/proxmox-host-config";
import {
  cloudInitNetworkForIp,
  getPublicIpNameserverParam,
} from "@/lib/public-ip-pool";
import { updatePublicIpMachineForOrder } from "@/lib/public-ip-store";
import { monthlyAmountNanosForOrder } from "@/lib/service-pricing";
import { privateLanPrefixLen } from "@/lib/private-user-lan";
import {
  resolveCloneChoiceForReinstall,
  effectiveTemplatesForOrder,
  profileByTemplateVmidInList,
  type ReinstallCloneBody,
} from "@/lib/image-profiles";
import { resolveVmDisplayName } from "@/lib/vm-name";

/**
 * Resolve the Proxmox node + template VMID used to clone a guest for an order.
 * When `templateCatalog` is non-empty it drives which VMIDs are acceptable;
 * otherwise `service.proxmoxTemplate` and env `PROXMOX_DEFAULT_TEMPLATE_VMID`
 * remain the fallback (`templateCatalog` is usually from `effectiveTemplatesForOrder`).
 */
export async function resolveProvisionTarget(
  service: VPSService,
  cloneTemplatePreferred: number | null | undefined,
  templateCatalog: ServiceImageProfile[]
): Promise<{
  node: string;
  templateVmid: number;
} | null> {
  const hostCfg = await getProxmoxHostConfig();
  const envNode = process.env.PROXMOX_DEFAULT_NODE?.trim() || "";
  const envTemplateRaw =
    process.env.PROXMOX_DEFAULT_TEMPLATE_VMID?.trim() || "";
  const envTemplate = parseInt(envTemplateRaw, 10);

  const node =
    service.proxmoxNode?.trim() ||
    hostCfg.effectiveDefaultCloneNode ||
    envNode;

  let templateVmid = 0;
  const profiles = templateCatalog;
  const pref =
    cloneTemplatePreferred != null &&
    Number.isFinite(cloneTemplatePreferred) &&
    cloneTemplatePreferred > 0
      ? Math.floor(Number(cloneTemplatePreferred))
      : null;

  if (profiles.length > 0) {
    const hit =
      pref != null ? profiles.find((p) => p.templateVmid === pref) : null;
    templateVmid = hit ? hit.templateVmid : profiles[0]!.templateVmid;
  } else if (service.proxmoxTemplate != null && service.proxmoxTemplate > 0) {
    templateVmid = service.proxmoxTemplate;
  } else if (
    Number.isFinite(envTemplate) &&
    envTemplate > 0
  ) {
    templateVmid = envTemplate;
  }

  if (!node || templateVmid <= 0) {
    console.warn(
      `[provision] cannot auto-provision service ${service.id}: ` +
        `node=${node || "(missing)"} template=${templateVmid || "(missing)"}. ` +
        `Set OS templates per order, TEMPLATE_CATALOG_JSON / legacy imageProfiles on services, proxmoxTemplate, or PROXMOX_DEFAULT_* in env.`
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

type ApplyHardwareToVmOptions = NonNullable<
  Parameters<typeof applyServiceHardwareToVM>[3]
>;

/**
 * Builds the optional third argument for {@link applyServiceHardwareToVM} from Firestore order state.
 */
async function buildApplyHardwareOptionsFromOrder(
  order: Order
): Promise<ApplyHardwareToVmOptions> {
  const hwOpts: ApplyHardwareToVmOptions = {};
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

  const out: ApplyHardwareToVmOptions = {
    ...hwOpts,
    ...(privateLan ? { privateLan } : {}),
  };
  return out;
}

async function applyHardwareToProvisionedVm(
  order: Order,
  service: VPSService
): Promise<void> {
  const hardwareOpts = await buildApplyHardwareOptionsFromOrder(order);
  const { node } = await resolveOrderVmLocation(order);

  await applyServiceHardwareToVM(
    node,
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
 * Change the VPS to a different active catalogue plan (CPU/RAM/disk tier). The VM must be stopped;
 * this halts gracefully (ACPI, then forced stop), applies new sizing, updates Firestore and
 * recurring subscription nanos when present, then restarts only if it was running before.
 *
 * Does not shrink the root disk: the target plan disk size must not be smaller than the
 * VM's current provisioned boot volume.
 */
export async function performVpsPlanChange(
  orderId: string,
  targetServiceId: string
): Promise<{ wasRunning: boolean }> {
  const order = await getOrder(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }
  if (order.status !== "active") {
    throw new Error(
      "Plan changes are only allowed for active VPS. Renew first if suspended."
    );
  }
  if (!order.vmid || order.vmid <= 0 || !order.node?.trim()) {
    throw new Error("No provisioned VM to resize");
  }
  const { node } = await resolveOrderVmLocation(order);

  const targetService = await getService(targetServiceId);
  if (!targetService?.active) {
    throw new Error("That plan does not exist or is not orderable.");
  }

  if (targetService.id === order.serviceId) {
    throw new Error("Already on this plan.");
  }

  let measuredRootGb: number | undefined;
  try {
    const parsed = await getVMParsedSpecs(node, order.vmid);
    measuredRootGb = parsed.disksGb[0];
  } catch {
    /* fall back below */
  }
  const fallbackService = await getService(order.serviceId);
  const measured =
    measuredRootGb !== undefined &&
    typeof measuredRootGb === "number" &&
    Number.isFinite(measuredRootGb) &&
    measuredRootGb > 0
      ? measuredRootGb
      : 0;
  const catalogFloor = fallbackService?.storage ?? 0;
  const minRequiredStorage = Math.max(measured, catalogFloor);

  if (targetService.storage + 1e-6 < minRequiredStorage) {
    const need = Math.ceil(minRequiredStorage);
    throw new Error(
      `This plan allocates ${targetService.storage} GB for the OS disk — smaller than your VM's provisioned boot volume (~${need} GB). Choose a plan with at least ~${need} GB, or reinstall.`
    );
  }

  const hardwareOpts = await buildApplyHardwareOptionsFromOrder(order);
  const { wasRunning } = await haltVmForPlanMaintenance(node, order.vmid);

  try {
    await applyServiceHardwareToVM(
      node,
      order.vmid,
      {
        vcpu: targetService.vcpu,
        ramMb: targetService.ram,
        storageGb: targetService.storage,
      },
      { ...hardwareOpts, skipAttachExtraVolumes: true }
    );

    await updateOrder(orderId, {
      serviceId: targetService.id,
      provisionError: "",
    });

    const subscription = await getSubscriptionByOrder(orderId);
    if (
      subscription &&
      subscription.status !== "cancelled" &&
      (subscription.status === "active" || subscription.status === "past_due")
    ) {
      const amountNanos = await monthlyAmountNanosForOrder(
        targetService,
        order.extraDisksGb
      );
      await updateSubscription(subscription.id, { amountNanos });
    }

    if (wasRunning) {
      await startVM(node, order.vmid);
    }

    return { wasRunning };
  } catch (err) {
    if (wasRunning) {
      try {
        await startVM(node, order.vmid);
      } catch (restartErr) {
        console.error(
          `[performVpsPlanChange] Failed to restart VM after error for ${orderId}:`,
          restartErr
        );
      }
    }
    throw err;
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
    // Read the (possibly migration-corrected) node back out — applyHardwareToProvisionedVm
    // resolves via cluster lookup and Firestore-heals `orders.node`, so re-reading here
    // guarantees `public_ips` stays consistent with wherever the VM actually lives now.
    const fresh = await getOrder(orderId);
    const currentNode = fresh?.node?.trim() || order.node;
    await updatePublicIpMachineForOrder(orderId, order.vmid, currentNode);
  }

  const existing = await getSubscriptionByOrder(orderId);
  if (!existing) {
    const nextPayment = new Date();
    nextPayment.setMonth(nextPayment.getMonth() + 1);
    const amountNanos = await monthlyAmountNanosForOrder(
      service,
      order.extraDisksGb
    );
    // Carry over PayPal metadata (if any) so the subscription row also knows
    // it's PayPal-billed. Advantage: the dunning cron and admin UI can render
    // a "PayPal" pill directly from the subscription without joining Order.
    const paypalFields =
      order.paymentProvider === "paypal" && order.paypalSubscriptionId
        ? {
            paymentProvider: "paypal" as const,
            paypalSubscriptionId: order.paypalSubscriptionId,
          }
        : {};
    await addSubscription({
      orderId,
      userId: order.userId,
      lastPaymentAt: new Date().toISOString(),
      nextPaymentAt: nextPayment.toISOString(),
      amountNanos,
      status: "active",
      ...paypalFields,
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
 * Destroy the current VM, clone a fresh full VM from the chosen catalogue image, then re-apply
 * the same plan (CPU/RAM/disk), cloud-init (credentials, IP, SSH keys), and extra disks.
 * Public IPv4 on the order is kept. Subscriptions are unchanged.
 *
 * Runs in HTTP `after()` (clone can take many minutes). Caller should set provisioning state.
 */
export async function replaceOrderVmFromTemplate(
  orderId: string,
  reinstallBody?: ReinstallCloneBody
): Promise<void> {
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

  const hosted = await readActiveOsTemplateProfiles();
  const profiles = effectiveTemplatesForOrder(order, service, hosted);

  let reinstallChoiceResolved:
    | { profile: ServiceImageProfile; templateVmid: number }
    | null = null;
  if (profiles.length > 0) {
    reinstallChoiceResolved = resolveCloneChoiceForReinstall(
      profiles,
      order,
      reinstallBody ?? {}
    );
    if (!reinstallChoiceResolved) {
      throw new Error(
        "Pick a valid operating system image from your plan — that image is not offered for reinstall."
      );
    }
  }

  const target = await resolveProvisionTarget(
    service,
    reinstallChoiceResolved?.templateVmid ?? null,
    profiles
  );
  if (!target) {
    throw new Error(
      "Provisioning target not configured (set VPS OS templates / TEMPLATE_CATALOG_JSON / legacy service fields / env defaults)."
    );
  }
  const cloneProfileStored =
    reinstallChoiceResolved?.profile.id ??
    profileByTemplateVmidInList(profiles, target.templateVmid)?.id;

  const previousStatus = order.status;
  // The current VM may live on a different node than `order.node` if it was
  // migrated in Proxmox. Resolve before stop/destroy so we don't send those
  // commands to an empty host (which would 404 and abort the reinstall).
  const { node: oldNode } = await resolveOrderVmLocation(order);
  const provisionNode = target.node;
  const provisionTemplateVmid = target.templateVmid;

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
    const vmName = resolveVmDisplayName(orderId, order.vmDisplayName);
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

    await updateOrder(orderId, {
      vmid: newVmid,
      node: targetNode,
      cloneTemplateVmid: provisionTemplateVmid,
      ...(cloneProfileStored !== undefined ? { cloneImageProfileId: cloneProfileStored } : {}),
    });

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