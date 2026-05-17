import { NextRequest, NextResponse } from "next/server";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";

/** Public-chain lookup: resolves DeSo profile Username from a pubkey. */
export async function POST(req: NextRequest) {
  try {
    const { publicKey } = await req.json();
    if (typeof publicKey !== "string" || !publicKey.trim()) {
      return NextResponse.json(
        { error: "Missing publicKey" },
        { status: 400 }
      );
    }
    const username = await fetchDesoUsernameByPublicKey(publicKey.trim());
    return NextResponse.json({ username: username ?? null });
  } catch {
    return NextResponse.json(
      { error: "Lookup failed", username: null },
      { status: 500 }
    );
  }
}
