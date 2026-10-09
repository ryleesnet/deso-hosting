import { NextRequest, NextResponse } from "next/server";
import {
  filterAccountingEntries,
  listAccountingEntries,
  setAccountingEntryEntered,
} from "@/lib/accounting-books";
import { requireAdmin } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const q = req.nextUrl.searchParams.get("q") ?? "";
    const all = await listAccountingEntries();
    const result = filterAccountingEntries(all, q);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load payments";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  try {
    const body = (await req.json().catch(() => ({}))) as {
      id?: unknown;
      entered?: unknown;
    };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) {
      return NextResponse.json({ error: "Missing payment id" }, { status: 400 });
    }
    const entry = await setAccountingEntryEntered({
      id,
      entered: body.entered !== false,
      actorId: auth.publicKey,
    });
    return NextResponse.json({ entry });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update payment";
    const status = message === "Payment not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
