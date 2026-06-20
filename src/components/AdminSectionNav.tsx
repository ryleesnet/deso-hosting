"use client";

const SECTIONS = [
  { id: "admin-orders", label: "Orders" },
  { id: "admin-import", label: "Import VM" },
  { id: "admin-services", label: "Services" },
  { id: "admin-host", label: "Host config" },
  { id: "admin-ips", label: "Public IPs" },
  { id: "admin-admins", label: "Admins" },
] as const;

export function AdminSectionNav() {
  return (
    <nav
      aria-label="Admin sections"
      className="sticky top-0 z-30 -mx-4 mt-8 border-b border-[var(--card-border)] bg-[var(--background)]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      <ul className="flex flex-wrap gap-2">
        {SECTIONS.map(({ id, label }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className="inline-flex rounded-lg border border-[var(--card-border)] bg-[var(--card)]/40 px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--card)]"
            >
              {label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
