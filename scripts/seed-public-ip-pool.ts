/**
 * Seed Firestore collection `public_ips` from PUBLIC_IP_POOL_CIDR (see .env).
 * Only creates missing documents; does not overwrite existing assignments.
 *
 *   npm run db:seed-public-ips
 *   npm run db:seed-public-ips -- --sync-orders
 *
 * --sync-orders  — after seeding, mark IPs as assigned for non-cancelled orders that have publicIpv4.
 */
import "dotenv/config";
import { getFirestoreDb } from "../src/lib/firebase-admin";
import { listPoolCandidateIpsFromEnv } from "../src/lib/public-ip-pool";
import { PUBLIC_IPS_COLLECTION } from "../src/lib/public-ip-store";
import { getOrders } from "../src/lib/db";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function main() {
  const syncOrders = process.argv.includes("--sync-orders");
  let ips: string[];
  try {
    ips = listPoolCandidateIpsFromEnv();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
    return;
  }

  if (ips.length === 0) {
    console.error(
      "No IPs to seed: set PUBLIC_IP_POOL_CIDR and PUBLIC_IP_GATEWAY (same as for Proxmox cloud-init)."
    );
    process.exit(1);
    return;
  }

  const db = getFirestoreDb();
  const now = new Date().toISOString();
  const col = db.collection(PUBLIC_IPS_COLLECTION);

  let batch = db.batch();
  let batchOps = 0;
  let created = 0;

  for (const group of chunk(ips, 100)) {
    const refs = group.map((ip) => col.doc(ip));
    const snaps = await db.getAll(...refs);
    for (let i = 0; i < refs.length; i++) {
      if (snaps[i].exists) continue;
      const ip = group[i]!;
      batch.set(refs[i]!, {
        address: ip,
        status: "available",
        createdAt: now,
        updatedAt: now,
      });
      created++;
      batchOps++;
      if (batchOps >= 400) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }
  }

  if (batchOps > 0) {
    await batch.commit();
  }

  console.log(`Created ${created} new available IP documents (skipped existing).`);

  if (syncOrders) {
    const orders = await getOrders();
    let synced = 0;
    for (const o of orders) {
      if (o.status === "cancelled" || !o.publicIpv4?.trim()) continue;
      const ip = o.publicIpv4.trim();
      await col.doc(ip).set(
        {
          address: ip,
          status: "assigned",
          userId: o.userId,
          orderId: o.id,
          ...(o.vmid > 0 ? { vmid: o.vmid } : {}),
          ...(o.node?.trim() ? { node: o.node.trim() } : {}),
          assignedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );
      synced++;
    }
    console.log(`Synced ${synced} assignments from non-cancelled orders with publicIpv4.`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
