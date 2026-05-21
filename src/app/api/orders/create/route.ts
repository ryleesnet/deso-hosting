import { NextRequest, NextResponse, after } from "next/server";
import {
  getService,
  getOrder,
  addOrder,
  updateOrder,
} from "@/lib/db";
import {
  cloneVM,
  getNextVMID,
  pickBestProvisioningNode,
} from "@/lib/proxmox";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";
import { vmCredentialsFromDesoLogin } from "@/lib/vm-credentials";
import { normalizeExtraDisksGb } from "@/lib/extra-disks";
import {
  allocatePublicIpForOrder,
  isPublicIpPoolConfigured,
} from "@/lib/public-ip-pool";
import {
  parseSshAuthFromBody,
  normalizeAndValidateSshPublicKeysInput,
  generateEd25519SshKeypairForVm,
  sshKeyCommentForDesoUser,
} from "@/lib/ssh-keys";
import {
  configureProvisionedVM,
  provisionErrorMessage,
  resolveProvisionTarget,
} from "@/lib/order-provision";
import { requireUser } from "@/lib/api-auth";
import { ORDER_TERMS_REVISION } from "@/lib/terms-revision";

/** Clone + resize + subscribe after HTTP response returns (dashboard can poll provisioning → active). */
async function finalizeProvision(orderId: string) {
  const order = await getOrder(orderId);
  if (!order || order.vmid !== 0 || order.status !== "provisioning") return;

  const service = await getService(order.serviceId);
  if (!service) {
    await updateOrder(orderId, { status: "pending" });
    return;
  }
  const target = resolveProvisionTarget(service);
  if (!target) {
    await updateOrder(orderId, { status: "pending" });
    return;
  }
  const provisionNode = target.node;
  const provisionTemplateVmid = target.templateVmid;

  let newVmid = 0;
  let targetNode = provisionNode;
  let publicIpv4: string | undefined = order.publicIpv4;

  try {
    newVmid = await getNextVMID();
    const vmName = `deso-${orderId.slice(0, 8)}`;

    targetNode = await pickBestProvisioningNode(provisionNode, {
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
          "[provision] clone with target node failed; retrying on template node:",
          firstErr
        );
        targetNode = provisionNode;
        await runClone(undefined);
      } else {
        throw firstErr;
      }
    }
  } catch (cloneErr) {
    console.error("Background provision failed during clone:", cloneErr);
    const msg = provisionErrorMessage(cloneErr);
    if (/Proxmox clone task timed out/i.test(msg)) {
      console.warn(
        `${orderId}: clone task poll ended before PVE finished (VM may still be cloning). Leaving order provisioning — raise PROXMOX_CLONE_TASK_TIMEOUT_MS or set to 0 for no limit.`
      );
      return;
    }
    await updateOrder(orderId, { status: "pending", provisionError: msg });
    return;
  }

  // Clone succeeded — record the VM on the order *before* configuring it so that any
  // subsequent failure does not orphan the VM in PVE; the user can retry from the dashboard.
  await updateOrder(orderId, { vmid: newVmid, node: targetNode });

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

export async function POST(req: NextRequest) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;
    const publicKey = auth.publicKey;

    const body = await req.json();
    const {
      serviceId,
      desoUsername,
      extraDisksGb,
      sshAccess,
      sshPublicKey,
      acceptedTermsRevision,
    } = body as {
      serviceId?: string;
      desoUsername?: string;
      extraDisksGb?: unknown;
      sshAccess?: unknown;
      sshPublicKey?: unknown;
      acceptedTermsRevision?: unknown;
    };

    if (acceptedTermsRevision !== ORDER_TERMS_REVISION) {
      return NextResponse.json(
        {
          error:
            "You must accept the current Terms of Service before creating an order.",
        },
        { status: 400 }
      );
    }

    const normalizedExtra = normalizeExtraDisksGb(extraDisksGb);
    const sshMode = parseSshAuthFromBody(sshAccess);

    if (!serviceId) {
      return NextResponse.json(
        { error: "Missing serviceId" },
        { status: 400 }
      );
    }

    const service = await getService(serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }
    if (!service.active) {
      return NextResponse.json({ error: "Service is not available" }, { status: 400 });
    }

    const target = resolveProvisionTarget(service);

    let desoHandle: string | undefined =
      typeof desoUsername === "string" && desoUsername.trim()
        ? desoUsername.trim()
        : undefined;
    if (!desoHandle) {
      desoHandle = await fetchDesoUsernameByPublicKey(publicKey);
    }
    const credentials = vmCredentialsFromDesoLogin(publicKey, desoHandle);

    let cloudInitSshKeys: string | undefined;
    let generatedSshPrivateKey: string | undefined;
    let generatedSshPublicKeyLine: string | undefined;

    if (sshMode === "paste") {
      const pasted =
        typeof sshPublicKey === "string" ? sshPublicKey : "";
      const v = normalizeAndValidateSshPublicKeysInput(pasted);
      if (!v.ok) {
        return NextResponse.json({ error: v.error }, { status: 400 });
      }
      cloudInitSshKeys = v.cloudInitSshKeys;
    } else if (sshMode === "generate") {
      try {
        const comment = sshKeyCommentForDesoUser(desoHandle, publicKey);
        const pair = generateEd25519SshKeypairForVm(comment);
        cloudInitSshKeys = pair.publicKeyLine;
        generatedSshPrivateKey = pair.privateKeyOpenssh;
        generatedSshPublicKeyLine = pair.publicKeyLine;
      } catch (e) {
        return NextResponse.json(
          {
            error:
              e instanceof Error
                ? e.message
                : "Could not generate an SSH key on the server.",
          },
          { status: 503 }
        );
      }
    }

    const orderSshFields =
      cloudInitSshKeys !== undefined
        ? { cloudInitSshKeys }
        : {};

    const orderResponseExtras =
      generatedSshPrivateKey !== undefined &&
      generatedSshPublicKeyLine !== undefined
        ? {
            generatedSshPrivateKey,
            generatedSshPublicKeyLine,
          }
        : {};

    if (target) {
      const order = await addOrder({
        userId: publicKey,
        serviceId,
        vmid: 0,
        node: target.node,
        status: "provisioning",
        ...credentials,
        ...(normalizedExtra.length > 0 ? { extraDisksGb: normalizedExtra } : {}),
        ...orderSshFields,
      });

      after(() => {
        finalizeProvision(order.id).catch((e) =>
          console.error("finalizeProvision:", e)
        );
      });

      return NextResponse.json({
        order,
        provisioning: true,
        message: "Provisioning started. You'll see updates on your dashboard shortly.",
        ...orderResponseExtras,
      });
    }

    const order = await addOrder({
      userId: publicKey,
      serviceId,
      vmid: 0,
      node: service.proxmoxNode?.trim() || "pending",
      status: "pending",
      ...credentials,
      ...(normalizedExtra.length > 0 ? { extraDisksGb: normalizedExtra } : {}),
      ...orderSshFields,
    });

    return NextResponse.json({
      order,
      message: "Order created. Admin will provision your VPS.",
      ...orderResponseExtras,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to create order" },
      { status: 500 }
    );
  }
}
