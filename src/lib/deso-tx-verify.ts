import { getDeSoNodeBaseUrl } from "@/lib/deso-usd-rate";
import { parseDusdcBaseUnits } from "@/lib/deso-tokens";

type TransactionInfoApiResponse = {
  Error?: string;
  Transactions?: Array<{
    TransactionType?: string;
    TransactionMetadata?: {
      TransactorPublicKeyBase58Check?: string;
      DAOCoinTransferTxindexMetadata?: {
        CreatorUsername?: string;
        CreatorPublicKeyBase58Check?: string;
        DAOCoinToTransferNanos?: string | number;
        ReceiverUsername?: string;
        ReceiverPublicKeyBase58Check?: string;
      };
    };
    Outputs?: Array<{
      PublicKeyBase58Check?: string;
      AmountNanos?: number;
    }>;
    ExtraData?: Record<string, string>;
  }>;
};

async function fetchTransactionInfo(
  transactionIdHexOrBase58: string
): Promise<
  | { ok: true; tx: NonNullable<TransactionInfoApiResponse["Transactions"]>[number] }
  | { ok: false; reason: string }
> {
  const id = transactionIdHexOrBase58.trim();
  if (!id) return { ok: false, reason: "Missing transaction id" };

  const base = getDeSoNodeBaseUrl();
  const res = await fetch(`${base}/api/v1/transaction-info`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ TransactionIDBase58Check: id }),
    cache: "no-store",
  });

  const json = (await res.json()) as TransactionInfoApiResponse;
  const err = json.Error?.trim();
  if (err || !json.Transactions?.length) {
    return {
      ok: false,
      reason:
        err ||
        "Transaction not found. If payment just submitted, wait a few seconds and try again. The node must index transactions (--txindex).",
    };
  }
  return { ok: true, tx: json.Transactions[0]! };
}

/**
 * Confirms a mined (or mempool) BASIC_TRANSFER pays at least `minAmountNanosToRecipient`
 * to `recipientPublicKeyBase58` from `senderPublicKeyBase58`.
 * Requires the DeSo node to run with **--txindex** (`/api/v1/transaction-info`).
 */
export async function verifyBasicTransferPaymentToRecipient(params: {
  transactionIdHexOrBase58: string;
  senderPublicKeyBase58: string;
  recipientPublicKeyBase58: string;
  minAmountNanosToRecipient: number;
  /** If set, `ExtraData.memo` must contain this substring. */
  memoIncludesSubstring?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const info = await fetchTransactionInfo(params.transactionIdHexOrBase58);
  if (!info.ok) return info;
  const tx = info.tx;

  if (tx.TransactionType !== "BASIC_TRANSFER") {
    return {
      ok: false,
      reason: `Expected BASIC_TRANSFER, got ${tx.TransactionType ?? "unknown"}`,
    };
  }

  const transactor =
    tx.TransactionMetadata?.TransactorPublicKeyBase58Check?.trim();
  if (transactor !== params.senderPublicKeyBase58.trim()) {
    return { ok: false, reason: "Transaction sender does not match your account" };
  }

  let toRecipient = 0;
  for (const o of tx.Outputs ?? []) {
    if (o.PublicKeyBase58Check === params.recipientPublicKeyBase58) {
      toRecipient += Number(o.AmountNanos) || 0;
    }
  }

  if (toRecipient < params.minAmountNanosToRecipient) {
    return {
      ok: false,
      reason: `Payment too low: payee received ${toRecipient} nanos, need at least ${params.minAmountNanosToRecipient}`,
    };
  }

  if (params.memoIncludesSubstring) {
    const memo = tx.ExtraData?.memo ?? "";
    if (!memo.includes(params.memoIncludesSubstring)) {
      return {
        ok: false,
        reason: "Payment memo does not match this renewal",
      };
    }
  }

  return { ok: true };
}

/**
 * Confirms a mined (or mempool) DAO_COIN_TRANSFER moves at least
 * `minAmountBaseUnits` of the specified DeSo Token (creator public key) from
 * `senderPublicKeyBase58` to `recipientPublicKeyBase58`.
 *
 * The `DAOCoinToTransferNanos` field on the DeSo indexer response can arrive
 * as either a hex string ("0x…") or a decimal string depending on node
 * version, so both are parsed via {@link parseDusdcBaseUnits}.
 */
export async function verifyDaoCoinTransferToRecipient(params: {
  transactionIdHexOrBase58: string;
  senderPublicKeyBase58: string;
  recipientPublicKeyBase58: string;
  /** Creator profile PublicKeyBase58Check of the token being transferred. */
  tokenCreatorPublicKeyBase58: string;
  /** Minimum base units the receiver must have gotten (as BigInt). */
  minAmountBaseUnits: bigint;
  /** If set, `ExtraData.memo` must contain this substring. */
  memoIncludesSubstring?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const info = await fetchTransactionInfo(params.transactionIdHexOrBase58);
  if (!info.ok) return info;
  const tx = info.tx;

  // DeSo backend labels this transaction type "DAO_COIN_TRANSFER" (the DeSo
  // Token naming hasn't propagated through the txindex output).
  if (tx.TransactionType !== "DAO_COIN_TRANSFER") {
    return {
      ok: false,
      reason: `Expected DAO_COIN_TRANSFER, got ${tx.TransactionType ?? "unknown"}`,
    };
  }

  const meta = tx.TransactionMetadata;
  const transactor = meta?.TransactorPublicKeyBase58Check?.trim();
  if (transactor !== params.senderPublicKeyBase58.trim()) {
    return { ok: false, reason: "Transaction sender does not match your account" };
  }

  const transferMeta = meta?.DAOCoinTransferTxindexMetadata;
  if (!transferMeta) {
    return {
      ok: false,
      reason: "Transaction is missing DAO coin transfer metadata",
    };
  }

  const expectedCreator = params.tokenCreatorPublicKeyBase58.trim();
  if (
    (transferMeta.CreatorPublicKeyBase58Check ?? "").trim() !== expectedCreator
  ) {
    return {
      ok: false,
      reason: `Wrong token: expected creator ${expectedCreator}, got ${transferMeta.CreatorPublicKeyBase58Check ?? "unknown"}`,
    };
  }

  const expectedReceiver = params.recipientPublicKeyBase58.trim();
  if (
    (transferMeta.ReceiverPublicKeyBase58Check ?? "").trim() !== expectedReceiver
  ) {
    return {
      ok: false,
      reason: "Token was sent to the wrong recipient",
    };
  }

  const received = parseDusdcBaseUnits(transferMeta.DAOCoinToTransferNanos);
  if (received < params.minAmountBaseUnits) {
    return {
      ok: false,
      reason: `Token payment too low: got ${received.toString()} base units, need at least ${params.minAmountBaseUnits.toString()}`,
    };
  }

  if (params.memoIncludesSubstring) {
    const memo = tx.ExtraData?.memo ?? "";
    if (!memo.includes(params.memoIncludesSubstring)) {
      return {
        ok: false,
        reason: "Payment memo does not match this renewal",
      };
    }
  }

  return { ok: true };
}
