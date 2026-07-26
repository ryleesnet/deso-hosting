/**
 * Called by the browser inside `paypal.Buttons({ onApprove })` after the buyer
 * approves a PayPal subscription. This is the PayPal analogue of
 * `/api/orders/create` — it does exactly what that endpoint does, except the
 * "payment" is a PayPal subscription id (which we verify against PayPal's
 * REST API) instead of a DeSo transaction hash.
 *
 * We deliberately share the provisioning + auth code path with the DeSo
 * checkout so the two payment rails cannot drift in behavior.
 */

import { NextRequest, NextResponse, after } from "next/server";
import {
  addOrder,
  getOrder,
  getService,
  readActiveOsTemplateProfiles,
  updateOrder,
} from "@/lib/db";
import { requireUser } from "@/lib/api-auth";
import { normalizeTieredExtraDisksGb } from "@/lib/extra-disks";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";
import { vmCredentialsFromDesoLogin } from "@/lib/vm-credentials";
import { ORDER_TERMS_REVISION } from "@/lib/terms-revision";
import { getProxmoxHostConfig } from "@/lib/proxmox-host-config";
import {
  resolveVmDisplayName,
  validateVmDisplayName,
} from "@/lib/vm-name";
import {
  parseSshAuthFromBody,
  normalizeAndValidateSshPublicKeysInput,
  generateEd25519SshKeypairForVm,
  sshKeyCommentForDesoUser,
} from "@/lib/ssh-keys";
import {
  cloneVM,
  getNextVMID,
  pickBestProvisioningNode,
} from "@/lib/proxmox";
import {
  configureProvisionedVM,
  provisionErrorMessage,
  resolveProvisionTarget,
} from "@/lib/order-provision";
import {
  resolveCloneChoiceFromBody,
  effectiveTemplatesForCheckout,
  effectiveTemplatesForOrder,
  profileByTemplateVmidInList,
} from "@/lib/image-profiles";
import {
  allocatePublicIpForOrder,
  isPublicIpPoolConfigured,
} from "@/lib/public-ip-pool";
import {
  cancelPaypalSubscription,
  ensurePaypalPlanForService,
  getPaypalSubscription,
  paypalIsConfigured,
} from "@/lib/paypal";
import { getUsdPerDeso } from "@/lib/deso-usd-rate";
import { monthlyTotalUsdCentsForOrder } from "@/lib/service-pricing";
import {
  paypalSurchargeCents,
  paypalSurchargeConfig,
} from "@/lib/paypal-surcharge";

/** Same background provisioner used by the DeSo checkout, duplicated here to avoid a circular import. */
async function finalizeProvision(orderId: string) {
  const order = await getOrder(orderId);
  if (!order || order.vmid !== 0 || order.status !== "provisioning") return;
  const service = await getService(order.serviceId);
  if (!service) {
    await updateOrder(orderId, { status: "pending" });
    return;
  }
  const hostedProfiles = await readActiveOsTemplateProfiles();
  const target = await resolveProvisionTarget(
    service,
    order.cloneTemplateVmid ?? null,
    effectiveTemplatesForOrder(order, service, hostedProfiles)
  );
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
    const vmName = resolveVmDisplayName(orderId, order.vmDisplayName);
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
          "[paypal capture] clone with target failed; retrying on template node:",
          firstErr
        );
        targetNode = provisionNode;
        await runClone(undefined);
      } else {
        throw firstErr;
      }
    }
  } catch (cloneErr) {
    console.error("[paypal capture] provision (clone) failed:", cloneErr);
    const msg = provisionErrorMessage(cloneErr);
    if (/Proxmox clone task timed out/i.test(msg)) return;
    await updateOrder(orderId, { status: "pending", provisionError: msg });
    return;
  }

  const profilesForCatalog = effectiveTemplatesForOrder(
    order,
    service,
    hostedProfiles
  );
  const cloneMeta = profileByTemplateVmidInList(
    profilesForCatalog,
    provisionTemplateVmid
  );
  await updateOrder(orderId, {
    vmid: newVmid,
    node: targetNode,
    cloneTemplateVmid: provisionTemplateVmid,
    ...(cloneMeta ? { cloneImageProfileId: cloneMeta.id } : {}),
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
      console.error("[paypal capture] IP allocation failed:", allocErr);
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
    console.error("[paypal capture] configure failed:", configureErr);
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

    if (!paypalIsConfigured()) {
      return NextResponse.json(
        { error: "PayPal is not configured on this server." },
        { status: 503 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      serviceId?: unknown;
      paypalSubscriptionId?: unknown;
      desoUsername?: unknown;
      extraDisksGb?: unknown;
      sshAccess?: unknown;
      sshPublicKey?: unknown;
      acceptedTermsRevision?: unknown;
      imageProfileId?: unknown;
      templateVmid?: unknown;
      vmDisplayName?: unknown;
    };

    if (body.acceptedTermsRevision !== ORDER_TERMS_REVISION) {
      return NextResponse.json(
        {
          error:
            "You must accept the current Terms of Service before creating an order.",
        },
        { status: 400 }
      );
    }

    const serviceId =
      typeof body.serviceId === "string" ? body.serviceId.trim() : "";
    const paypalSubscriptionId =
      typeof body.paypalSubscriptionId === "string"
        ? body.paypalSubscriptionId.trim()
        : "";
    if (!serviceId || !paypalSubscriptionId) {
      return NextResponse.json(
        { error: "Missing serviceId or paypalSubscriptionId" },
        { status: 400 }
      );
    }

    // Optional caller-supplied VM name.
    let resolvedVmDisplayName: string | undefined;
    if (
      typeof body.vmDisplayName === "string" &&
      body.vmDisplayName.trim().length > 0
    ) {
      const v = validateVmDisplayName(body.vmDisplayName);
      if (!v.ok) {
        return NextResponse.json({ error: v.error }, { status: 400 });
      }
      resolvedVmDisplayName = v.name;
    }

    const service = await getService(serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }
    if (service.testing) {
      if (!auth.isAdmin) {
        return NextResponse.json({ error: "Service not found" }, { status: 404 });
      }
    } else if (!service.active) {
      return NextResponse.json(
        { error: "Service is not available" },
        { status: 400 }
      );
    }

    // Verify the PayPal subscription: it must be for this user's approved plan
    // and in a state where PayPal will actually charge (APPROVED, ACTIVE).
    let subscription;
    try {
      subscription = await getPaypalSubscription(paypalSubscriptionId);
    } catch (e) {
      console.error("[paypal capture] getPaypalSubscription failed", e);
      return NextResponse.json(
        {
          error:
            "Could not verify PayPal subscription. Please try again or contact support if you were charged.",
        },
        { status: 502 }
      );
    }
    const okStatus =
      subscription.status === "APPROVED" || subscription.status === "ACTIVE";
    if (!okStatus) {
      return NextResponse.json(
        {
          error: `PayPal subscription is not active (status: ${subscription.status})`,
        },
        { status: 400 }
      );
    }

    // Verify the buyer isn't sneaking a stolen subscription past us: require
    // the subscription's `custom_id` (which we set at create time on the
    // client) to include the caller's DeSo public key.
    if (
      typeof subscription.custom_id === "string" &&
      subscription.custom_id.length > 0 &&
      !subscription.custom_id.includes(publicKey)
    ) {
      // If a subscription is bound to a different user, cancel it (best-effort)
      // so it doesn't keep billing them for a VPS they can't access.
      await cancelPaypalSubscription(
        paypalSubscriptionId,
        "Bound to different DeSoHosting user"
      ).catch(() => undefined);
      return NextResponse.json(
        { error: "This PayPal subscription belongs to a different account." },
        { status: 403 }
      );
    }

    // Compute expected monthly total (base + surcharge) so we can snapshot it
    // onto the Order for admin/reporting.
    const normalizedExtra = normalizeTieredExtraDisksGb(body.extraDisksGb);
    const rate = await getUsdPerDeso();
    const baseUsdCents = monthlyTotalUsdCentsForOrder(
      service,
      rate.usdPerDeso,
      normalizedExtra
    );
    const surchargeCfg = paypalSurchargeConfig();
    const paypalMonthlyUsdCents =
      baseUsdCents + paypalSurchargeCents(baseUsdCents, surchargeCfg);

    // Reject if the subscription is not on a plan we know about for this
    // service snapshot — protects us against buyers approving a plan for a
    // different (cheaper) SKU.
    const expected = await ensurePaypalPlanForService(
      service,
      paypalMonthlyUsdCents
    );
    if (subscription.plan_id !== expected.paypalPlanId) {
      await cancelPaypalSubscription(
        paypalSubscriptionId,
        "Plan mismatch during checkout"
      ).catch(() => undefined);
      return NextResponse.json(
        {
          error:
            "PayPal subscription is on a different plan than the current price. Please retry checkout.",
        },
        { status: 409 }
      );
    }

    // Resolve OS image / clone target — same code path as DeSo checkout.
    const hosted = await readActiveOsTemplateProfiles();
    const profilesList = effectiveTemplatesForCheckout(service, hosted);
    const cloneExtras: {
      cloneTemplateVmid?: number;
      cloneImageProfileId?: string;
    } = {};
    let cloneTemplatePrefer: number | null = null;
    if (profilesList.length > 0) {
      const clonePick = resolveCloneChoiceFromBody(
        profilesList,
        {
          imageProfileId: body.imageProfileId,
          templateVmid: body.templateVmid,
        },
        { allowDefaultFallback: true }
      );
      if (!clonePick) {
        return NextResponse.json(
          { error: "Invalid operating system template for this host." },
          { status: 400 }
        );
      }
      cloneExtras.cloneTemplateVmid = clonePick.templateVmid;
      cloneExtras.cloneImageProfileId = clonePick.profile.id;
      cloneTemplatePrefer = clonePick.templateVmid;
    }

    const target = await resolveProvisionTarget(
      service,
      cloneTemplatePrefer ?? null,
      profilesList
    );

    let desoHandle: string | undefined =
      typeof body.desoUsername === "string" && body.desoUsername.trim()
        ? body.desoUsername.trim()
        : undefined;
    if (!desoHandle) {
      desoHandle = await fetchDesoUsernameByPublicKey(publicKey);
    }
    const credentials = vmCredentialsFromDesoLogin(publicKey, desoHandle);

    // SSH access — same three modes as DeSo checkout.
    const sshMode = parseSshAuthFromBody(body.sshAccess);
    let cloudInitSshKeys: string | undefined;
    let generatedSshPrivateKey: string | undefined;
    let generatedSshPublicKeyLine: string | undefined;
    if (sshMode === "paste") {
      const pasted = typeof body.sshPublicKey === "string" ? body.sshPublicKey : "";
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
      cloudInitSshKeys !== undefined ? { cloudInitSshKeys } : {};
    const orderResponseExtras =
      generatedSshPrivateKey !== undefined &&
      generatedSshPublicKeyLine !== undefined
        ? { generatedSshPrivateKey, generatedSshPublicKeyLine }
        : {};
    const vmNameExtras = resolvedVmDisplayName
      ? { vmDisplayName: resolvedVmDisplayName }
      : {};

    const paypalFields = {
      paymentProvider: "paypal" as const,
      paypalSubscriptionId,
      paypalPlanId: expected.paypalPlanId,
      paypalMonthlyUsdCents,
      ...(subscription.subscriber?.email_address
        ? { paypalPayerEmail: subscription.subscriber.email_address }
        : {}),
    };

    if (target) {
      const order = await addOrder({
        userId: publicKey,
        serviceId,
        vmid: 0,
        node: target.node,
        status: "provisioning",
        ...credentials,
        ...(normalizedExtra.length > 0
          ? { extraDisksGb: normalizedExtra }
          : {}),
        ...orderSshFields,
        ...(Object.keys(cloneExtras).length > 0 ? cloneExtras : {}),
        ...vmNameExtras,
        ...paypalFields,
      });

      after(() => {
        finalizeProvision(order.id).catch((e) =>
          console.error("finalizeProvision (paypal):", e)
        );
      });

      return NextResponse.json({
        order,
        provisioning: true,
        message:
          "PayPal subscription approved. Provisioning started — you'll see updates on your dashboard shortly.",
        ...orderResponseExtras,
      });
    }

    const pendingNode =
      service.proxmoxNode?.trim() ||
      (await getProxmoxHostConfig()).effectiveDefaultCloneNode ||
      "pending";

    const order = await addOrder({
      userId: publicKey,
      serviceId,
      vmid: 0,
      node: pendingNode,
      status: "pending",
      ...credentials,
      ...(normalizedExtra.length > 0
        ? { extraDisksGb: normalizedExtra }
        : {}),
      ...orderSshFields,
      ...vmNameExtras,
      ...paypalFields,
    });

    return NextResponse.json({
      order,
      message: "Order created. Admin will provision your VPS.",
      ...orderResponseExtras,
    });
  } catch (err) {
    console.error("[paypal capture]", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "PayPal checkout failed",
      },
      { status: 500 }
    );
  }
}
