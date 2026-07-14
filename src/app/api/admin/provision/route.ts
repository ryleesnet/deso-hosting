import { NextRequest, NextResponse } from "next/server";
import {
  getOrder,
  updateOrder,
  getService,
  getSubscriptionByOrder,
  addSubscription,
  readActiveOsTemplateProfiles,
} from "@/lib/db";
import {
  applyServiceHardwareToVM,
  cloneVM,
} from "@/lib/proxmox";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";
import { vmCredentialsFromDesoLogin } from "@/lib/vm-credentials";
import {
  allocatePublicIpForOrder,
  cloudInitNetworkForIp,
  getPublicIpNameserverParam,
  isPublicIpPoolConfigured,
} from "@/lib/public-ip-pool";
import { updatePublicIpMachineForOrder } from "@/lib/public-ip-store";
import { monthlyAmountNanosForOrder } from "@/lib/service-pricing";
import { requireAdmin } from "@/lib/api-auth";
import { effectiveTemplatesForOrder, profileByTemplateVmidInList } from "@/lib/image-profiles";
import { resolveVmDisplayName } from "@/lib/vm-name";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const { orderId, vmid, node } = await req.json();
    if (!orderId || !vmid || !node) {
      return NextResponse.json(
        { error: "Missing orderId, vmid, or node" },
        { status: 400 }
      );
    }

    const order = await getOrder(orderId);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const service = await getService(order.serviceId);
    const hosted = await readActiveOsTemplateProfiles();
    const profiles = service
      ? effectiveTemplatesForOrder(order, service, hosted)
      : [];
    const fromStored =
      typeof order.cloneTemplateVmid === "number" &&
      order.cloneTemplateVmid > 0
        ? profileByTemplateVmidInList(profiles, order.cloneTemplateVmid)
            ?.templateVmid
        : undefined;
    const templateVmid =
      fromStored ??
      profiles[0]?.templateVmid ??
      (service != null &&
      service.proxmoxTemplate != null &&
      service.proxmoxTemplate > 0
        ? service.proxmoxTemplate
        : undefined) ??
      (typeof order.cloneTemplateVmid === "number" && order.cloneTemplateVmid > 0
        ? order.cloneTemplateVmid
        : undefined);
    const templateNode = service?.proxmoxNode || node;

    let vmLoginUsername = order.vmLoginUsername;
    let vmLoginPassword = order.vmLoginPassword;
    if (!vmLoginUsername || !vmLoginPassword) {
      const desoHandle = await fetchDesoUsernameByPublicKey(order.userId);
      const generated = vmCredentialsFromDesoLogin(order.userId, desoHandle);
      vmLoginUsername = generated.vmLoginUsername;
      vmLoginPassword = generated.vmLoginPassword;
      await updateOrder(orderId, {
        vmLoginUsername,
        vmLoginPassword,
      });
    }

    let publicIpv4ToSave: string | undefined = order.publicIpv4;

    if (templateVmid && templateNode) {
      try {
        const vmName = resolveVmDisplayName(orderId, order.vmDisplayName);
        await cloneVM(templateNode, templateVmid, vmid, vmName, true);
        if (service) {
          if (await isPublicIpPoolConfigured() && !publicIpv4ToSave) {
            try {
              publicIpv4ToSave = await allocatePublicIpForOrder({
                userId: order.userId,
                orderId: order.id,
                vmid,
                node,
              });
            } catch (allocErr) {
              console.error("Public IP allocation failed:", allocErr);
              return NextResponse.json(
                {
                  error: "No free public IPv4 address in pool",
                  details:
                    allocErr instanceof Error
                      ? allocErr.message
                      : String(allocErr),
                },
                { status: 503 }
              );
            }
          }

          const ns = await getPublicIpNameserverParam();
          const network = publicIpv4ToSave
            ? await cloudInitNetworkForIp(publicIpv4ToSave)
            : undefined;
          await applyServiceHardwareToVM(
            templateNode,
            vmid,
            {
              vcpu: service.vcpu,
              ramMb: service.ram,
              storageGb: service.storage,
            },
            {
              cloudInit: {
                ciuser: vmLoginUsername,
                cipassword: vmLoginPassword,
                ...(network ? { network } : {}),
                ...(ns ? { nameserver: ns } : {}),
                ...(order.cloudInitSshKeys?.trim()
                  ? { sshkeys: order.cloudInitSshKeys.trim() }
                  : {}),
              },
              ...(order.extraDisksGb?.length
                ? { extraDisksGb: order.extraDisksGb }
                : {}),
            }
          );
        }
      } catch (cloneErr) {
        console.error("Proxmox clone failed:", cloneErr);
        return NextResponse.json(
          {
            error: "Failed to create VM in Proxmox",
            details: cloneErr instanceof Error ? cloneErr.message : "Unknown error",
          },
          { status: 500 }
        );
      }
    }

    await updateOrder(orderId, {
      vmid,
      node,
      status: "active",
      ...(publicIpv4ToSave ? { publicIpv4: publicIpv4ToSave } : {}),
    });

    if (publicIpv4ToSave) {
      await updatePublicIpMachineForOrder(orderId, vmid, node);
    }

    if (service) {
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

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Provisioning failed" },
      { status: 500 }
    );
  }
}
