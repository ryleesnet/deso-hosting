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
  createVmFromCloudImage,
  destroyVM,
  getNextVMID,
  getVMParsedSpecs,
  haltVmForPlanMaintenance,
  pickBestProvisioningNode,
  reinstallVmInPlaceFromImageFile,
  resolveCloudImageReference,
  startVM,
} from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import { getProxmoxHostConfig } from "@/lib/proxmox-host-config";
import {
  allocatePublicIpForOrder,
  cloudInitNetworkForIp,
  getPublicIpNameserverParam,
  isPublicIpPoolConfigured,
} from "@/lib/public-ip-pool";
import { updatePublicIpMachineForOrder } from "@/lib/public-ip-store";
import { monthlyAmountNanosForOrder } from "@/lib/service-pricing";
import { privateLanPrefixLen } from "@/lib/private-user-lan";
import {
  resolveCloneChoiceForReinstall,
  effectiveTemplatesForOrder,
  profileByIdInList,
  type ReinstallCloneBody,
} from "@/lib/image-profiles";
import { resolveVmDisplayName } from "@/lib/vm-name";

/**
 * Resolve the Proxmox node used to create a guest for an order.
 * Auto-provision requires a node plus at least one OS image (`imageFile`) in
 * the catalogue.
 */
export async function resolveProvisionTarget(
  service: VPSService,
  imageCatalog: ServiceImageProfile[]
): Promise<{ node: string } | null> {
  const hostCfg = await getProxmoxHostConfig();
  const envNode = process.env.PROXMOX_DEFAULT_NODE?.trim() || "";

  const node =
    service.proxmoxNode?.trim() ||
    hostCfg.effectiveDefaultCloneNode ||
    envNode;

  const hasImage = imageCatalog.some((p) => Boolean(p.imageFile?.trim()));

  if (!node || !hasImage) {
    console.warn(
      `[provision] cannot auto-provision service ${service.id}: ` +
        `node=${node || "(missing)"} images=${hasImage ? "ok" : "(missing)"}. ` +
        `Set OS images (image file) in Admin, per-order overrides, or TEMPLATE_CATALOG_JSON, and PROXMOX_DEFAULT_NODE.`
    );
    return null;
  }
  return { node };
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

function resolveImageFileForProvision(
  order: Order,
  profiles: ServiceImageProfile[]
): { imageFile: string; profile?: ServiceImageProfile } | null {
  const byId = profileByIdInList(profiles, order.cloneImageProfileId);
  const chosen = byId ?? profiles.find((p) => p.imageFile?.trim()) ?? null;
  const imageFile = chosen?.imageFile?.trim();
  if (!imageFile) return null;
  return { imageFile, profile: chosen ?? undefined };
}

/**
 * Background provisioner used by DeSo checkout (`/api/orders/create`) and
 * PayPal capture. Creates a new QEMU guest and imports the cloud image from
 * `cloudimg:import/...` (same as reinstall).
 *
 * Idempotent against a second call: bails out unless the order is still
 * `provisioning` with `vmid === 0`.
 */
export async function finalizeOrderProvision(orderId: string): Promise<void> {
  const order = await getOrder(orderId);
  if (!order || order.vmid !== 0 || order.status !== "provisioning") return;

  const service = await getService(order.serviceId);
  if (!service) {
    await updateOrder(orderId, { status: "pending" });
    return;
  }
  const hostedProfiles = await readActiveOsTemplateProfiles();
  const profilesForCatalog = effectiveTemplatesForOrder(
    order,
    service,
    hostedProfiles
  );
  const target = await resolveProvisionTarget(service, profilesForCatalog);
  if (!target) {
    await updateOrder(orderId, { status: "pending" });
    return;
  }
  const provisionNode = target.node;
  const imageChoice = resolveImageFileForProvision(order, profilesForCatalog);
  if (!imageChoice) {
    await updateOrder(orderId, {
      status: "pending",
      provisionError:
        "No OS image file is configured. Add an image file on the OS catalogue in Admin.",
    });
    return;
  }
  const imageFileRef = imageChoice.imageFile;

  let newVmid = 0;
  let targetNode = provisionNode;
  let publicIpv4: string | undefined = order.publicIpv4;

  try {
    newVmid = await getNextVMID();
    const vmName = resolveVmDisplayName(orderId, order.vmDisplayName);
    const ramMb = service.ram;
    const vcpu = service.vcpu;
    const storageGb = Math.floor(service.storage) || 0;
    if (storageGb <= 0) {
      throw new Error(
        `Cannot provision: plan storage is invalid (${storageGb} GB).`
      );
    }

    targetNode = await pickBestProvisioningNode(provisionNode, {
      ramMb,
      vcpu,
    });

    async function provisionGuestOnNode(onNode: string) {
      await createVmFromCloudImage(
        onNode,
        newVmid,
        vmName,
        resolveCloudImageReference(imageFileRef),
        storageGb,
        { vcpu, ramMb }
      );
    }

    try {
      await provisionGuestOnNode(targetNode);
    } catch (firstErr) {
      if (targetNode !== provisionNode) {
        console.warn(
          "[provision] create on target node failed; retrying on default node:",
          firstErr
        );
        try {
          await destroyVM(targetNode, newVmid);
        } catch {
          /* createVmFromCloudImage already destroys on failure */
        }
        targetNode = provisionNode;
        await provisionGuestOnNode(provisionNode);
      } else {
        throw firstErr;
      }
    }
  } catch (createErr) {
    console.error("Background provision failed during create/import:", createErr);
    const msg = provisionErrorMessage(createErr);
    if (/Proxmox (disk-import|qemu-create) task timed out/i.test(msg)) {
      console.warn(
        `${orderId}: Proxmox task poll ended before PVE finished (VM may still be creating). Leaving order provisioning — raise PROXMOX_IMPORT_TASK_TIMEOUT_MS or set to 0 for no limit.`
      );
      return;
    }
    await updateOrder(orderId, { status: "pending", provisionError: msg });
    return;
  }

  await updateOrder(orderId, {
    vmid: newVmid,
    node: targetNode,
    ...(imageChoice.profile
      ? { cloneImageProfileId: imageChoice.profile.id }
      : {}),
  });

  if (await isPublicIpPoolConfigured()) {
    try {
      if (!publicIpv4) {
        publicIpv4 = await allocatePublicIpForOrder({
          userId: order.userId,
          orderId: order.id,
          vmid: newVmid,
          node: targetNode,
        });
        await updateOrder(orderId, { publicIpv4 });
      }
    } catch (allocErr) {
      console.error("Public IP allocation failed:", allocErr);
      await updateOrder(orderId, {
        status: "pending",
        provisionError: provisionErrorMessage(allocErr),
      });
      return;
    }
  }

  try {
    await configureProvisionedVM(orderId);
  } catch (configureErr) {
    console.error("Background provision failed during configure:", configureErr);
    await updateOrder(orderId, {
      status: "pending",
      provisionError: provisionErrorMessage(configureErr),
    });
  }
}

/**
 * Fast in-place reinstall: keep VMID / MAC / cloud-init / extra disks, swap the
 * root disk for a fresh import of the chosen cloud image (`qm importdisk`).
 *
 * The disk is resized to at least the current disk size (never smaller than
 * `service.storage`) so previously-grown plans keep their capacity.
 */
async function reinstallOrderInPlaceFromImageFile(
  order: Order,
  service: VPSService,
  reinstallChoice: { profile: ServiceImageProfile },
  imageFile: string
): Promise<void> {
  const { node } = await resolveOrderVmLocation(order);

  let currentDiskGb = 0;
  try {
    const parsed = await getVMParsedSpecs(node, order.vmid);
    currentDiskGb = parsed.disksGb[0] ?? 0;
  } catch (err) {
    console.warn(
      `[reinstallOrderInPlaceFromImageFile] ${order.id}: could not read current disk size; falling back to plan storage:`,
      err
    );
  }
  const targetSizeGb = Math.max(
    Math.floor(currentDiskGb) || 0,
    Math.floor(service.storage) || 0
  );
  if (targetSizeGb <= 0) {
    throw new Error(
      `Cannot reinstall: unable to determine a valid disk size for order ${order.id}.`
    );
  }

  const imageRef = resolveCloudImageReference(imageFile);
  const previousStatus = order.status;

  try {
    await reinstallVmInPlaceFromImageFile(
      node,
      order.vmid,
      imageRef,
      targetSizeGb,
      { startAfter: false, regenerateCloudInit: true }
    );

    const nextStatus: Order["status"] =
      previousStatus === "suspended" ? "suspended" : "active";
    await updateOrder(order.id, {
      cloneImageProfileId: reinstallChoice.profile.id,
      status: nextStatus,
      provisionError: "",
    });
  } catch (err) {
    const msg = provisionErrorMessage(err);
    console.error(
      `[reinstallOrderInPlaceFromImageFile] ${order.id}:`,
      err
    );
    await updateOrder(order.id, {
      status: "pending",
      provisionError: msg,
    });
    throw err;
  }
}

/**
 * Reinstall a VPS by importing the chosen catalogue cloud image onto the
 * existing VMID (`qm importdisk` style). Runs in HTTP `after()`.
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
  if (profiles.length === 0) {
    throw new Error(
      "No OS images are configured. Add an image file on the OS catalogue in Admin."
    );
  }

  const reinstallChoiceResolved = resolveCloneChoiceForReinstall(
    profiles,
    order,
    reinstallBody ?? {}
  );
  if (!reinstallChoiceResolved) {
    throw new Error(
      "Pick a valid operating system image from your plan — that image is not offered for reinstall."
    );
  }

  const chosenImageFile = reinstallChoiceResolved.profile.imageFile?.trim();
  if (!chosenImageFile) {
    throw new Error(
      `OS image “${reinstallChoiceResolved.profile.label}” has no image file configured.`
    );
  }

  await reinstallOrderInPlaceFromImageFile(
    order,
    service,
    reinstallChoiceResolved,
    chosenImageFile
  );
}

