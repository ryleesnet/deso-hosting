import Link from "next/link";

export default function Home() {
  return (
    <div className="relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(0,212,170,0.15),transparent)]" />

      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-24 lg:px-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl lg:text-7xl">
            <span className="bg-gradient-to-r from-[var(--accent)] via-[var(--accent-muted)] to-[var(--accent)] bg-clip-text text-transparent">
              DeSoHosting
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl px-1 text-base leading-relaxed text-[var(--muted)] sm:mt-6 sm:text-lg">
            VPS hosting powered by DeSo. Plans are priced in USD and you choose
            how to pay at checkout: DeSo, dUSDC (USD-pegged), or PayPal — whichever
            fits your workflow.
          </p>
          <div className="mt-8 flex w-full max-w-md flex-col items-stretch gap-3 px-2 sm:mx-auto sm:mt-10 sm:max-w-none sm:flex-row sm:items-center sm:justify-center sm:gap-4 sm:px-0">
            <Link
              href="/services"
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-[var(--accent)] px-6 py-3 text-base font-semibold text-[var(--background)] transition hover:bg-[var(--accent-muted)] sm:px-8 sm:py-4 sm:text-lg"
            >
              View Plans
            </Link>
            <Link
              href="/dashboard"
              className="inline-flex min-h-12 items-center justify-center rounded-xl border border-[var(--card-border)] px-6 py-3 text-base font-semibold transition hover:bg-[var(--card)] sm:px-8 sm:py-4 sm:text-lg"
            >
              Dashboard
            </Link>
          </div>
        </div>

        <div className="mt-16 grid gap-6 sm:mt-24 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: "DeSo Login",
              desc: "Sign in with your DeSo account. No passwords, no emails—just your keys.",
              icon: "🔐",
            },
            {
              title: "Pay your way",
              desc: "Plans show USD for clarity. Check out with DeSo, dUSDC, or PayPal — whichever you prefer. Subscriptions renew automatically or on-demand.",
              icon: "💎",
            },
            {
              title: "Full Control",
              desc: "Start, stop, restart your VPS. Access the console anytime.",
              icon: "🖥️",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-[var(--card-border)] bg-[var(--card)]/50 p-6 backdrop-blur"
            >
              <span className="text-3xl">{f.icon}</span>
              <h3 className="mt-4 text-xl font-semibold">{f.title}</h3>
              <p className="mt-2 text-[var(--muted)]">{f.desc}</p>
            </div>
          ))}
        </div>

        <section
          aria-labelledby="what-is-deso"
          className="mt-16 rounded-3xl border border-[var(--card-border)] bg-[var(--card)]/40 p-6 backdrop-blur sm:mt-24 sm:p-10"
        >
          <div className="grid gap-8 lg:grid-cols-5 lg:items-start">
            <div className="lg:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                Powered by DeSo
              </p>
              <h2
                id="what-is-deso"
                className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl"
              >
                What is DeSo?
              </h2>
              <p className="mt-4 leading-relaxed text-[var(--muted)]">
                DeSo (short for <span className="text-[var(--foreground)]">Decentralized Social</span>) is
                an open-source Layer-1 blockchain purpose-built for social apps
                and identity. Instead of one company owning your account and
                data, your DeSo Identity is a keypair you control — the same
                one that logs you into any of the 200+ apps built on DeSo.
              </p>
              <p className="mt-3 leading-relaxed text-[var(--muted)]">
                We use DeSo Identity so you can sign up and pay for a VPS with
                nothing but your DeSo account — no credit card, no email,
                no bank in the loop. Prefer a familiar checkout? We also accept
                PayPal.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="https://deso.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--background)] transition hover:bg-[var(--accent-muted)]"
                >
                  Learn more at deso.com
                  <span aria-hidden="true">→</span>
                </a>
                <a
                  href="https://identity.deso.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--card-border)] px-4 py-2.5 text-sm font-semibold transition hover:bg-[var(--card)]"
                >
                  Create a DeSo account
                </a>
              </div>
            </div>

            <ul className="grid gap-4 sm:grid-cols-2 lg:col-span-3">
              {[
                {
                  title: "You own your account",
                  desc: "Your DeSo keys are yours. No provider can freeze your login or silently deplatform your servers.",
                  icon: "🔑",
                },
                {
                  title: "One identity, every app",
                  desc: "The same DeSo Identity that pays for hosting also logs you into Diamond, Focus, Openfund, and the rest of the DeSo ecosystem.",
                  icon: "🪪",
                },
                {
                  title: "On-chain receipts",
                  desc: "Every payment and renewal is a public DeSo transaction you can verify yourself — no invoicing surprises.",
                  icon: "🧾",
                },
                {
                  title: "Low, predictable fees",
                  desc: "DeSo network fees are a fraction of a cent. Plans are quoted in USD and converted to DeSo (or dUSDC) at checkout.",
                  icon: "⚡",
                },
                {
                  title: "USD-pegged option",
                  desc: "Prefer stable pricing? Pay in dUSDC — a 1:1 USD-pegged DeSo token — and skip the exchange-rate drift entirely.",
                  icon: "💵",
                },
                {
                  title: "PayPal too",
                  desc: "Not into crypto? Pay with PayPal instead. Auto-renew subscriptions are handled directly through your PayPal account.",
                  icon: "🅿️",
                },
              ].map((b) => (
                <li
                  key={b.title}
                  className="rounded-2xl border border-[var(--card-border)] bg-[var(--background)]/40 p-5"
                >
                  <span className="text-2xl" aria-hidden="true">
                    {b.icon}
                  </span>
                  <h3 className="mt-3 text-base font-semibold">{b.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--muted)]">
                    {b.desc}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </section>
    </div>
  );
}
