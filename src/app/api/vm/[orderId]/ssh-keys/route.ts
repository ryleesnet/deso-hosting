import { NextRequest, NextResponse } from "next/server";
import { getOrder, updateOrder } from "@/lib/db";
import {
  applyCloudInitSshKeysAndRegenerate,
  formatProxmoxApiError,
} from "@/lib/proxmox";
import { resolveOrderVmLocation } from "@/lib/proxmox-vm-locator";
import {
  generateEd25519SshKeypairForVm,
  normalizeAndValidateSshPublicKeysInput,
  sshKeyCommentForDesoUser,
} from "@/lib/ssh-keys";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";
import { requireUser } from "@/lib/api-auth";

type Action = "set" | "generate" | "delete";

function parseAction(raw: unknown): Action | null {
  if (raw === "set" || raw === "generate" || raw === "delete") return raw;
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    const body = await req.json().catch(() => ({}));
    const action = parseAction(body?.action);
    if (!action) {
      return NextResponse.json(
        { error: "action must be 'set', 'generate', or 'delete'" },
        { status: 400 }
      );
    }

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    if (order.userId !== auth.publicKey && !auth.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (order.status !== "active") {
      return NextResponse.json(
        { error: "SSH key updates are only available for active VPS instances" },
        { status: 400 }
      );
    }
    if (!order.node?.trim() || !order.vmid || order.vmid <= 0) {
      return NextResponse.json(
        { error: "VM is not provisioned yet" },
        { status: 400 }
      );
    }

    let nextSshKeys = "";
    let generatedPrivateKey: string | undefined;
    let generatedPublicLine: string | undefined;

    if (action === "delete") {
      nextSshKeys = "";
    } else if (action === "set") {
      const pasted =
        typeof body?.sshPublicKey === "string" ? body.sshPublicKey : "";
      const v = normalizeAndValidateSshPublicKeysInput(pasted);
      if (!v.ok) {
        return NextResponse.json({ error: v.error }, { status: 400 });
      }
      nextSshKeys = v.cloudInitSshKeys;
    } else if (action === "generate") {
      const desoUsername = await fetchDesoUsernameByPublicKey(order.userId);
      const comment = sshKeyCommentForDesoUser(desoUsername, order.userId);
      try {
        const pair = generateEd25519SshKeypairForVm(comment);
        nextSshKeys = pair.publicKeyLine;
        generatedPrivateKey = pair.privateKeyOpenssh;
        generatedPublicLine = pair.publicKeyLine;
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

    const { node } = await resolveOrderVmLocation(order);

    try {
      await applyCloudInitSshKeysAndRegenerate(
        node,
        order.vmid,
        nextSshKeys || null
      );
    } catch (err) {
      const message = formatProxmoxApiError(err);
      console.error(`[vm/${orderId}/ssh-keys] Proxmox error:`, err);
      return NextResponse.json({ error: message }, { status: 500 });
    }

    // Persist (or clear) the key on the order so the dashboard reflects current state and any
    // future re-provision / configure step uses the same key. Use "" rather than undefined so
    // forFirestore (which strips undefined) actually clears the field on delete.
    await updateOrder(orderId, { cloudInitSshKeys: nextSshKeys });

    return NextResponse.json({
      success: true,
      action,
      cloudInitSshKeys: nextSshKeys || null,
      ...(generatedPrivateKey && generatedPublicLine
        ? {
            generatedSshPrivateKey: generatedPrivateKey,
            generatedSshPublicKeyLine: generatedPublicLine,
          }
        : {}),
    });
  } catch (err) {
    console.error("[vm/ssh-keys]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "SSH key update failed" },
      { status: 500 }
    );
  }
}
