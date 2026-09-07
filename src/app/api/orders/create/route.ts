import { NextRequest, NextResponse, after } from "next/server";
import {
  getService,
  addOrder,
  readActiveOsTemplateProfiles,
} from "@/lib/db";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";
import { vmCredentialsFromDesoLogin } from "@/lib/vm-credentials";
import { normalizeTieredExtraDisksGb } from "@/lib/extra-disks";
import {
  parseSshAuthFromBody,
  normalizeAndValidateSshPublicKeysInput,
  generateEd25519SshKeypairForVm,
  sshKeyCommentForDesoUser,
} from "@/lib/ssh-keys";
import {
  finalizeOrderProvision,
  resolveProvisionTarget,
} from "@/lib/order-provision";
import {
  resolveCloneChoiceFromBody,
  effectiveTemplatesForCheckout,
} from "@/lib/image-profiles";
import { requireUser } from "@/lib/api-auth";
import { ORDER_TERMS_REVISION } from "@/lib/terms-revision";
import { getProxmoxHostConfig } from "@/lib/proxmox-host-config";
import { validateVmDisplayName } from "@/lib/vm-name";

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
      imageProfileId,
      templateVmid,
      vmDisplayName,
    } = body as {
      serviceId?: string;
      desoUsername?: string;
      extraDisksGb?: unknown;
      sshAccess?: unknown;
      sshPublicKey?: unknown;
      acceptedTermsRevision?: unknown;
      imageProfileId?: unknown;
      templateVmid?: unknown;
      vmDisplayName?: unknown;
    };

    // Optional caller-supplied VM name — validate up-front so the eventual
    // Proxmox clone can't fail on a bad name deep inside finalizeProvision.
    // Empty string / undefined means "auto-generate from orderId".
    let resolvedVmDisplayName: string | undefined;
    if (
      typeof vmDisplayName === "string" &&
      vmDisplayName.trim().length > 0
    ) {
      const v = validateVmDisplayName(vmDisplayName);
      if (!v.ok) {
        return NextResponse.json({ error: v.error }, { status: 400 });
      }
      resolvedVmDisplayName = v.name;
    }

    if (acceptedTermsRevision !== ORDER_TERMS_REVISION) {
      return NextResponse.json(
        {
          error:
            "You must accept the current Terms of Service before creating an order.",
        },
        { status: 400 }
      );
    }

    const normalizedExtra = normalizeTieredExtraDisksGb(extraDisksGb);
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
    // Ordering rules mirror the catalog:
    //   - non-admins can only order `active && !testing` plans (testing plans
    //     404 to avoid leaking existence).
    //   - admins can order `active || testing`. The `testing` flag is itself
    //     an admin-only visibility gate, so a testing plan does NOT need to
    //     be active — a $0.01 smoke-test SKU is typically inactive+testing.
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

    const hosted = await readActiveOsTemplateProfiles();
    const profilesList = effectiveTemplatesForCheckout(service, hosted);
    const cloneExtras: {
      cloneImageProfileId?: string;
    } = {};
    if (profilesList.length > 0) {
      const clonePick = resolveCloneChoiceFromBody(
        profilesList,
        { imageProfileId, templateVmid },
        { allowDefaultFallback: true }
      );
      if (!clonePick) {
        return NextResponse.json(
          { error: "Invalid operating system image for this host." },
          { status: 400 }
        );
      }
      cloneExtras.cloneImageProfileId = clonePick.profile.id;
    }

    const target = await resolveProvisionTarget(service, profilesList);

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

    const vmNameExtras = resolvedVmDisplayName
      ? { vmDisplayName: resolvedVmDisplayName }
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
        ...(Object.keys(cloneExtras).length > 0 ? cloneExtras : {}),
        ...vmNameExtras,
      });

      after(() => {
        finalizeOrderProvision(order.id).catch((e) =>
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
      ...(normalizedExtra.length > 0 ? { extraDisksGb: normalizedExtra } : {}),
      ...orderSshFields,
      ...vmNameExtras,
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
