import Link from "next/link";

export default function Home() {
  return (
    <div className="relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(0,212,170,0.15),transparent)]" />

      <section className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            <span className="bg-gradient-to-r from-[var(--accent)] via-[var(--accent-muted)] to-[var(--accent)] bg-clip-text text-transparent">
              DeSoHosting
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--muted)]">
            VPS hosting powered by DeSo. Plans are priced in USD;
            checkout converts to DeSo at a live rate. Pay with your DeSo account
            and control your servers from anywhere—no credit cards required.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/services"
              className="rounded-xl bg-[var(--accent)] px-8 py-4 text-lg font-semibold text-[var(--background)] transition hover:bg-[var(--accent-muted)]"
            >
              View Plans
            </Link>
            <Link
              href="/dashboard"
              className="rounded-xl border border-[var(--card-border)] px-8 py-4 text-lg font-semibold transition hover:bg-[var(--card)]"
            >
              Dashboard
            </Link>
          </div>
        </div>

        <div className="mt-24 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: "DeSo Login",
              desc: "Sign in with your DeSo account. No passwords, no emails—just your keys.",
              icon: "🔐",
            },
            {
              title: "Pay with DeSo",
              desc: "Plans show USD for clarity; you pay in DeSo at checkout. Subscriptions stay aligned with the current DeSo price.",
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
      </section>
    </div>
  );
}
