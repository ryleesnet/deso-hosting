import Link from "next/link";

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mt-auto border-t border-[var(--card-border)] bg-[var(--card)]/30 py-8 text-center text-sm text-[var(--muted)]">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-3 px-4 sm:flex-row sm:justify-center sm:gap-6 sm:px-6 lg:px-8">
        <Link href="/terms" className="text-[var(--accent)] hover:underline">
          Terms of Service &amp; AUP
        </Link>
        <span className="hidden text-[var(--card-border)] sm:inline" aria-hidden>
          ·
        </span>
        <span>© {year} DeSoHosting</span>
      </div>
    </footer>
  );
}
