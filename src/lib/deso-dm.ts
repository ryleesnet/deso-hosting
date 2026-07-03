/**
 * Server-side DeSo direct messages for billing reminders.
 * Supports owner-key or derived-key signing (fees spend from the owner account).
 */

import {
  configure,
  deriveAccessGroupKeyPair,
  encryptChatMessage,
  keygen,
  publicKeyToBase58Check,
  signTx,
} from "deso-protocol";

const DEFAULT_DM_GROUP = "default-key";

function desoNodeUri(): string {
  return (
    process.env.DESO_NODE_URI?.trim() ||
    process.env.NEXT_PUBLIC_DESO_NODE_URI?.trim() ||
    "https://node.deso.org"
  ).replace(/\/$/, "");
}

function desoNetwork(): "mainnet" | "testnet" {
  const raw = process.env.DESO_NETWORK?.trim().toLowerCase();
  return raw === "testnet" ? "testnet" : "mainnet";
}

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  configure({ nodeURI: desoNodeUri(), MinFeeRateNanosPerKB: 1500 });
  configured = true;
}

function configuredOwnerPublicKey(): string {
  return (
    process.env.DESO_BILLING_DM_SENDER_OWNER_PUBLIC_KEY?.trim() ||
    process.env.DESO_BILLING_DM_SENDER_PUBLIC_KEY?.trim() ||
    ""
  );
}

function resolveMessagingPrivateKeyHex(
  ownerPublicKey: string,
  ownerSeedHex: string | null
): string | null {
  const explicit = process.env.DESO_BILLING_DM_MESSAGING_PRIVATE_KEY_HEX?.trim();
  if (explicit) return explicit;

  if (!ownerSeedHex) return null;

  const ownerKeys = keygen(ownerSeedHex);
  const derivedOwner = publicKeyToBase58Check(ownerKeys.public, {
    network: desoNetwork(),
  });
  if (derivedOwner !== ownerPublicKey) {
    return null;
  }
  return deriveAccessGroupKeyPair(ownerKeys.seedHex, DEFAULT_DM_GROUP).seedHex;
}

export type BillingDmSenderConfig = {
  /** Owner account public key — pays fees and owns the messaging access group. */
  ownerPublicKey: string;
  /** Seed used to sign transactions (owner seed or derived key seed). */
  signingSeedHex: string;
  /** When true, sign with derived-key encoding so fees spend from ownerPublicKey. */
  isDerivedKey: boolean;
  /** Derived public key when isDerivedKey is true (for error messages). */
  derivedPublicKey?: string;
  messagingPrivateKeyHex: string;
};

type ConfigResolution =
  | { ok: true; config: BillingDmSenderConfig }
  | { ok: false; error: string };

function resolveBillingDmSenderConfig(): ConfigResolution {
  const signingSeedRaw = process.env.DESO_BILLING_DM_SENDER_SEED_HEX?.trim();
  if (!signingSeedRaw) {
    return { ok: false, error: "DESO_BILLING_DM_SENDER_SEED_HEX is not configured." };
  }

  const network = desoNetwork();
  const signingKeys = keygen(signingSeedRaw);
  const signingPublicKey = publicKeyToBase58Check(signingKeys.public, { network });
  const ownerOverride = configuredOwnerPublicKey();

  if (ownerOverride && ownerOverride !== signingPublicKey) {
    const ownerSeedHex = process.env.DESO_BILLING_DM_OWNER_SEED_HEX?.trim() || null;
    const messagingPrivateKeyHex = resolveMessagingPrivateKeyHex(
      ownerOverride,
      ownerSeedHex
    );
    if (!messagingPrivateKeyHex) {
      return {
        ok: false,
        error:
          "Derived-key mode requires DESO_BILLING_DM_MESSAGING_PRIVATE_KEY_HEX or DESO_BILLING_DM_OWNER_SEED_HEX (matching DESO_BILLING_DM_SENDER_OWNER_PUBLIC_KEY) to encrypt DMs.",
      };
    }

    return {
      ok: true,
      config: {
        ownerPublicKey: ownerOverride,
        signingSeedHex: signingKeys.seedHex,
        isDerivedKey: true,
        derivedPublicKey: signingPublicKey,
        messagingPrivateKeyHex,
      },
    };
  }

  const messagingPrivateKeyHex = resolveMessagingPrivateKeyHex(
    signingPublicKey,
    signingKeys.seedHex
  );
  if (!messagingPrivateKeyHex) {
    return {
      ok: false,
      error: "Could not derive messaging private key for the billing DM sender.",
    };
  }

  return {
    ok: true,
    config: {
      ownerPublicKey: signingPublicKey,
      signingSeedHex: signingKeys.seedHex,
      isDerivedKey: false,
      messagingPrivateKeyHex,
    },
  };
}

export function getBillingDmSenderConfig(): BillingDmSenderConfig | null {
  const resolved = resolveBillingDmSenderConfig();
  if (!resolved.ok) {
    console.error(`[billing-dm] ${resolved.error}`);
    return null;
  }
  return resolved.config;
}

export function isBillingDmConfigured(): boolean {
  return resolveBillingDmSenderConfig().ok;
}

/** Human-readable reason when billing DMs cannot be sent (for admin errors). */
export function getBillingDmConfigError(): string | null {
  const resolved = resolveBillingDmSenderConfig();
  return resolved.ok ? null : resolved.error;
}

type CheckPartyAccessGroupsResponse = {
  SenderAccessGroupPublicKeyBase58Check?: string;
  SenderAccessGroupKeyName?: string;
  RecipientAccessGroupPublicKeyBase58Check?: string;
  RecipientAccessGroupKeyName?: string;
  error?: string;
};

function messagingAccessGroupPublicKey(
  messagingPrivateKeyHex: string
): string {
  const keys = keygen(messagingPrivateKeyHex);
  return publicKeyToBase58Check(keys.public, { network: desoNetwork() });
}

async function submitSignedTransaction(
  cfg: BillingDmSenderConfig,
  transactionHex: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const signedHex = await signTx(transactionHex, cfg.signingSeedHex, {
      isDerivedKey: cfg.isDerivedKey,
    });
    const res = await fetch(`${desoNodeUri()}/api/v0/submit-transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ TransactionHex: signedHex }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      return {
        ok: false,
        error: formatSubmitTransactionError(
          data.error || `submit-transaction failed (${res.status})`,
          cfg
        ),
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "submit-transaction failed",
    };
  }
}

function formatSubmitTransactionError(
  error: string,
  cfg: BillingDmSenderConfig
): string {
  if (error.includes("RuleErrorInsufficientBalance")) {
    return `Owner DeSo wallet (${cfg.ownerPublicKey}) has insufficient balance for transaction fees. Fund that account with a small amount of DESO.`;
  }
  if (error.includes("RuleErrorDerivedKeyNotAuthorized")) {
    const derived = cfg.derivedPublicKey ?? "the configured derived key";
    return `Derived key ${derived} is not authorized on owner ${cfg.ownerPublicKey}. Re-approve the derived key in DeSo Identity with NEW_MESSAGE and ACCESS_GROUP permissions.`;
  }
  if (error.includes("RuleErrorInvalidTransactionSignature")) {
    return cfg.isDerivedKey
      ? "Invalid transaction signature. Confirm DESO_BILLING_DM_SENDER_SEED_HEX is the derived key seed and DESO_BILLING_DM_SENDER_OWNER_PUBLIC_KEY is the funding owner account."
      : error;
  }
  return error;
}

async function fetchPartyAccessGroups(
  senderPublicKey: string,
  recipientPublicKey: string
): Promise<
  | { ok: true; groups: CheckPartyAccessGroupsResponse }
  | { ok: false; error: string }
> {
  try {
    const res = await fetch(`${desoNodeUri()}/api/v0/check-party-access-groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        SenderPublicKeyBase58Check: senderPublicKey,
        SenderAccessGroupKeyName: DEFAULT_DM_GROUP,
        RecipientPublicKeyBase58Check: recipientPublicKey,
        RecipientAccessGroupKeyName: DEFAULT_DM_GROUP,
      }),
    });
    const groups = (await res.json().catch(() => ({}))) as CheckPartyAccessGroupsResponse;
    if (!res.ok) {
      return {
        ok: false,
        error: groups.error || `check-party-access-groups failed (${res.status})`,
      };
    }
    return { ok: true, groups };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "check-party-access-groups failed",
    };
  }
}

/** Register the standard default-key messaging access group on-chain if missing. */
async function ensureSenderDefaultMessagingGroup(
  cfg: BillingDmSenderConfig
): Promise<{ ok: true } | { ok: false; error: string }> {
  const party = await fetchPartyAccessGroups(cfg.ownerPublicKey, cfg.ownerPublicKey);
  if (!party.ok) {
    return party;
  }
  if (party.groups.SenderAccessGroupPublicKeyBase58Check?.trim()) {
    return { ok: true };
  }

  const accessGroupPublicKey = messagingAccessGroupPublicKey(
    cfg.messagingPrivateKeyHex
  );

  let transactionHex: string | undefined;
  try {
    const res = await fetch(`${desoNodeUri()}/api/v0/create-access-group`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        AccessGroupOwnerPublicKeyBase58Check: cfg.ownerPublicKey,
        AccessGroupPublicKeyBase58Check: accessGroupPublicKey,
        AccessGroupKeyName: DEFAULT_DM_GROUP,
        MinFeeRateNanosPerKB: 1500,
        TransactionFees: [],
        ExtraData: {},
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      TransactionHex?: string;
      error?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || `create-access-group failed (${res.status})`,
      };
    }
    transactionHex = data.TransactionHex;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "create-access-group failed",
    };
  }

  if (!transactionHex?.trim()) {
    return { ok: false, error: "create-access-group returned no transaction" };
  }

  const submitted = await submitSignedTransaction(cfg, transactionHex);
  if (!submitted.ok) {
    return submitted;
  }

  return { ok: true };
}

/** Send an encrypted DM from the configured billing bot account. */
export async function sendDesoDirectMessage(
  recipientPublicKey: string,
  messagePlainText: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = getBillingDmSenderConfig();
  if (!cfg) {
    return {
      ok: false,
      error:
        getBillingDmConfigError() ??
        "DESO_BILLING_DM_SENDER_SEED_HEX is not configured",
    };
  }

  const recipient = recipientPublicKey.trim();
  if (!recipient) {
    return { ok: false, error: "Missing recipient public key" };
  }

  ensureConfigured();

  const ensured = await ensureSenderDefaultMessagingGroup(cfg);
  if (!ensured.ok) {
    return ensured;
  }

  const party = await fetchPartyAccessGroups(cfg.ownerPublicKey, recipient);
  if (!party.ok) {
    return party;
  }
  const groups = party.groups;

  const recipientGroupPk = groups.RecipientAccessGroupPublicKeyBase58Check?.trim();
  if (!recipientGroupPk) {
    return {
      ok: false,
      error: "Recipient has no default DeSo messaging group",
    };
  }

  const senderGroupPk = groups.SenderAccessGroupPublicKeyBase58Check?.trim();
  if (!senderGroupPk) {
    return {
      ok: false,
      error: `Owner ${cfg.ownerPublicKey} still has no default DeSo messaging group after setup.`,
    };
  }

  let encryptedMessageText: string;
  try {
    encryptedMessageText = await encryptChatMessage(
      cfg.messagingPrivateKeyHex,
      recipientGroupPk,
      messagePlainText
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Message encryption failed",
    };
  }

  const dmParams = {
    SenderAccessGroupOwnerPublicKeyBase58Check: cfg.ownerPublicKey,
    SenderAccessGroupPublicKeyBase58Check: senderGroupPk,
    SenderAccessGroupKeyName:
      groups.SenderAccessGroupKeyName?.trim() || DEFAULT_DM_GROUP,
    RecipientAccessGroupOwnerPublicKeyBase58Check: recipient,
    RecipientAccessGroupPublicKeyBase58Check: recipientGroupPk,
    RecipientAccessGroupKeyName:
      groups.RecipientAccessGroupKeyName ?? DEFAULT_DM_GROUP,
    EncryptedMessageText: encryptedMessageText,
    MinFeeRateNanosPerKB: 1500,
    TransactionFees: [],
    ExtraData: {},
  };

  let transactionHex: string | undefined;
  try {
    const res = await fetch(`${desoNodeUri()}/api/v0/send-dm-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dmParams),
    });
    const data = (await res.json().catch(() => ({}))) as {
      TransactionHex?: string;
      error?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.error || `send-dm-message failed (${res.status})`,
      };
    }
    transactionHex = data.TransactionHex;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "send-dm-message failed",
    };
  }

  if (!transactionHex?.trim()) {
    return { ok: false, error: "send-dm-message returned no transaction" };
  }

  const submitted = await submitSignedTransaction(cfg, transactionHex);
  if (!submitted.ok) {
    return submitted;
  }

  return { ok: true };
}
