import { NextRequest, NextResponse } from "next/server";
import {
  addOrder,
  addSubscription,
  getOrders,
  getService,
} from "@/lib/db";
import { monthlyAmountNanosForOrder } from "@/lib/service-pricing";
import { adminPatchPublicIpRecord } from "@/lib/public-ip-store";
import { requireAdmin } from "@/lib/api-auth";
import { parsePaymentDate } from "@/lib/renewal-months";

function parseExtraDisks(raw: unknown): number[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const nums = raw
      .map((x) => (typeof x === "number" ? x : parseInt(String(x), 10)))
      .filter((n) => Number.isFinite(n) && n > 0);
    return nums.length ? nums : undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    const nums = raw
      .split(/[,;\s]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return nums.length ? nums : undefined;
  }
  return undefined;
}

/** Reasonable minimum length for a DeSo public key payload (base58). */
function looksLikePublicKey(k: string): boolean {
  const t = k.trim();
  return t.length >= 32 && t.length <= 256;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => ({}));
    const userId =
      typeof body.userId === "string" ? body.userId.trim() : "";
    const serviceId =
      typeof body.serviceId === "string" ? body.serviceId.trim() : "";
    const node = typeof body.node === "string" ? body.node.trim() : "";
    const vmidRaw = body.vmid;
    const vmid =
      typeof vmidRaw === "number"
        ? vmidRaw
        : parseInt(String(vmidRaw ?? ""), 10);
    const lastPaymentAtRaw =
      typeof body.lastPaymentAt === "string" ? body.lastPaymentAt.trim() : "";
    const nextPaymentAtRaw =
      typeof body.nextPaymentAt === "string" ? body.nextPaymentAt.trim() : "";

    if (!userId || !looksLikePublicKey(userId)) {
      return NextResponse.json(
        { error: "Valid customer DeSo public key (userId) is required" },
        { status: 400 }
      );
    }
    if (!serviceId) {
      return NextResponse.json({ error: "serviceId is required" }, { status: 400 });
    }
    if (!node) {
      return NextResponse.json(
        { error: "Proxmox node name is required (e.g. pve01)" },
        { status: 400 }
      );
    }
    if (!Number.isFinite(vmid) || vmid <= 0) {
      return NextResponse.json(
        { error: "VMID must be a positive integer" },
        { status: 400 }
      );
    }
    if (!lastPaymentAtRaw) {
      return NextResponse.json(
        { error: "lastPaymentAt is required (ISO date or datetime)" },
        { status: 400 }
      );
    }

    const lastPaymentAt = parsePaymentDate(lastPaymentAtRaw);
    if (!lastPaymentAt) {
      return NextResponse.json(
        { error: "lastPaymentAt must be a valid date" },
        { status: 400 }
      );
    }

    let nextPaymentAt: Date;
    if (nextPaymentAtRaw) {
      const parsedNext = parsePaymentDate(nextPaymentAtRaw);
      if (!parsedNext) {
        return NextResponse.json(
          { error: "nextPaymentAt must be a valid date when provided" },
          { status: 400 }
        );
      }
      nextPaymentAt = parsedNext;
    } else {
      nextPaymentAt = new Date(lastPaymentAt);
      nextPaymentAt.setMonth(nextPaymentAt.getMonth() + 1);
    }

    if (nextPaymentAt.getTime() <= lastPaymentAt.getTime()) {
      return NextResponse.json(
        { error: "nextPaymentAt must be after lastPaymentAt" },
        { status: 400 }
      );
    }

    const service = await getService(serviceId);
    if (!service) {
      return NextResponse.json({ error: "Service not found" }, { status: 404 });
    }

    const allOrders = await getOrders();
    const conflict = allOrders.find(
      (o) =>
        o.vmid === vmid &&
        (o.node ?? "").trim() === node &&
        o.status !== "cancelled"
    );
    if (conflict) {
      return NextResponse.json(
        {
          error: `This VM (${vmid} on ${node}) is already linked to order ${conflict.id}`,
          conflictOrderId: conflict.id,
        },
        { status: 409 }
      );
    }

    const extraDisksGb = parseExtraDisks(body.extraDisksGb);
    const publicIpv4 =
      typeof body.publicIpv4 === "string" ? body.publicIpv4.trim() : "";
    const vmLoginUsername =
      typeof body.vmLoginUsername === "string"
        ? body.vmLoginUsername.trim()
        : "";
    const vmLoginPassword =
      typeof body.vmLoginPassword === "string"
        ? body.vmLoginPassword
        : "";
    const cloudInitSshKeys =
      typeof body.cloudInitSshKeys === "string"
        ? body.cloudInitSshKeys.trim()
        : "";

    const orderInput = {
      userId,
      serviceId,
      vmid,
      node,
      status: "active" as const,
      ...(publicIpv4 ? { publicIpv4 } : {}),
      ...(extraDisksGb?.length ? { extraDisksGb } : {}),
      ...(vmLoginUsername ? { vmLoginUsername } : {}),
      ...(vmLoginPassword ? { vmLoginPassword } : {}),
      ...(cloudInitSshKeys ? { cloudInitSshKeys } : {}),
      provisionError: "",
    };

    const newOrder = await addOrder(orderInput);

    const amountNanos = await monthlyAmountNanosForOrder(
      service,
      extraDisksGb
    );

    await addSubscription({
      orderId: newOrder.id,
      userId,
      lastPaymentAt: lastPaymentAt.toISOString(),
      nextPaymentAt: nextPaymentAt.toISOString(),
      amountNanos,
      status: "active",
    });

    let publicIpPoolLinked = false;
    if (publicIpv4) {
      try {
        await adminPatchPublicIpRecord({
          address: publicIpv4,
          status: "assigned",
          userId,
          orderId: newOrder.id,
          vmid,
        });
        publicIpPoolLinked = true;
      } catch {
        /* Row may not exist; order still stores publicIpv4 for display */
      }
    }

    return NextResponse.json({
      success: true,
      orderId: newOrder.id,
      subscriptionMonthlyNanos: amountNanos,
      serviceInactive: !service.active,
      publicIpPoolLinked,
    });
  } catch (err) {
    console.error("[admin/import-existing-vm]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed" },
      { status: 500 }
    );
  }
}
