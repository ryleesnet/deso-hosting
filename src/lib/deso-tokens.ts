/**
 * DeSo Token (a.k.a. DAO Coin) constants and helpers used by the payment flow.
 *
 * Docs:
 *  - https://docs.deso.org/deso-backend/construct-transactions/dao-transactions-api
 *  - https://docs.deso.org/deso-backend/api/dao-endpoints
 *
 * Note: "DAO Coins" and "DeSo Tokens" refer to the same on-chain primitive; the
 * API endpoints still use the older `dao-coin` naming.
 *
 * This file is safe to import from both server and client code — it only exports
 * plain constants and pure functions.
 */

/** Supported non-DESO payment tokens. */
export type PaymentToken = "DESO" | "DUSDC";

export const PAYMENT_TOKEN_VALUES = ["DESO", "DUSDC"] as const;

/** Parse an untrusted string into a PaymentToken (defaults to DESO). */
export function parsePaymentToken(raw: unknown): PaymentToken {
  if (typeof raw !== "string") return "DESO";
  const upper = raw.trim().toUpperCase();
  return upper === "DUSDC" ? "DUSDC" : "DESO";
}

/**
 * DUSDC (dUSDC_) is the wrapped-USDC DeSo Token most widely used across the
 * DeSo ecosystem (Openfund, Diamond, etc.). It's a USD-pegged stablecoin, so 1
 * dUSDC ≈ $1 and we can charge in cents directly without a rate lookup.
 *
 * On-chain, DeSo Tokens use 18 decimals (like ERC-20), so:
 *   1 dUSDC   = 10^18 base units
 *   1 US cent = 10^16 base units
 */
export const DUSDC = {
  symbol: "DUSDC" as const,
  displayName: "dUSDC (wrapped USDC on DeSo)",
  /** DeSo profile username of the token creator. */
  creatorUsername: "dUSDC_",
  /** DeSo profile PublicKeyBase58Check of the token creator. */
  creatorPublicKey: "BC1YLiwTN3DbkU8VmD7F7wXcRR1tFX6jDEkLyruHD2WsH3URomimxLX",
  /** Fixed decimals for all DeSo Tokens (matches ERC-20 convention). */
  decimals: 18,
} as const;

/**
 * Convert USD cents to the uint256 hex string DeSo expects for
 * `DAOCoinToTransferNanos` when transferring dUSDC ($1 = 1 dUSDC).
 *
 * Returns a "0x"-prefixed lower-case hex string.
 *
 * Example: 500 cents ($5.00) → "0x4563918244f40000" (5 × 10^18)
 */
export function usdCentsToDusdcHex(usdCents: number): string {
  const cents = BigInt(Math.max(0, Math.floor(Number(usdCents) || 0)));
  // 1 dUSDC = 10^18 base units; 1 cent = 10^16 base units.
  const baseUnits = cents * 10n ** 16n;
  return "0x" + baseUnits.toString(16);
}

/**
 * Parse a DeSo `DAOCoinToTransferNanos` hex string (or plain decimal string)
 * to a BigInt of base units. Returns 0n on malformed input.
 */
export function parseDusdcBaseUnits(raw: unknown): bigint {
  if (typeof raw !== "string") return 0n;
  const trimmed = raw.trim();
  if (!trimmed) return 0n;
  try {
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
      return BigInt(trimmed);
    }
    if (/^[0-9]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
  } catch {
    return 0n;
  }
  return 0n;
}

/** Convert dUSDC base units (BigInt) to a human-readable USD string like `$5.00`. */
export function formatDusdcAsUsd(baseUnits: bigint): string {
  if (baseUnits <= 0n) return "$0.00";
  // 1 cent = 1e16 base units. Round to the nearest cent for display.
  const cents = Number(baseUnits / 10n ** 14n) / 100; // extra 2 digits precision
  const rounded = Math.round(cents) / 100;
  return `$${rounded.toFixed(2)}`;
}

/** Short USD-shaped label for dUSDC amounts (e.g. `5.00 dUSDC`). */
export function formatDusdcAmount(usdCents: number): string {
  const dollars = Math.max(0, usdCents) / 100;
  return `${dollars.toFixed(2)} dUSDC`;
}
