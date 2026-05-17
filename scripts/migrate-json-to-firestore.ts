/**
 * One-time import of legacy ./data/*.json into Firestore.
 * Run from project root after configuring Firebase in `.env`:
 *   npx tsx scripts/migrate-json-to-firestore.ts
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import type { Firestore } from "firebase-admin/firestore";
import { getFirestoreDb } from "../src/lib/firebase-admin";

const DATA_DIR = path.join(process.cwd(), "data");

const COLLECTIONS = [
  { file: "services.json", collection: "services" },
  { file: "orders.json", collection: "orders" },
  { file: "subscriptions.json", collection: "subscriptions" },
] as const;

async function migrateCollection(
  db: Firestore,
  collection: string,
  items: Record<string, unknown>[]
) {
  let batch = db.batch();
  let opCount = 0;

  for (const item of items) {
    const id = item.id;
    if (typeof id !== "string" || !id) {
      console.warn("Skipping record without string id:", item);
      continue;
    }
    const ref = db.collection(collection).doc(id);
    batch.set(ref, JSON.parse(JSON.stringify(item)));
    opCount++;
    if (opCount >= 400) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    await batch.commit();
  }
}

async function main() {
  const db = getFirestoreDb();

  for (const { file, collection } of COLLECTIONS) {
    const fp = path.join(DATA_DIR, file);
    if (!fs.existsSync(fp)) {
      console.warn(`Skipping missing ${file}`);
      continue;
    }
    const raw = fs.readFileSync(fp, "utf-8");
    const items = JSON.parse(raw) as Record<string, unknown>[];
    if (!Array.isArray(items)) {
      console.warn(`${file} is not a JSON array, skipping`);
      continue;
    }
    console.log(`Migrating ${items.length} documents → ${collection}`);
    await migrateCollection(db, collection, items);
  }

  console.log("Migration finished.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
