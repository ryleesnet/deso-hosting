/**
 * DeSo/USD rate from your DeSo node (`/api/v0/get-exchange-rate`).
 * Uses USDCentsPerDeSoExchangeRate → USD per 1 DESO = cents / 100.
 */

const CACHE_TTL_MS = 60_000;
let cache: { usdPerDeso: number; source: string; at: number } | null = null;

export function getDeSoNodeBaseUrl(): string {
  const raw =
    process.env.DESO_NODE_URI?.trim() ||
    process.env.NEXT_PUBLIC_DESO_NODE_URI?.trim() ||
    "https://node.deso.org";
  return raw.replace(/\/$/, "");
}

export type UsdPerDesoRate = {
  /** How many US dollars one DESO is worth. */
  usdPerDeso: number;
  source: "env" | "node";
};

type NodeExchangeRateResponse = {
  USDCentsPerDeSoExchangeRate?: number;
  USDCentsPerBitCloutExchangeRate?: number;
};

export async function getUsdPerDeso(): Promise<UsdPerDesoRate> {
  const envRaw = process.env.DESO_USD_PRICE?.trim();
  if (envRaw) {
    const n = parseFloat(envRaw);
    if (Number.isFinite(n) && n > 0) {
      return { usdPerDeso: n, source: "env" };
    }
  }

  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { usdPerDeso: cache.usdPerDeso, source: cache.source as "node" };
  }

  const base = getDeSoNodeBaseUrl();
  const url = `${base}/api/v0/get-exchange-rate`;
  const res = await fetch(url, {
    method: "GET",
    next: { revalidate: 60 },
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Could not load DeSo/USD rate from ${base} (HTTP ${res.status}). Set DESO_USD_PRICE in .env (USD per 1 DESO), or check DESO_NODE_URI.`
    );
  }

  const json = (await res.json()) as NodeExchangeRateResponse;
  const cents =
    json.USDCentsPerDeSoExchangeRate ?? json.USDCentsPerBitCloutExchangeRate;
  if (!Number.isFinite(cents) || cents == null || cents <= 0) {
    throw new Error(
      `DeSo node returned no USDCentsPerDeSoExchangeRate. Set DESO_USD_PRICE in .env (USD per 1 DESO).`
    );
  }

  const usdPerDeso = cents / 100;
  cache = { usdPerDeso, source: "node", at: Date.now() };
  return { usdPerDeso, source: "node" };
}
