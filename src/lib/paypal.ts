/**
 * PayPal REST API client (server-side).
 *
 * This module talks to PayPal's REST API for two flows:
 *  1. **Billing Plans + Subscriptions** — used at checkout and for auto-renew.
 *     We create/reuse a Product + Plan per priced-service snapshot and expose
 *     the plan id to the browser so `<paypal.Buttons>` can hand it to
 *     `paypal.createSubscription`.
 *  2. **Webhook signature verification** — every inbound webhook is POSTed to
 *     `/v1/notifications/verify-webhook-signature`, which authenticates the
 *     event against the app-level webhook id.
 *
 * Docs:
 *  - https://developer.paypal.com/docs/api/subscriptions/v1/
 *  - https://developer.paypal.com/docs/api/catalog-products/v1/
 *  - https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature
 *
 * All requests use `fetch` (no external dependency). We cache OAuth tokens for
 * ~55 minutes (PayPal's default TTL is one hour).
 */

import type { NextRequest } from "next/server";
import type { VPSService } from "@/lib/db";
import {
  getPaypalPlanRecord,
  paypalPlanCacheId,
  putPaypalPlanRecord,
} from "@/lib/db";

// ---------- env ------------------------------------------------------------

export type PaypalEnv = "sandbox" | "live";

function readEnv(): {
  env: PaypalEnv;
  clientId: string;
  clientSecret: string;
  webhookId: string;
} {
  const env: PaypalEnv =
    (process.env.PAYPAL_ENV?.trim().toLowerCase() as PaypalEnv) === "live"
      ? "live"
      : "sandbox";
  const prefix = env === "live" ? "PAYPAL_LIVE" : "PAYPAL_SANDBOX";
  return {
    env,
    clientId: (process.env[`${prefix}_CLIENT_ID`] ?? "").trim(),
    clientSecret: (process.env[`${prefix}_CLIENT_SECRET`] ?? "").trim(),
    webhookId: (process.env[`${prefix}_WEBHOOK_ID`] ?? "").trim(),
  };
}

export function paypalEnv(): PaypalEnv {
  return readEnv().env;
}

export function paypalIsConfigured(): boolean {
  const c = readEnv();
  return !!(c.clientId && c.clientSecret);
}

/**
 * Public client id used by the JS SDK on order / renew pages.
 *
 * Always the CLIENT_ID for the current `PAYPAL_ENV` — never the browser-baked
 * `NEXT_PUBLIC_PAYPAL_CLIENT_ID`. If the two disagree we log a loud warning
 * because that mismatch causes `RESOURCE_NOT_FOUND` at checkout: the browser
 * SDK loads against one PayPal environment (sandbox/live) but the Plan id the
 * server hands it belongs to the other environment.
 *
 * The fix is either:
 *   1. Set `NEXT_PUBLIC_PAYPAL_CLIENT_ID` to match `PAYPAL_*_CLIENT_ID` for
 *      the current `PAYPAL_ENV`, and redeploy so the client bundle picks it up.
 *   2. Leave `NEXT_PUBLIC_PAYPAL_CLIENT_ID` blank in prod and let the frontend
 *      fetch this value from `/api/paypal/config` (the JS SDK then always
 *      matches whatever env the server is in — no possibility of drift).
 */
export function paypalPublicClientId(): string {
  const { env, clientId } = readEnv();
  const nextPublic = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID?.trim() || "";
  if (nextPublic && clientId && nextPublic !== clientId) {
    console.warn(
      `[paypal] NEXT_PUBLIC_PAYPAL_CLIENT_ID does not match PAYPAL_${env.toUpperCase()}_CLIENT_ID. ` +
        `The browser SDK would load against the wrong PayPal environment and hit RESOURCE_NOT_FOUND. ` +
        `Serving the server-side ${env} client id to the frontend instead.`
    );
  }
  return clientId || nextPublic;
}

function apiBase(env: PaypalEnv): string {
  return env === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

// ---------- OAuth ---------------------------------------------------------

type TokenCache = { at: number; token: string; ttlMs: number };
let tokenCache: TokenCache | null = null;
/** Refresh a bit before PayPal's 1h TTL to avoid races. */
const TOKEN_REUSE_SAFETY_MS = 55 * 60 * 1000;

async function getAccessToken(): Promise<string> {
  const { env, clientId, clientSecret } = readEnv();
  if (!clientId || !clientSecret) {
    throw new Error(
      "PayPal is not configured — set PAYPAL_ENV and the matching CLIENT_ID/CLIENT_SECRET in .env"
    );
  }
  const now = Date.now();
  if (tokenCache && now - tokenCache.at < tokenCache.ttlMs) {
    return tokenCache.token;
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PayPal OAuth failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
  const token = data.access_token;
  if (!token) {
    throw new Error(`PayPal OAuth: missing access_token in response`);
  }
  const ttlMs = Math.min(
    (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000,
    TOKEN_REUSE_SAFETY_MS
  );
  tokenCache = { at: now, token, ttlMs };
  return token;
}

/**
 * Authenticated PayPal REST call. `body` is JSON-encoded automatically.
 * Throws on non-2xx with the PayPal error body in the message.
 */
export async function paypalFetch<T = unknown>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    /** PayPal requires this on idempotent create ops (`Prefer`, `PayPal-Request-Id`). */
    requestId?: string;
  } = {}
): Promise<T> {
  const { env } = readEnv();
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(init.requestId ? { "PayPal-Request-Id": init.requestId } : {}),
    ...init.headers,
  };
  const res = await fetch(`${apiBase(env)}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    // Never cache PayPal traffic across serverless invocations.
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `PayPal ${init.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(
        0,
        400
      )}`
    );
  }
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

// ---------- Product + Plan lifecycle --------------------------------------

/**
 * Return a PayPal Plan id (`P-...`) for the given service + monthly-cents
 * snapshot, creating a Product + Plan on first use. Cached in Firestore so we
 * don't recreate a Plan every time an admin loads the checkout page.
 */
export async function ensurePaypalPlanForService(
  service: VPSService,
  monthlyUsdCents: number
): Promise<{ paypalProductId: string; paypalPlanId: string }> {
  const env = paypalEnv();
  const cacheId = paypalPlanCacheId(service.id, monthlyUsdCents, env);
  const cached = await getPaypalPlanRecord(cacheId);
  if (cached) {
    return {
      paypalProductId: cached.paypalProductId,
      paypalPlanId: cached.paypalPlanId,
    };
  }

  const productName = truncate(`DeSoHosting: ${service.name}`, 127);
  const productDesc = truncate(
    service.description || `${service.name} monthly hosting plan`,
    256
  );

  const product = await paypalFetch<{ id: string }>("/v1/catalogs/products", {
    method: "POST",
    body: {
      name: productName,
      description: productDesc,
      type: "SERVICE",
      // Valid PayPal Catalog Products category enum for cloud/VPS hosting.
      // Full enum is at https://developer.paypal.com/docs/api/catalog-products/v1/#definition-product_category
      category: "COMPUTER_AND_DATA_PROCESSING_SERVICES",
    },
    requestId: `dh-prod-${service.id}-${env}`,
  });

  const plan = await paypalFetch<{ id: string; status: string }>(
    "/v1/billing/plans",
    {
      method: "POST",
      body: {
        product_id: product.id,
        name: truncate(`${service.name} — monthly`, 127),
        description: truncate(
          `Monthly plan for ${service.name} (${service.vcpu} vCPU · ${
            service.ram / 1024
          } GB RAM · ${service.storage} GB) via PayPal.`,
          127
        ),
        status: "ACTIVE",
        billing_cycles: [
          {
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            // Infinite recurrences until cancelled.
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: formatUsdCentsAsAmount(monthlyUsdCents),
                currency_code: "USD",
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: "CONTINUE",
          payment_failure_threshold: 3,
        },
      },
      requestId: `dh-plan-${service.id}-${monthlyUsdCents}-${env}`,
    }
  );

  await putPaypalPlanRecord({
    id: cacheId,
    serviceId: service.id,
    monthlyUsdCents: Math.floor(monthlyUsdCents),
    env,
    paypalProductId: product.id,
    paypalPlanId: plan.id,
    createdAt: new Date().toISOString(),
  });

  return { paypalProductId: product.id, paypalPlanId: plan.id };
}

// ---------- Subscription fetch / cancel / refund --------------------------

export interface PaypalSubscription {
  id: string;
  plan_id: string;
  status:
    | "APPROVAL_PENDING"
    | "APPROVED"
    | "ACTIVE"
    | "SUSPENDED"
    | "CANCELLED"
    | "EXPIRED";
  status_update_time?: string;
  start_time?: string;
  create_time?: string;
  subscriber?: {
    email_address?: string;
    payer_id?: string;
    name?: { given_name?: string; surname?: string };
  };
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { time?: string; amount?: { value?: string; currency_code?: string } };
    cycle_executions?: unknown;
    outstanding_balance?: { value?: string; currency_code?: string };
  };
  custom_id?: string;
}

export async function getPaypalSubscription(
  subscriptionId: string
): Promise<PaypalSubscription> {
  return paypalFetch<PaypalSubscription>(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`
  );
}

/** Cancels a PayPal subscription; PayPal will stop billing after this. */
export async function cancelPaypalSubscription(
  subscriptionId: string,
  reason: string
): Promise<void> {
  await paypalFetch<void>(
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    {
      method: "POST",
      body: { reason: truncate(reason || "Cancelled by user", 128) },
    }
  );
}

/** Refund a specific PayPal capture in full. */
export async function refundPaypalCapture(
  captureId: string,
  reason: string
): Promise<{ id: string; status: string }> {
  return paypalFetch<{ id: string; status: string }>(
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    {
      method: "POST",
      body: {
        note_to_payer: truncate(reason || "Refund issued.", 255),
      },
    }
  );
}

/**
 * Full refund of the most recent captured sale on a subscription. Uses the v1
 * Payments Subscriptions transactions listing to find the newest completed
 * sale, then hits v2 `/payments/captures/{id}/refund`. Returns the refund id.
 */
export async function refundLatestSubscriptionSale(
  subscriptionId: string,
  reason: string
): Promise<{ refundId: string; captureId: string; amount: string } | null> {
  // Window: last 365 days (PayPal API caps range).
  const now = new Date();
  const start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const qs = new URLSearchParams({
    start_time: start.toISOString(),
    end_time: now.toISOString(),
  });
  const listPath = `/v1/billing/subscriptions/${encodeURIComponent(
    subscriptionId
  )}/transactions?${qs.toString()}`;
  const listing = await paypalFetch<{
    transactions?: Array<{
      id?: string;
      status?: string;
      amount_with_breakdown?: {
        gross_amount?: { value?: string; currency_code?: string };
      };
    }>;
  }>(listPath);
  const completed = (listing.transactions ?? []).filter(
    (t) => t.status === "COMPLETED"
  );
  if (completed.length === 0) return null;
  const latest = completed[completed.length - 1]!;
  const captureId = latest.id;
  if (!captureId) return null;
  const refund = await refundPaypalCapture(captureId, reason);
  const amt = latest.amount_with_breakdown?.gross_amount?.value ?? "0.00";
  return { refundId: refund.id, captureId, amount: amt };
}

// ---------- Webhook signature verification --------------------------------

export interface PaypalWebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
  summary?: string;
}

/**
 * Verify a webhook signature against PayPal's REST endpoint. Returns true only
 * when PayPal responds `verification_status: SUCCESS`.
 *
 * The caller MUST pass the exact raw JSON body received on the wire — anything
 * else (re-serialized, whitespace-normalized) will fail signature validation.
 */
export async function verifyPaypalWebhookSignature(
  req: NextRequest,
  rawBody: string
): Promise<boolean> {
  const { webhookId } = readEnv();
  if (!webhookId) {
    console.warn("[paypal] webhook id not configured; refusing to accept");
    return false;
  }
  const headers = req.headers;
  const transmissionId = headers.get("paypal-transmission-id") ?? "";
  const transmissionTime = headers.get("paypal-transmission-time") ?? "";
  const certUrl = headers.get("paypal-cert-url") ?? "";
  const authAlgo = headers.get("paypal-auth-algo") ?? "";
  const transmissionSig = headers.get("paypal-transmission-sig") ?? "";
  if (
    !transmissionId ||
    !transmissionTime ||
    !certUrl ||
    !authAlgo ||
    !transmissionSig
  ) {
    return false;
  }
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const body = {
    transmission_id: transmissionId,
    transmission_time: transmissionTime,
    cert_url: certUrl,
    auth_algo: authAlgo,
    transmission_sig: transmissionSig,
    webhook_id: webhookId,
    webhook_event: event,
  };
  try {
    const result = await paypalFetch<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      { method: "POST", body }
    );
    return result.verification_status === "SUCCESS";
  } catch (e) {
    console.error("[paypal] verify-webhook-signature call failed:", e);
    return false;
  }
}

// ---------- Utilities -----------------------------------------------------

/** USD cents → PayPal `amount.value` string with exactly two decimals. */
export function formatUsdCentsAsAmount(usdCents: number): string {
  const n = Math.max(0, Math.floor(Number(usdCents) || 0));
  const dollars = Math.floor(n / 100);
  const remainder = n % 100;
  return `${dollars}.${remainder.toString().padStart(2, "0")}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}
