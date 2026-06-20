import { NextRequest, NextResponse } from "next/server";
import {
  addFirestoreAdmin,
  canRemoveAdminPublicKey,
  listAdminDirectory,
  removeFirestoreAdmin,
  validateAdminPublicKey,
} from "@/lib/admin-access";
import { requireAdmin } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;
  try {
    const directory = await listAdminDirectory(auth.publicKey);
    return NextResponse.json(directory);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list admins";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const raw =
      typeof body.publicKey === "string" ? body.publicKey : "";
    const validated = validateAdminPublicKey(raw);
    if (typeof validated === "object") {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    await addFirestoreAdmin(validated, auth.publicKey);
    const directory = await listAdminDirectory(auth.publicKey);
    return NextResponse.json(directory);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to add admin";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => ({}));
    const raw =
      typeof body.publicKey === "string" ? body.publicKey : "";
    const validated = validateAdminPublicKey(raw);
    if (typeof validated === "object") {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }

    const allowed = await canRemoveAdminPublicKey(validated);
    if (!allowed.ok) {
      return NextResponse.json({ error: allowed.error }, { status: 400 });
    }

    await removeFirestoreAdmin(validated);
    const directory = await listAdminDirectory(auth.publicKey);
    return NextResponse.json(directory);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to remove admin";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
