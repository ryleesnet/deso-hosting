/**
 * Server-side DeSo profile lookups (ordering / provisioning).
 * Uses the same node as the frontend when unset.
 */

const nodeUri = (
  process.env.DESO_NODE_URI ||
  process.env.NEXT_PUBLIC_DESO_NODE_URI ||
  "https://node.deso.org"
).replace(/\/$/, "");

/** Canonical DeSo Username for a pubkey (matches ProfileEntryResponse.Username). */
export async function fetchDesoUsernameByPublicKey(
  publicKeyBase58Check: string
): Promise<string | undefined> {
  if (!publicKeyBase58Check.trim()) return undefined;

  try {
    const res = await fetch(`${nodeUri}/api/v0/get-users-stateless`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        PublicKeysBase58Check: [publicKeyBase58Check.trim()],
      }),
      cache: "no-store",
    });

    if (!res.ok) return undefined;

    const data = (await res.json()) as {
      UserList?: Array<{ ProfileEntryResponse?: { Username?: string } }>;
    };

    const raw = data.UserList?.[0]?.ProfileEntryResponse?.Username;
    if (typeof raw !== "string") return undefined;

    const t = raw.trim().replace(/^@/, "");
    return t || undefined;
  } catch {
    return undefined;
  }
}
