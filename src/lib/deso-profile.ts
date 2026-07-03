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
  const map = await fetchDesoUsernamesByPublicKeys([publicKeyBase58Check]);
  return map.get(publicKeyBase58Check.trim());
}

function normalizeDesoUsername(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().replace(/^@/, "");
  return t || undefined;
}

/** Batch profile Username lookup for admin lists (one node request per chunk). */
export async function fetchDesoUsernamesByPublicKeys(
  publicKeys: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(publicKeys.map((k) => k.trim()).filter(Boolean))];
  const result = new Map<string, string>();
  if (!unique.length) return result;

  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${nodeUri}/api/v0/get-users-stateless`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ PublicKeysBase58Check: chunk }),
        cache: "no-store",
      });
      if (!res.ok) continue;

      const data = (await res.json()) as {
        UserList?: Array<{
          PublicKeyBase58Check?: string;
          ProfileEntryResponse?: { Username?: string };
        }>;
      };

      const list = data.UserList ?? [];
      for (let j = 0; j < list.length; j += 1) {
        const row = list[j];
        const pk =
          typeof row?.PublicKeyBase58Check === "string"
            ? row.PublicKeyBase58Check.trim()
            : chunk[j]?.trim();
        if (!pk) continue;
        const username = normalizeDesoUsername(
          row?.ProfileEntryResponse?.Username
        );
        if (username) result.set(pk, username);
      }
    } catch {
      /* skip chunk */
    }
  }

  return result;
}
