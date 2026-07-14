"use client";

import { useCallback, useEffect, useState } from "react";
import { payWithDeSo, payWithDUSDC } from "@/lib/deso";
import { getDesoPaymentRecipientPublicKey } from "@/lib/payment-public-key";
import {
  MAX_RENEWAL_MONTHS,
  renewMemoFull,
} from "@/lib/renewal-months";
import { apiFetch } from "@/lib/api-client";
import type { PaymentToken } from "@/lib/deso-tokens";

type RenewQuote = {
  orderId: string;
  serviceName: string;
  months: number;
  maxRenewalMonths: number;
  monthlyUsdFormatted: string;
  totalUsdFormatted: string;
  totalUsdCents: number;
  monthlyDesoFormatted: string;
  desoFormatted: string;
  amountNanos: number;
  monthlyDusdcFormatted: string;
  dusdcFormatted: string;
  usdPerDeso: number;
  rateSource: string;
  nextPaymentAt: string;
  subscriptionStatus: string;
};

export function RenewSubscriptionPanel(props: {
  orderId: string;
  userPublicKey: string;
  onSuccess?: () => void;
}) {
  const { orderId, onSuccess } = props;
  const payee = getDesoPaymentRecipientPublicKey();
  const [months, setMonths] = useState(1);
  const [paymentToken, setPaymentToken] = useState<PaymentToken>("DESO");
  const [quote, setQuote] = useState<RenewQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const loadQuote = useCallback(() => {
    setError(null);
    setLoading(true);
    void apiFetch(
      `/api/pricing/renew-quote?orderId=${encodeURIComponent(orderId)}&months=${months}`
    )
      .then(async (r) => {
        const data = (await r.json()) as { error?: string } & Partial<RenewQuote>;
        if (!r.ok) throw new Error(data.error || "Quote failed");
        setQuote(data as RenewQuote);
      })
      .catch((e) => {
        setQuote(null);
        setError(e instanceof Error ? e.message : "Could not load quote");
      })
      .finally(() => setLoading(false));
  }, [orderId, months]);

  useEffect(() => {
    if (open) loadQuote();
  }, [open, loadQuote]);

  async function handlePay() {
    if (!payee || !quote) return;
    const monthsToPay = months;
    let amountNanos = quote.amountNanos;
    let usdCents = quote.totalUsdCents;
    try {
      const res = await apiFetch(
        `/api/pricing/renew-quote?orderId=${encodeURIComponent(orderId)}&months=${monthsToPay}`
      );
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Quote failed");
      amountNanos = data.amountNanos as number;
      usdCents = data.totalUsdCents as number;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh quote");
      return;
    }

    const memo = renewMemoFull(orderId, monthsToPay);
    setPaying(true);
    setError(null);
    try {
      const paymentResult =
        paymentToken === "DUSDC"
          ? await payWithDUSDC(payee, usdCents, memo)
          : await payWithDeSo(payee, amountNanos, memo);
      const txHash =
        (
          paymentResult as {
            submittedTransactionResponse?: { TxnHashHex?: string };
          }
        )?.submittedTransactionResponse?.TxnHashHex;
      if (!txHash) {
        throw new Error("No transaction hash returned from wallet");
      }
      const renewRes = await apiFetch("/api/billing/renew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          txHash,
          months: monthsToPay,
          paymentToken,
        }),
      });
      const renewData = await renewRes.json();
      if (!renewRes.ok) throw new Error(renewData.error || "Renewal failed");
      setOpen(false);
      onSuccess?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setPaying(false);
    }
  }

  if (!payee) {
    return (
      <p className="mt-3 text-xs text-[var(--muted)]">
        Renewal payments are not configured (missing NEXT_PUBLIC_DESO_PAYMENT_PUBLIC_KEY).
      </p>
    );
  }

  return (
    <div className="mt-4 border-t border-[var(--card-border)] pt-4">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg border border-[var(--card-border)] bg-[var(--card)]/25 px-4 py-2 text-sm font-medium text-[var(--foreground)] shadow-sm transition-[background-color,box-shadow,border-color,transform] duration-150 hover:border-[var(--accent)]/45 hover:bg-[var(--card)] hover:text-[var(--accent)] hover:shadow-md active:scale-[0.98]"
        >
          Renew (1–{MAX_RENEWAL_MONTHS} months)
        </button>
      ) : (
        <div className="rounded-xl border border-[var(--card-border)] bg-[var(--background)]/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">Renew subscription</h4>
            <button
              type="button"
              className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Close
            </button>
          </div>
          <div className="mt-3">
            <p className="text-xs font-medium text-[var(--muted)]">Months to pay</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {[1, 2, 3].map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={paying}
                  onClick={() => setMonths(m)}
                  className={
                    months === m
                      ? "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)]"
                      : "rounded-lg border border-[var(--card-border)] bg-[var(--background)]/30 px-3 py-1.5 text-sm hover:bg-[var(--card)] disabled:opacity-50"
                  }
                >
                  {m} {m === 1 ? "month" : "months"}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <p className="text-xs font-medium text-[var(--muted)]">Pay with</p>
            <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Payment token">
              {(
                [
                  { id: "DESO" as const, label: "DESO" },
                  { id: "DUSDC" as const, label: "dUSDC" },
                ]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={paymentToken === opt.id}
                  disabled={paying}
                  onClick={() => setPaymentToken(opt.id)}
                  className={
                    paymentToken === opt.id
                      ? "rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--background)]"
                      : "rounded-lg border border-[var(--card-border)] bg-[var(--background)]/30 px-3 py-1.5 text-sm hover:bg-[var(--card)] disabled:opacity-50"
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-[var(--muted)]">
              dUSDC is the USD-pegged wrapped-USDC DeSo Token (1 dUSDC ≈ $1).
              Your Identity wallet must hold a balance and will prompt for a
              token-transfer permission.
            </p>
          </div>
          {loading && (
            <p className="mt-2 text-sm text-[var(--muted)]">Loading quote…</p>
          )}
          {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
          {quote && !loading && (
            <>
              <p className="mt-2 text-xs text-[var(--muted)]">
                Floating rate: prepay up to {MAX_RENEWAL_MONTHS} months for{" "}
                <span className="font-medium text-[var(--foreground)]">
                  {quote.serviceName}
                </span>{" "}
                at the current monthly DeSo price ({quote.months}{" "}
                {quote.months === 1 ? "month" : "months"} selected).
              </p>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--muted)]">USD / monthly</dt>
                  <dd className="tabular-nums">{quote.monthlyUsdFormatted}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--muted)]">USD (this payment)</dt>
                  <dd className="font-medium tabular-nums">{quote.totalUsdFormatted}</dd>
                </div>
                {paymentToken === "DESO" ? (
                  <>
                    <div className="flex justify-between gap-4">
                      <dt className="text-[var(--muted)]">DeSo / monthly</dt>
                      <dd className="tabular-nums text-[var(--accent)]">
                        {quote.monthlyDesoFormatted} DESO
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-[var(--muted)]">DeSo (this payment)</dt>
                      <dd className="font-medium tabular-nums text-[var(--accent)]">
                        {quote.desoFormatted} DESO
                      </dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex justify-between gap-4">
                      <dt className="text-[var(--muted)]">dUSDC / monthly</dt>
                      <dd className="tabular-nums text-[var(--accent)]">
                        {quote.monthlyDusdcFormatted}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-[var(--muted)]">dUSDC (this payment)</dt>
                      <dd className="font-medium tabular-nums text-[var(--accent)]">
                        {quote.dusdcFormatted}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {paymentToken === "DESO" ? (
                  <>
                    ~${quote.usdPerDeso.toFixed(4)} / DESO
                    {quote.rateSource === "env" ? " (DESO_USD_PRICE)" : " (node)"}
                  </>
                ) : (
                  <>Fixed peg: 1 dUSDC = $1 (wrapped USDC on DeSo)</>
                )}
              </p>
              <button
                type="button"
                disabled={paying}
                onClick={() => void handlePay()}
                className="mt-4 w-full rounded-lg bg-[var(--accent)] py-2.5 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)] disabled:opacity-50"
              >
                {paying
                  ? "Processing…"
                  : paymentToken === "DUSDC"
                    ? "Pay with dUSDC & extend billing"
                    : "Pay with DeSo & extend billing"}
              </button>
              <button
                type="button"
                className="mt-2 w-full text-xs text-[var(--muted)] hover:underline"
                onClick={() => void loadQuote()}
                disabled={loading || paying}
              >
                Refresh quote
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
