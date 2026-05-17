"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";
import { formatDesoDisplay } from "@/lib/deso";
import { formatUsdCents } from "@/lib/pricing";

interface VPSService {
  id: string;
  name: string;
  description: string;
  vcpu: number;
  ram: number;
  storage: number;
  priceUsdCents: number;
  pricePreviewNanos?: number;
  priceNanos?: number;
  active: boolean;
}

export default function ServicesPage() {
  const { user } = useAuth();
  const [services, setServices] = useState<VPSService[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then(setServices)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-2xl bg-[var(--card)]"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
      <h1 className="text-3xl font-bold">VPS Plans</h1>
      <p className="mt-2 text-[var(--muted)]">
        Prices are listed in USD. Checkout converts to DeSo at the live rate.
      </p>

      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {services.length === 0 ? (
          <p className="col-span-full text-center text-[var(--muted)]">
            No plans available yet. Check back soon!
          </p>
        ) : (
          services.map((s) => {
            const previewNanos = s.pricePreviewNanos ?? s.priceNanos ?? 0;
            return (
            <div
              key={s.id}
              className="flex flex-col rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-6 transition hover:border-[var(--accent)]/50"
            >
              <h3 className="text-xl font-semibold">{s.name}</h3>
              <p className="mt-2 flex-1 text-sm text-[var(--muted)]">
                {s.description}
              </p>
              <ul className="mt-4 space-y-2 text-sm">
                <li>{s.vcpu} vCPU</li>
                <li>{s.ram / 1024} GB Memory</li>
                <li>{s.storage} GB SSD</li>
              </ul>
              <div className="mt-6 flex flex-col gap-0.5">
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-[var(--accent)]">
                    {formatUsdCents(s.priceUsdCents)}
                  </span>
                  <span className="text-[var(--muted)]">/mo</span>
                </div>
                <span className="text-sm text-[var(--muted)]">
                  ≈ {formatDesoDisplay(previewNanos)} DESO/mo at current rate
                </span>
              </div>
              {user ? (
                <Link
                  href={`/services/${s.id}/order`}
                  className="mt-4 block rounded-lg bg-[var(--accent)] py-2.5 text-center font-medium text-[var(--background)] transition hover:bg-[var(--accent-muted)]"
                >
                  Order Now
                </Link>
              ) : (
                <p className="mt-4 text-center text-sm text-[var(--muted)]">
                  <Link href="/" className="text-[var(--accent)] hover:underline">
                    Login with DeSo
                  </Link>{" "}
                  to order
                </p>
              )}
            </div>
          );
          })
        )}
      </div>
    </div>
  );
}
