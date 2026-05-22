"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { payWithDeSo, formatDesoDisplay } from "@/lib/deso";
import { formatUsdCents } from "@/lib/pricing";
import {
  extraDisksAddonUsdCents,
  extraDisksProvisionedGbTotal,
  extraDiskTierMenuLabel,
} from "@/lib/extra-disk-pricing";
import {
  EXTRA_DISK_TIER_SIZES_GB,
  labelExtraDiskTierGb,
} from "@/lib/extra-disks";
import { apiFetch } from "@/lib/api-client";
import { ORDER_TERMS_REVISION } from "@/lib/terms-revision";

const PAYMENT_PUBLIC_KEY =
  process.env.NEXT_PUBLIC_DESO_PAYMENT_PUBLIC_KEY || "";

type QuotePayload = {
  usdCents: number;
  usdFormatted: string;
  amountNanos: number;
  desoFormatted: string;
  usdPerDeso: number;
  rateSource: string;
};

type OrderService = {
  id: string;
  name: string;
  description: string;
  vcpu: number;
  ram: number;
  storage: number;
  priceUsdCents: number;
  pricePreviewNanos?: number;
  desoRateSource?: string;
};

function parseEnvInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

type SshAccessMode = "none" | "paste" | "generate";

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function OrderPage() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const [service, setService] = useState<OrderService | null>(null);
  const [quote, setQuote] = useState<QuotePayload | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ordering, setOrdering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extraDisksGb, setExtraDisksGb] = useState<number[]>([]);
  const [selectedTierGb, setSelectedTierGb] = useState<number>(
    EXTRA_DISK_TIER_SIZES_GB[0]!
  );
  const [sshAccess, setSshAccess] = useState<SshAccessMode>("none");
  const [sshPublicKeyDraft, setSshPublicKeyDraft] = useState("");
  const [orderKeyBundle, setOrderKeyBundle] = useState<{
    orderId: string;
    privateKey: string;
    publicLine: string;
  } | null>(null);
  const [orderKeyCopyHint, setOrderKeyCopyHint] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const maxExtraCount = useMemo(
    () =>
      Math.min(
        26,
        parseEnvInt(process.env.NEXT_PUBLIC_PROVISION_MAX_EXTRA_DISKS, 8)
      ),
    []
  );
  const extraAddonCents = useMemo(
    () => extraDisksAddonUsdCents(extraDisksGb),
    [extraDisksGb]
  );
  const provisionedExtraGb = useMemo(
    () => extraDisksProvisionedGbTotal(extraDisksGb),
    [extraDisksGb]
  );

  useEffect(() => {
    if (!user) {
      router.push("/");
      return;
    }
    fetch(`/api/services/${params.id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setService(data as OrderService);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.id, user, router]);

  useEffect(() => {
    if (!service || service.priceUsdCents == null) {
      setQuote(null);
      return;
    }
    const usdCentsTotal = service.priceUsdCents + extraDisksAddonUsdCents(extraDisksGb);
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    fetch(`/api/pricing/quote?usdCents=${usdCentsTotal}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) throw new Error(data.error);
        setQuote(data as QuotePayload);
      })
      .catch((e) => {
        if (!cancelled) {
          setQuoteError(e instanceof Error ? e.message : "Could not load quote");
          setQuote(null);
        }
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, extraDisksGb]);

  function addExtraDisk() {
    setError(null);
    if (extraDisksGb.length >= maxExtraCount) {
      setError(`At most ${maxExtraCount} additional disks.`);
      return;
    }
    setExtraDisksGb((prev) => [...prev, selectedTierGb]);
  }

  function removeExtraDisk(index: number) {
    setExtraDisksGb((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleOrder() {
    if (!user || !service || !PAYMENT_PUBLIC_KEY) {
      if (!PAYMENT_PUBLIC_KEY) setError("Payment not configured. Contact admin.");
      return;
    }

    if (!acceptedTerms) {
      setError(
        "You must agree to the Terms of Service & Acceptable Use Policy before completing your purchase."
      );
      return;
    }

    const totalUsdCents =
      service.priceUsdCents + extraDisksAddonUsdCents(extraDisksGb);

    let payNanos = quote?.amountNanos;
    if (payNanos == null) {
      try {
        const res = await fetch(
          `/api/pricing/quote?usdCents=${totalUsdCents}`
        );
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || "Quote failed");
        payNanos = data.amountNanos as number;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not get DeSo amount");
        return;
      }
    }

    setOrdering(true);
    setError(null);
    try {
      if (sshAccess === "paste" && !sshPublicKeyDraft.trim()) {
        throw new Error(
          "Paste your SSH public key, or choose password-only / generate a new key."
        );
      }
      const paymentResult = await payWithDeSo(
        PAYMENT_PUBLIC_KEY,
        payNanos,
        `DeSoHosting: ${service.name} (${formatUsdCents(totalUsdCents)})`
      );
      const txHash =
        (paymentResult as { submittedTransactionResponse?: { TransactionHashHex?: string } })?.submittedTransactionResponse?.TransactionHashHex ||
        (paymentResult as { constructedTransactionResponse?: { TransactionIDHex?: string } })?.constructedTransactionResponse?.TransactionIDHex;

      const res = await apiFetch("/api/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          txHash: txHash || undefined,
          desoUsername: user.username,
          extraDisksGb: extraDisksGb.length ? extraDisksGb : undefined,
          sshAccess: sshAccess === "none" ? "none" : sshAccess,
          sshPublicKey:
            sshAccess === "paste" ? sshPublicKeyDraft.trim() : undefined,
          acceptedTermsRevision: ORDER_TERMS_REVISION,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (
        typeof data.generatedSshPrivateKey === "string" &&
        typeof data.generatedSshPublicKeyLine === "string" &&
        data.order?.id
      ) {
        setOrderKeyCopyHint(null);
        setOrderKeyBundle({
          orderId: data.order.id as string,
          privateKey: data.generatedSshPrivateKey,
          publicLine: data.generatedSshPublicKeyLine,
        });
        return;
      }
      router.replace("/dashboard");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Order failed");
    } finally {
      setOrdering(false);
    }
  }

  if (loading || !user) return null;

  if (error && !service) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-red-400">{error}</p>
        <button
          onClick={() => router.push("/services")}
          className="mt-4 text-[var(--accent)] hover:underline"
        >
          Back to Services
        </button>
      </div>
    );
  }

  if (!service) return null;

  const planUsdLine = formatUsdCents(service.priceUsdCents);
  const totalUsdLine = formatUsdCents(service.priceUsdCents + extraAddonCents);
  const previewDeso =
    quote?.desoFormatted ??
    (service.pricePreviewNanos != null
      ? formatDesoDisplay(service.pricePreviewNanos)
      : null);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-16">
      {orderKeyBundle && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ssh-key-save-title"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-6 text-[var(--foreground)] shadow-xl">
            <h2
              id="ssh-key-save-title"
              className="text-lg font-semibold text-orange-400"
            >
              Download your new SSH private key
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
              This key is shown <span className="font-medium text-[var(--foreground)]">only now</span>.
              We do not store it. Save the file somewhere safe, or you will lose SSH access
              except via password/console.
            </p>
            <p className="mt-3 text-xs text-[var(--muted)]">
              Public key installed on the VM (already saved to your order):
            </p>
            <div className="mt-1 rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs break-all text-[var(--foreground)]">
              {orderKeyBundle.publicLine}
            </div>
            <label className="mt-4 block text-xs font-medium text-[var(--muted)]">
              Private key
            </label>
            <textarea
              readOnly
              className="mt-1 max-h-48 w-full resize-y rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)]"
              value={orderKeyBundle.privateKey}
              rows={10}
            />
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--background)] hover:bg-[var(--accent-muted)]"
                onClick={() =>
                  downloadTextFile(
                    `deso-hosting-${orderKeyBundle.orderId.slice(0, 8)}.key`,
                    orderKeyBundle.privateKey
                  )
                }
              >
                Download private key
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm hover:bg-[var(--background)]"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      orderKeyBundle.privateKey
                    );
                    setOrderKeyCopyHint("Copied to clipboard.");
                  } catch {
                    setOrderKeyCopyHint(
                      "Could not copy automatically — select the text above."
                    );
                  }
                }}
              >
                Copy private key
              </button>
            </div>
            {orderKeyCopyHint && (
              <p className="mt-2 text-xs text-green-400" role="status">
                {orderKeyCopyHint}
              </p>
            )}
            <button
              type="button"
              className="mt-6 w-full rounded-lg border border-[var(--card-border)] py-3 text-sm font-medium hover:bg-[var(--background)]"
              onClick={() => {
                setOrderKeyBundle(null);
                setOrderKeyCopyHint(null);
                router.replace("/dashboard");
              }}
            >
              I&apos;ve saved it — go to dashboard
            </button>
          </div>
        </div>
      )}
      <h1 className="text-xl font-bold sm:text-2xl">Complete Order</h1>
      <div className="mt-6 rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-4 sm:p-6">
        <h3 className="text-lg font-semibold sm:text-xl">{service.name}</h3>
        <p className="mt-2 text-sm text-[var(--muted)] sm:text-base">{service.description}</p>
        <div className="mt-4 flex flex-col gap-2 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <span className="min-w-0 text-[var(--muted)]">{service.vcpu} vCPU · {service.ram / 1024} GB Memory · {service.storage} GB</span>
          <span className="shrink-0 font-semibold text-[var(--accent)]">{totalUsdLine}/mo</span>
        </div>

        <div className="mt-6 rounded-xl border border-[var(--card-border)] bg-[var(--background)]/50 p-4">
          <h4 className="text-sm font-semibold text-[var(--foreground)]">
            Payment confirmation
          </h4>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Plan price is set in USD. When you add extra disks, each tier in the menu shows its
            monthly USD add-on for that volume. DeSo amount follows the current exchange rate.
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--muted)]">Plan (monthly)</dt>
              <dd className="font-medium tabular-nums">{planUsdLine}</dd>
            </div>
            {extraAddonCents > 0 && (
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--muted)]">
                  Extra disks ({provisionedExtraGb} GB)
                </dt>
                <dd className="font-medium tabular-nums">
                  +{formatUsdCents(extraAddonCents)}
                </dd>
              </div>
            )}
            <div className="flex justify-between gap-4 border-t border-[var(--card-border)] pt-2">
              <dt className="text-[var(--foreground)]">Total USD (monthly)</dt>
              <dd className="font-semibold tabular-nums">{totalUsdLine}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-[var(--muted)]">DeSo (this charge)</dt>
              <dd className="font-medium tabular-nums text-[var(--accent)]">
                {quoteLoading && !previewDeso ? (
                  <span className="text-[var(--muted)]">Loading…</span>
                ) : previewDeso ? (
                  <>{previewDeso} DESO</>
                ) : (
                  <span className="text-red-400">—</span>
                )}
              </dd>
            </div>
            {quote && (
              <p className="pt-1 text-xs text-[var(--muted)]">
                Rate: ~${quote.usdPerDeso.toFixed(4)} USD per 1 DESO
                {quote.rateSource === "env"
                  ? " (from DESO_USD_PRICE)"
                  : " (from DeSo node exchange rate)"}
              </p>
            )}
          </dl>
          {quoteError && (
            <p className="mt-2 text-xs text-red-400">{quoteError}</p>
          )}
        </div>

        <div className="mt-6 border-t border-[var(--card-border)] pt-4">
          <h4 className="text-sm font-semibold text-[var(--foreground)]">
            SSH access (optional)
          </h4>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Add your public key to the VM&apos;s cloud-init <code className="rounded bg-[var(--background)] px-1">authorized_keys</code> for the
            Linux user created on first boot. You can still use the password from your dashboard.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="ssh-access"
                className="mt-1"
                checked={sshAccess === "none"}
                onChange={() => {
                  setSshAccess("none");
                  setError(null);
                }}
              />
              <span>
                <span className="font-medium text-[var(--foreground)]">Password only</span>
                <span className="block text-xs text-[var(--muted)]">
                  No SSH public key added to cloud-init.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="ssh-access"
                className="mt-1"
                checked={sshAccess === "paste"}
                onChange={() => {
                  setSshAccess("paste");
                  setError(null);
                }}
              />
              <span>
                <span className="font-medium text-[var(--foreground)]">Paste my public key</span>
                <span className="block text-xs text-[var(--muted)]">
                  Typically one line starting with <code className="rounded bg-[var(--background)] px-1">ssh-ed25519</code> or{" "}
                  <code className="rounded bg-[var(--background)] px-1">ssh-rsa</code>.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="ssh-access"
                className="mt-1"
                checked={sshAccess === "generate"}
                onChange={() => {
                  setSshAccess("generate");
                  setError(null);
                }}
              />
              <span>
                <span className="font-medium text-[var(--foreground)]">Generate a new key pair</span>
                <span className="block text-xs text-[var(--muted)]">
                  We add the public key to the VM. After checkout you must download the private key once — we never store it.
                </span>
              </span>
            </label>
          </div>
          {sshAccess === "paste" && (
            <div className="mt-3">
              <label
                htmlFor="ssh-pubkey"
                className="text-xs font-medium text-[var(--muted)]"
              >
                Public key(s); one per line (max 8)
              </label>
              <textarea
                id="ssh-pubkey"
                value={sshPublicKeyDraft}
                onChange={(e) => {
                  setSshPublicKeyDraft(e.target.value);
                  setError(null);
                }}
                placeholder="ssh-ed25519 AAAA... comment@machine"
                rows={4}
                className="mt-1 w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 font-mono text-xs text-[var(--foreground)]"
              />
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-[var(--card-border)] pt-4">
          <h4 className="text-sm font-semibold text-[var(--foreground)]">
            Additional disks (optional)
          </h4>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Extra data volumes on the same storage as the plan disk (max {maxExtraCount} disks).
            Each size in the menu includes that disk&apos;s monthly USD add-on. You partition and mount
            them in the guest after boot.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {extraDisksGb.map((gb, i) => (
              <span
                key={`extra-${i}`}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--card-border)] bg-[var(--background)]/40 px-2 py-1 text-sm"
              >
                {labelExtraDiskTierGb(gb)}
                <button
                  type="button"
                  onClick={() => removeExtraDisk(i)}
                  className="ml-1 rounded px-1 text-[var(--muted)] hover:bg-[var(--card-border)] hover:text-[var(--foreground)]"
                  aria-label={`Remove ${labelExtraDiskTierGb(gb)} disk`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="sr-only" htmlFor="extra-disk-tier">
              Extra disk size
            </label>
            <select
              id="extra-disk-tier"
              value={selectedTierGb}
              onChange={(e) => setSelectedTierGb(Number(e.target.value))}
              className="w-full rounded-lg border border-[var(--card-border)] bg-[var(--background)] px-3 py-2 text-sm sm:max-w-xs"
            >
              {EXTRA_DISK_TIER_SIZES_GB.map((gb) => (
                <option key={gb} value={gb}>
                  {extraDiskTierMenuLabel(gb)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addExtraDisk}
              disabled={extraDisksGb.length >= maxExtraCount}
              className="rounded-lg border border-[var(--card-border)] px-4 py-2 text-sm font-medium hover:bg-[var(--card)] disabled:opacity-40"
            >
              Add disk
            </button>
          </div>
        </div>
        {error && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}
        <div className="mt-6 border-t border-[var(--card-border)] pt-4">
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-snug">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => {
                setAcceptedTerms(e.target.checked);
                setError(null);
              }}
              className="mt-1 h-4 w-4 shrink-0 rounded border-[var(--card-border)] accent-[var(--accent)]"
            />
            <span className="text-[var(--muted)]">
              I have read and agree to the{" "}
              <Link
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-[var(--accent)] underline hover:no-underline"
              >
                Terms of Service &amp; Acceptable Use Policy
              </Link>
              . I understand prohibited uses may result in immediate suspension without
              refund.
            </span>
          </label>
        </div>
        <button
          onClick={handleOrder}
          disabled={
            ordering || quoteLoading || !!quoteError || !acceptedTerms
          }
          className="mt-6 w-full rounded-lg bg-[var(--accent)] py-3 font-medium text-[var(--background)] transition hover:bg-[var(--accent-muted)] disabled:opacity-50"
        >
          {ordering ? "Processing..." : "Pay with DeSo & Order"}
        </button>
      </div>
    </div>
  );
}
