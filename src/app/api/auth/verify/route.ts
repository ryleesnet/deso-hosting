import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";

/**
 * Tells the caller whether their JWT-authenticated public key is on the admin list.
 *
 * Previously this trusted whatever publicKey the body sent, which made client-side admin
 * gating equivalent to no gating at all from the server's POV. The actual admin check now
 * happens in {@link requireUser}; this endpoint just echoes the verified result back so
 * the UI can render admin links / hide them.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ publicKey: auth.publicKey, isAdmin: auth.isAdmin });
}
