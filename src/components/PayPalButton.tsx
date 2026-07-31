"use client";

/**
 * PayPal Subscription button.
 *
 * Dynamically loads the PayPal JS SDK (`https://www.paypal.com/sdk/js`) the
 * first time the component mounts on a page, then renders the PayPal-branded
 * subscribe button. All buyer interaction happens in a PayPal popup — this
 * component only wires two callbacks:
 *
 *   createSubscription:  return a PayPal Plan id (obtained from our server)
 *   onApprove:           forward the resulting subscription id back to caller
 *
 * The parent component owns the "what does approval mean" logic (create a new
 * order, or attach the subscription to an existing order for renewal).
 *
 * The client id used for the SDK URL is *always* fetched from
 * `/api/paypal/config`, so the browser SDK loads against the same PayPal
 * environment (sandbox/live) that the server is issuing Plan ids for. Any
 * `NEXT_PUBLIC_PAYPAL_CLIENT_ID` passed in as a prop is used only as an
 * optimistic prefetch — a server-side value that disagrees always wins.
 */

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

const SDK_SCRIPT_ID = "paypal-js-sdk";

type PaypalNamespace = {
  Buttons: (config: {
    style?: Record<string, unknown>;
    createSubscription: (
      data: unknown,
      actions: {
        subscription: {
          create: (payload: {
            plan_id: string;
            custom_id?: string;
          }) => Promise<string>;
        };
      }
    ) => Promise<string> | string;
    onApprove: (
      data: { subscriptionID?: string; orderID?: string },
      actions: unknown
    ) => Promise<void> | void;
    onError?: (err: unknown) => void;
    onCancel?: () => void;
  }) => { render: (target: HTMLElement) => Promise<void> };
};

declare global {
  interface Window {
    paypal?: PaypalNamespace;
  }
}

function loadPaypalSdk(clientId: string): Promise<PaypalNamespace> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("PayPal SDK only loads in the browser"));
      return;
    }
    if (window.paypal) {
      resolve(window.paypal);
      return;
    }
    const existing = document.getElementById(
      SDK_SCRIPT_ID
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.paypal) resolve(window.paypal);
        else reject(new Error("PayPal SDK loaded but window.paypal missing"));
      });
      existing.addEventListener("error", () =>
        reject(new Error("Failed to load PayPal SDK"))
      );
      return;
    }
    const script = document.createElement("script");
    script.id = SDK_SCRIPT_ID;
    const params = new URLSearchParams({
      "client-id": clientId,
      vault: "true",
      intent: "subscription",
      // Only render the yellow PayPal Wallet button (per admin decision).
      "disable-funding": "credit,card,paylater,venmo",
      currency: "USD",
    });
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    script.async = true;
    script.dataset.sdkIntegrationSource = "button-factory";
    script.onload = () => {
      if (window.paypal) resolve(window.paypal);
      else reject(new Error("PayPal SDK loaded but window.paypal missing"));
    };
    script.onerror = () => reject(new Error("Failed to load PayPal SDK"));
    document.head.appendChild(script);
  });
}

export interface PayPalButtonProps {
  /**
   * Optional public PayPal client id. Treated as an optimistic hint only —
   * the component always fetches the authoritative id from
   * `/api/paypal/config` before loading the SDK so it can't drift from the
   * server's `PAYPAL_ENV`.
   */
  clientId?: string;
  /**
   * Called when the button needs a plan id. Return the plan id + optional
   * custom_id (we always include the caller's DeSo public key so the server
   * can verify subscription ownership).
   */
  onCreateSubscription: () => Promise<{ paypalPlanId: string; customId?: string }>;
  /** Called with the PayPal subscription id after the buyer approves. */
  onApprove: (paypalSubscriptionId: string) => Promise<void> | void;
  onCancel?: () => void;
  onError?: (err: unknown) => void;
  /** Disable interaction (also hides the button; PayPal buttons don't support disabled). */
  disabled?: boolean;
  /**
   * When any of these values change, we re-render the button so a subsequent
   * `createSubscription` uses the latest inputs (extra disks, VM name, etc.).
   */
  refreshKey?: string;
}

/**
 * Fetch the correct PayPal SDK config from the server.
 *
 * Cached at module scope so multiple `<PayPalButton>` instances on one page
 * (bulk-renew list, per-VPS panel, etc.) share a single request.
 */
let paypalConfigPromise: Promise<{ clientId: string; configured: boolean }> | null =
  null;

function fetchPaypalConfig(): Promise<{ clientId: string; configured: boolean }> {
  if (paypalConfigPromise) return paypalConfigPromise;
  paypalConfigPromise = apiFetch("/api/paypal/config")
    .then(async (res) => {
      if (!res.ok) throw new Error(`PayPal config HTTP ${res.status}`);
      const data = (await res.json()) as {
        configured?: boolean;
        clientId?: string;
      };
      return {
        clientId: typeof data.clientId === "string" ? data.clientId : "",
        configured: data.configured === true,
      };
    })
    .catch((e) => {
      paypalConfigPromise = null;
      throw e;
    });
  return paypalConfigPromise;
}

export function PayPalButton(props: PayPalButtonProps) {
  const {
    clientId: clientIdHint,
    onCreateSubscription,
    onApprove,
    onCancel,
    onError,
    disabled,
    refreshKey,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolvedClientId, setResolvedClientId] = useState<string>("");

  // Fetch the server-provided client id once and cache module-wide. This is
  // the id we actually hand to the JS SDK — any hint passed by the parent is
  // only used as a placeholder to hide the button when PayPal isn't set up.
  useEffect(() => {
    let cancelled = false;
    fetchPaypalConfig()
      .then((cfg) => {
        if (cancelled) return;
        if (!cfg.configured || !cfg.clientId) {
          setLoadError(
            "PayPal is not configured on the server. Please try another payment method."
          );
          setLoading(false);
          return;
        }
        setResolvedClientId(cfg.clientId);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof Error
            ? `Could not load PayPal config: ${err.message}`
            : "Could not load PayPal config"
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveClientId = resolvedClientId;
  const configError =
    !clientIdHint && !resolvedClientId
      ? // The parent didn't hint that PayPal is enabled AND the server hasn't
        // resolved yet: this happens naturally on first render, so don't show
        // an error message — just wait for the config fetch.
        null
      : !effectiveClientId && !loading
        ? "PayPal client id is not configured on this page."
        : null;
  const effectiveError = configError ?? loadError;

  // Keep the latest callbacks in refs so the SDK closure doesn't capture stale
  // state (order form values change while the button is mounted).
  const onCreateRef = useRef(onCreateSubscription);
  const onApproveRef = useRef(onApprove);
  const onCancelRef = useRef(onCancel);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onCreateRef.current = onCreateSubscription;
    onApproveRef.current = onApprove;
    onCancelRef.current = onCancel;
    onErrorRef.current = onError;
  }, [onCreateSubscription, onApprove, onCancel, onError]);

  useEffect(() => {
    let cancelled = false;
    // Capture the current DOM node so the cleanup closure doesn't read a
    // possibly-stale `containerRef.current` (React can null it before cleanup).
    const container = containerRef.current;
    if (!container) return;
    if (!effectiveClientId || disabled) {
      // Nothing to load — the render already reflects the config error /
      // disabled state via `effectiveError` and the `loading` initial value.
      return;
    }

    loadPaypalSdk(effectiveClientId)
      .then((paypal) => {
        if (cancelled) return;
        // Async transitions: safe to setState here (not synchronous in effect body).
        setLoadError(null);
        setLoading(true);
        container.innerHTML = "";
        const buttons = paypal.Buttons({
          style: {
            layout: "vertical",
            color: "gold",
            shape: "rect",
            label: "subscribe",
            height: 44,
          },
          createSubscription: async (_data, actions) => {
            const { paypalPlanId, customId } = await onCreateRef.current();
            return actions.subscription.create({
              plan_id: paypalPlanId,
              ...(customId ? { custom_id: customId } : {}),
            });
          },
          onApprove: async (data) => {
            const id = data.subscriptionID;
            if (!id) return;
            await onApproveRef.current(id);
          },
          onError: (err) => {
            console.error("[paypal button] onError", err);
            onErrorRef.current?.(err);
          },
          onCancel: () => onCancelRef.current?.(),
        });
        buttons.render(container).then(
          () => {
            if (!cancelled) setLoading(false);
          },
          (err) => {
            if (!cancelled) {
              setLoadError(
                err instanceof Error ? err.message : "PayPal button failed to render"
              );
              setLoading(false);
            }
          }
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Could not load PayPal");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
    // `refreshKey` is included intentionally so parents can force a remount
    // (e.g. after form inputs change) even when the other dep values are
    // stable. React's exhaustive-deps rule is happy — no eslint-disable
    // required. The callback refs (`onCreateRef`, etc.) are stable by design.
  }, [effectiveClientId, disabled, refreshKey]);

  return (
    <div>
      <div ref={containerRef} />
      {!effectiveError && !disabled && loading && (
        <p className="mt-2 text-xs text-[var(--muted)]">Loading PayPal…</p>
      )}
      {effectiveError && (
        <p className="mt-2 text-xs text-red-400">
          Could not load PayPal: {effectiveError}
        </p>
      )}
    </div>
  );
}
