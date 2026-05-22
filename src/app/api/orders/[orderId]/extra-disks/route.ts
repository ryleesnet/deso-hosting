import { NextRequest, NextResponse, after } from "next/server";
import { getOrder, updateOrder } from "@/lib/db";
import {
  performExtraDiskAdd,
  performExtraDiskRemove,
} from "@/lib/order-extra-disks";
import { provisionErrorMessage } from "@/lib/order-provision";
import { isAllowedExtraDiskTierGb } from "@/lib/extra-disks";
import { requireUser } from "@/lib/api-auth";

type Body =
  | { action: "add"; sizeGb?: unknown }
  | { action: "remove"; diskIndex?: unknown };

/**
 * Add or remove extra data volumes (matches `order.extraDisksGb`). Guest is stopped during the
 * operation. Runs in `after()` like plan changes to avoid HTTP timeouts.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const auth = await requireUser(req);
    if (!auth.ok) return auth.response;

    const { orderId } = await params;
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json(
        { error: "Expected JSON body with action + parameters" },
        { status: 400 }
      );
    }

    if (body.action !== "add" && body.action !== "remove") {
      return NextResponse.json(
        { error: "action must be \"add\" or \"remove\"" },
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
        {
          error:
            "Extra disks can only be changed for an active VPS. Renew first if suspended.",
        },
        { status: 400 }
      );
    }

    if (order.adjustingPlan) {
      return NextResponse.json(
        { error: "Finish the current plan change before changing disks." },
        { status: 409 }
      );
    }

    if (order.hardwareMaintenance) {
      return NextResponse.json(
        { error: "A disk or hardware operation is already running for this VPS." },
        { status: 409 }
      );
    }

    if (
      body.action === "add" &&
      typeof body.sizeGb !== "number" &&
      typeof body.sizeGb !== "string"
    ) {
      return NextResponse.json(
        { error: "sizeGb is required when action is \"add\"" },
        { status: 400 }
      );
    }

    if (
      body.action === "remove" &&
      (typeof body.diskIndex !== "number" || !Number.isInteger(body.diskIndex))
    ) {
      return NextResponse.json(
        { error: "diskIndex (integer) is required when action is \"remove\"" },
        { status: 400 }
      );
    }

    let validatedAddGb: number | null = null;
    if (body.action === "add") {
      const raw = body.sizeGb;
      const n =
        typeof raw === "number" && Number.isFinite(raw)
          ? raw
          : parseInt(String(raw).trim(), 10);
      const gb = Math.floor(n);
      if (!Number.isFinite(n) || !isAllowedExtraDiskTierGb(gb)) {
        return NextResponse.json(
          {
            error:
              "sizeGb must be one of the allowed tiers: 100 GB, 200 GB, 500 GB, 1 TB, or 2 TB.",
          },
          { status: 400 }
        );
      }
      validatedAddGb = gb;
    }

    await updateOrder(orderId, {
      hardwareMaintenance: true,
      provisionError: "",
    });

    const oid = orderId;
    const isAdd = body.action === "add";
    const addGb = isAdd ? validatedAddGb : null;
    const removeIdx =
      body.action === "remove" ? (body as { diskIndex: number }).diskIndex : -1;

    after(() => {
      void (async () => {
        try {
          if (isAdd && addGb != null) await performExtraDiskAdd(oid, addGb);
          else await performExtraDiskRemove(oid, removeIdx);
        } catch (err) {
          const msg = provisionErrorMessage(err);
          console.error(`[orders/${oid}/extra-disks]`, err);
          await updateOrder(oid, { provisionError: msg });
        } finally {
          await updateOrder(oid, { hardwareMaintenance: false });
        }
      })();
    });

    return NextResponse.json({
      success: true,
      message:
        body.action === "add"
          ? "Adding disk — the VPS will shut down briefly. Billing updates when finished."
          : "Removing disk — the VPS will shut down briefly and all data on that volume will be discarded.",
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Failed to start disk operation" },
      { status: 500 }
    );
  }
}
