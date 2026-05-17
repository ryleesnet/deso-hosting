import { getDeSoNodeBaseUrl } from "@/lib/deso-usd-rate";

type TransactionInfoApiResponse = {
  Error?: string;
  Transactions?: Array<{
    TransactionType?: string;
    TransactionMetadata?: {
      TransactorPublicKeyBase58Check?: string;
    };
    Outputs?: Array<{
      PublicKeyBase58Check?: string;
      AmountNanos?: number;
    }>;
    ExtraData?: Record<string, string>;
  }>;
};

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
  const id = params.transactionIdHexOrBase58.trim();
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

  const tx = json.Transactions[0]!;
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
