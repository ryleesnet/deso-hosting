/**
 * Post a received hosting payment to Akaunting as a paid sales invoice.
 *
 * Akaunting's REST API authenticates with HTTP Basic (admin email + password).
 * Some installs instead issue a bearer token; set `AKAUNTING_API_TOKEN` for
 * that. When neither is set, posting is skipped so local dev keeps working.
 *
 * Failures are logged and never thrown — a books outage must not fail checkout.
 */

import { getFirestoreDb } from "@/lib/firebase-admin";
import { logApp, logError, logWarn } from "@/lib/app-log";
import { fetchDesoUsernameByPublicKey } from "@/lib/deso-profile";

const COL_PAYMENTS = "akaunting_payments";
const COL_CONTACTS = "akaunting_contacts";
const CLAIM_MS = 90_000;

export type AkauntingRail = "deso" | "dusdc" | "paypal" | "manual";

export interface AkauntingPaymentLine {
  /** Item name shown on the invoice (plan name). */
  name: string;
  description?: string;
  /** Units billed (usually the number of months). */
  quantity: number;
  /** Price of one unit, in USD cents. */
  unitUsdCents: number;
}

export interface AkauntingReceivedPayment {
  /**
   * Stable id for this payment (tx hash, PayPal sale id, or order id).
   * Retries with the same reference do not create a second invoice.
   */
  reference: string;
  /** ISO timestamp when the money was received. */
  paidAt: string;
  rail: AkauntingRail;
  /** DeSo public key of the customer. Also stored as the Akaunting contact reference. */
  userId: string;
  customerEmail?: string;
  lines: AkauntingPaymentLine[];
}

interface PaymentRecord {
  reference: string;
  documentId?: number;
  transactionId?: number;
  documentNumber?: string;
  settled?: boolean;
  claimedAt?: string;
  postedAt?: string;
  error?: string;
}

interface ContactRecord {
  contactId: number;
  name: string;
}

let booksCache: { accountId: number; categoryId: number } | null = null;

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function baseUrl(): string {
  let url = envTrim("AKAUNTING_BASE_URL").replace(/\/$/, "");
  if (!url) return "";
  if (!/\/api$/i.test(url)) url += "/api";
  return url;
}

function companyId(): string {
  const raw = envTrim("AKAUNTING_COMPANY_ID");
  return raw || "1";
}

function currencyCode(): string {
  return (envTrim("AKAUNTING_CURRENCY") || "USD").toUpperCase();
}

function authHeader(): string | null {
  const email = envTrim("AKAUNTING_EMAIL");
  const password = envTrim("AKAUNTING_PASSWORD");
  const token = envTrim("AKAUNTING_API_TOKEN");
  if (email && password) {
    return "Basic " + Buffer.from(`${email}:${password}`).toString("base64");
  }
  if (email && token) {
    return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
  }
  if (token) return `Bearer ${token}`;
  return null;
}

export function akauntingIsConfigured(): boolean {
  return Boolean(baseUrl() && authHeader());
}

function skipUnconfiguredAkaunting(reference: string, userId: string): boolean {
  if (akauntingIsConfigured()) return false;
  if (
    envTrim("AKAUNTING_API_TOKEN") ||
    envTrim("AKAUNTING_EMAIL") ||
    envTrim("AKAUNTING_PASSWORD")
  ) {
    logWarn(
      "payment",
      `Akaunting post skipped for ${reference}: set AKAUNTING_BASE_URL to your Akaunting site`,
      undefined,
      { userId }
    );
  }
  return true;
}

function paymentMethod(rail: AkauntingRail): string {
  const specific = envTrim(`AKAUNTING_PAYMENT_METHOD_${rail.toUpperCase()}`);
  if (specific) return specific;
  return envTrim("AKAUNTING_PAYMENT_METHOD") || "offline-payments.bank_transfer.2";
}

function safeDocId(reference: string): string {
  const clean = reference.trim().replace(/[/\s]/g, "_").slice(0, 700);
  return clean || "unknown";
}

function documentNumber(reference: string): string {
  const clean = reference.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  return `DH${clean || "payment"}`;
}

function akauntingTimestamp(iso: string): string {
  const parsed = new Date(iso);
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function dollars(cents: number): number {
  return Math.round(Math.max(0, cents)) / 100;
}

/**
 * Akaunting customer name: DeSo username when the profile has one, otherwise
 * the full public key. The public key is always the contact reference.
 */
async function akauntingCustomerName(
  publicKey: string
): Promise<{ name: string; hasUsername: boolean }> {
  const key = publicKey.trim();
  const username = await fetchDesoUsernameByPublicKey(key).catch(() => undefined);
  const handle = username?.trim().replace(/^@/, "") ?? "";
  if (handle) return { name: handle.slice(0, 255), hasUsername: true };
  return { name: key.slice(0, 255), hasUsername: false };
}

function validEmail(raw: string | undefined): string | undefined {
  const email = raw?.trim() ?? "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  return email.slice(0, 255);
}

function resourceId(json: unknown): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  const body = json as { id?: unknown; data?: { id?: unknown } };
  const id = body.data?.id ?? body.id;
  const n = typeof id === "number" ? id : typeof id === "string" ? Number(id) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function resourceList(json: unknown): Array<Record<string, unknown>> {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

function errorText(json: unknown, fallback: string): string {
  if (typeof json === "string" && json.trim()) return json.slice(0, 500);
  if (!json || typeof json !== "object") return fallback;
  const body = json as { message?: unknown; errors?: unknown };
  const message = typeof body.message === "string" ? body.message : fallback;
  if (!body.errors || typeof body.errors !== "object") return message;
  const details = Object.entries(body.errors as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("; ");
  return details ? `${message} (${details})` : message;
}

async function akauntingRequest(
  path: string,
  init?: { method?: string; body?: unknown; search?: string }
): Promise<unknown> {
  const root = baseUrl();
  const auth = authHeader();
  if (!root || !auth) throw new Error("Akaunting is not configured");
  const url = new URL(path.replace(/^\//, ""), `${root}/`);
  url.searchParams.set("company_id", companyId());
  if (init?.search) url.searchParams.set("search", init.search);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: auth,
    "X-Company": companyId(),
  };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = text;
    }
  }
  if (!res.ok) {
    throw new Error(
      `Akaunting ${res.status} ${init?.method ?? "GET"} ${path}: ${errorText(json, res.statusText)}`
    );
  }
  return json;
}

function enabledRow(row: Record<string, unknown>): boolean {
  const enabled = row.enabled;
  return enabled === true || enabled === 1 || enabled === "1";
}

async function resolveBooks(): Promise<{ accountId: number; categoryId: number }> {
  const accountEnv = Number(envTrim("AKAUNTING_ACCOUNT_ID"));
  const categoryEnv = Number(envTrim("AKAUNTING_CATEGORY_ID"));
  const accountOverride = Number.isFinite(accountEnv) && accountEnv > 0 ? accountEnv : 0;
  const categoryOverride =
    Number.isFinite(categoryEnv) && categoryEnv > 0 ? categoryEnv : 0;
  if (accountOverride && categoryOverride) {
    return { accountId: accountOverride, categoryId: categoryOverride };
  }
  if (
    booksCache &&
    (!accountOverride || booksCache.accountId === accountOverride) &&
    (!categoryOverride || booksCache.categoryId === categoryOverride)
  ) {
    return {
      accountId: accountOverride || booksCache.accountId,
      categoryId: categoryOverride || booksCache.categoryId,
    };
  }

  let accountId = accountOverride;
  if (!accountId) {
    const accounts = resourceList(await akauntingRequest("accounts"));
    const currency = currencyCode();
    const match =
      accounts.find(
        (row) => enabledRow(row) && String(row.currency_code ?? "").toUpperCase() === currency
      ) ??
      accounts.find((row) => enabledRow(row)) ??
      accounts[0];
    accountId = typeof match?.id === "number" ? match.id : Number(match?.id);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      throw new Error(
        "Akaunting has no enabled bank account. Set AKAUNTING_ACCOUNT_ID."
      );
    }
  }

  let categoryId = categoryOverride;
  if (!categoryId) {
    const categories = resourceList(
      await akauntingRequest("categories", { search: "type:income" })
    );
    const match = categories.find((row) => enabledRow(row)) ?? categories[0];
    categoryId = typeof match?.id === "number" ? match.id : Number(match?.id);
    if (!Number.isFinite(categoryId) || categoryId <= 0) {
      throw new Error(
        "Akaunting has no income category. Set AKAUNTING_CATEGORY_ID."
      );
    }
  }

  booksCache = { accountId, categoryId };
  return booksCache;
}

async function syncContactName(
  contactId: number,
  name: string,
  userId: string
): Promise<void> {
  try {
    await akauntingRequest(`contacts/${contactId}`, {
      method: "PATCH",
      body: {
        type: "customer",
        name,
        currency_code: currencyCode(),
        enabled: 1,
        reference: userId,
      },
    });
  } catch (err) {
    logError("payment", `Akaunting contact rename failed for ${userId}`, err, {
      userId,
    });
  }
}

async function contactFor(
  input: AkauntingReceivedPayment
): Promise<{ contactId: number; name: string }> {
  const userId = input.userId.trim();
  const resolved = await akauntingCustomerName(userId);
  const wantedName = resolved.name;
  const db = getFirestoreDb();
  const ref = db.collection(COL_CONTACTS).doc(safeDocId(userId));
  const existing = await ref.get();
  if (existing.exists) {
    const saved = existing.data() as ContactRecord | undefined;
    const id = Number(saved?.contactId);
    if (Number.isFinite(id) && id > 0) {
      const savedName = saved?.name ?? "";
      const shouldRename =
        resolved.hasUsername ||
        !savedName ||
        savedName === userId ||
        savedName.startsWith("DeSo ");
      const name = shouldRename ? wantedName : savedName;
      if (savedName !== name) {
        await syncContactName(id, name, userId);
        await ref.set({ contactId: id, name });
      }
      return { contactId: id, name };
    }
  }

  const email = validEmail(input.customerEmail);
  try {
    const listed = resourceList(
      await akauntingRequest("contacts", {
        search: `type:customer reference:${userId}`,
      })
    );
    const found = listed.find((row) => String(row.reference ?? "") === userId);
    const foundId = typeof found?.id === "number" ? found.id : Number(found?.id);
    if (Number.isFinite(foundId) && foundId > 0) {
      const foundName = String(found?.name ?? "");
      const shouldRename =
        resolved.hasUsername ||
        !foundName ||
        foundName === userId ||
        foundName.startsWith("DeSo ");
      const name = shouldRename ? wantedName : foundName;
      if (foundName !== name) {
        await syncContactName(foundId, name, userId);
      }
      await ref.set({ contactId: foundId, name });
      return { contactId: foundId, name };
    }
  } catch {
    // Search syntax varies by version; fall through and create the customer.
  }

  const created = await akauntingRequest("contacts", {
    method: "POST",
    body: {
      type: "customer",
      name: wantedName,
      currency_code: currencyCode(),
      enabled: 1,
      reference: userId,
      ...(email ? { email } : {}),
    },
  });
  const id = resourceId(created);
  if (!id) throw new Error("Akaunting did not return a contact id");
  await ref.set({ contactId: id, name: wantedName });
  return { contactId: id, name: wantedName };
}

async function findInvoice(
  number: string
): Promise<{ id: number; status: string } | undefined> {
  const rows = resourceList(
    await akauntingRequest("documents", {
      search: `type:invoice document_number:${number}`,
    })
  );
  const match = rows.find((row) => String(row.document_number ?? "") === number);
  const id = typeof match?.id === "number" ? match.id : Number(match?.id);
  if (!match || !Number.isFinite(id) || id <= 0) return undefined;
  return { id, status: String(match.status ?? "") };
}

async function claimPayment(
  reference: string
): Promise<"posted" | "busy" | { documentId?: number }> {
  const db = getFirestoreDb();
  const ref = db.collection(COL_PAYMENTS).doc(safeDocId(reference));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() as PaymentRecord) : undefined;
    if (data?.transactionId || data?.settled) return "posted" as const;
    const claimedAt = data?.claimedAt ? Date.parse(data.claimedAt) : 0;
    const inProgress =
      Number.isFinite(claimedAt) &&
      claimedAt > 0 &&
      Date.now() - claimedAt < CLAIM_MS &&
      !data?.documentId;
    if (inProgress) return "busy" as const;
    tx.set(
      ref,
      { reference, claimedAt: new Date().toISOString() },
      { merge: true }
    );
    return { documentId: data?.documentId };
  });
}

async function savePayment(reference: string, patch: PaymentRecord): Promise<void> {
  await getFirestoreDb()
    .collection(COL_PAYMENTS)
    .doc(safeDocId(reference))
    .set(patch, { merge: true });
}

async function createPaidInvoice(
  input: AkauntingReceivedPayment,
  existingDocumentId?: number
): Promise<void> {
  const lines = input.lines
    .map((line) => ({
      name: line.name.trim().slice(0, 255) || "VPS hosting",
      description: line.description?.trim().slice(0, 500),
      quantity: Math.max(1, Math.floor(line.quantity) || 1),
      unitUsdCents: Math.max(0, Math.round(line.unitUsdCents)),
    }))
    .filter((line) => line.unitUsdCents > 0);
  if (lines.length === 0) return;

  const number = documentNumber(input.reference);
  const books = await resolveBooks();
  const { contactId, name: contactName } = await contactFor(input);
  const email = validEmail(input.customerEmail);
  const paidAt = akauntingTimestamp(input.paidAt);
  const currency = currencyCode();

  let documentId = existingDocumentId;
  if (!documentId) {
    const existing = await findInvoice(number);
    if (existing?.status === "paid") {
      await savePayment(input.reference, {
        reference: input.reference,
        documentId: existing.id,
        documentNumber: number,
        settled: true,
        postedAt: new Date().toISOString(),
        claimedAt: "",
        error: "",
      });
      return;
    }
    documentId = existing?.id;
  }

  if (!documentId) {
    const items = lines.map((line) => {
      const price = dollars(line.unitUsdCents);
      return {
        name: line.name,
        ...(line.description ? { description: line.description } : {}),
        quantity: line.quantity,
        price,
        total: Math.round(price * line.quantity * 100) / 100,
        discount: 0,
      };
    });
    const amount = items.reduce((sum, item) => sum + item.total, 0);
    const created = await akauntingRequest("documents", {
      method: "POST",
      body: {
        type: "invoice",
        document_number: number,
        status: "sent",
        issued_at: paidAt,
        due_at: paidAt,
        currency_code: currency,
        currency_rate: 1,
        contact_id: contactId,
        contact_name: contactName,
        ...(email ? { contact_email: email } : {}),
        category_id: books.categoryId,
        amount,
        notes: `${input.rail} ${input.reference}`.slice(0, 500),
        items,
      },
    });
    documentId = resourceId(created);
    if (!documentId) throw new Error("Akaunting did not return an invoice id");
    await savePayment(input.reference, {
      reference: input.reference,
      documentId,
      documentNumber: number,
    });
  }

  const totalCents = lines.reduce(
    (sum, line) => sum + line.unitUsdCents * line.quantity,
    0
  );
  const paid = await akauntingRequest(`documents/${documentId}/transactions`, {
    method: "POST",
    body: {
      type: "income",
      number: `PAY${number.slice(2)}`,
      account_id: books.accountId,
      paid_at: paidAt,
      amount: dollars(totalCents),
      currency_code: currency,
      currency_rate: 1,
      document_id: documentId,
      contact_id: contactId,
      category_id: books.categoryId,
      payment_method: paymentMethod(input.rail),
      description: `${input.rail} payment ${input.reference}`.slice(0, 500),
      reference: input.reference.slice(0, 255),
    },
  });
  const transactionId = resourceId(paid) ?? documentId;
  await savePayment(input.reference, {
    reference: input.reference,
    documentId,
    transactionId,
    documentNumber: number,
    settled: true,
    postedAt: new Date().toISOString(),
    claimedAt: "",
    error: "",
  });
  logApp("info", `Posted payment ${input.reference} to Akaunting invoice ${documentId}`, {
    category: "payment",
    context: { userId: input.userId },
    details: { rail: input.rail, transactionId, usdCents: totalCents },
  });
}

/**
 * Create (or finish) the Akaunting invoice + payment for one received charge.
 * No-ops when Akaunting env vars are unset, the amount is zero, or this
 * reference was already posted.
 */
export async function postReceivedPaymentToAkaunting(
  input: AkauntingReceivedPayment
): Promise<void> {
  const reference = input.reference.trim();
  if (skipUnconfiguredAkaunting(reference || "payment", input.userId)) return;
  if (!reference || !input.userId.trim()) return;
  const total = input.lines.reduce(
    (sum, line) =>
      sum + Math.max(0, Math.round(line.unitUsdCents)) * Math.max(1, Math.floor(line.quantity) || 1),
    0
  );
  if (total <= 0) return;

  try {
    const claim = await claimPayment(reference);
    if (claim === "posted" || claim === "busy") return;
    await createPaidInvoice({ ...input, reference }, claim.documentId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await savePayment(reference, {
      reference,
      error: message.slice(0, 1000),
      claimedAt: "",
    }).catch(() => undefined);
    logError("payment", `Akaunting post failed for ${reference}`, err, {
      userId: input.userId,
    });
  }
}

/**
 * Record a PayPal sale. Checkout may already have posted `paypal-initial-{id}`
 * before the sale id was known; within a day of the order that counts as the
 * same payment so the webhook does not book it twice.
 */
export async function postPaypalSaleToAkaunting(
  input: AkauntingReceivedPayment & {
    subscriptionId: string;
    saleId: string;
    orderCreatedAt?: string;
  }
): Promise<void> {
  const saleRef = `paypal_${input.saleId.trim().toLowerCase()}`;
  if (skipUnconfiguredAkaunting(saleRef, input.userId)) return;
  const initialRef = `paypal-initial-${input.subscriptionId.trim().toLowerCase()}`;
  try {
    const saleDoc = await getFirestoreDb()
      .collection(COL_PAYMENTS)
      .doc(safeDocId(saleRef))
      .get();
    const saleData = saleDoc.data() as PaymentRecord | undefined;
    if (saleData?.transactionId || saleData?.settled) return;

    const created = input.orderCreatedAt ? Date.parse(input.orderCreatedAt) : NaN;
    const recent =
      Number.isFinite(created) && Date.now() - created >= 0 && Date.now() - created < 24 * 60 * 60 * 1000;
    if (recent) {
      const initialDoc = await getFirestoreDb()
        .collection(COL_PAYMENTS)
        .doc(safeDocId(initialRef))
        .get();
      const initial = initialDoc.data() as PaymentRecord | undefined;
      if (initial?.transactionId || initial?.settled) {
        await savePayment(saleRef, {
          reference: saleRef,
          documentId: initial.documentId,
          transactionId: initial.transactionId,
          documentNumber: initial.documentNumber,
          settled: true,
          postedAt: initial.postedAt ?? new Date().toISOString(),
          claimedAt: "",
        });
        return;
      }
    }
  } catch (err) {
    logError("payment", `Akaunting PayPal lookup failed for ${saleRef}`, err, {
      userId: input.userId,
    });
  }

  await postReceivedPaymentToAkaunting({ ...input, reference: saleRef });
}
