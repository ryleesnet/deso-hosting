"use client";

export type BillingInfo = {
  nextPaymentAt: string;
  subscriptionStatus: string;
  daysRemainingInCycle: number;
};

function IconWrap({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--card-border)] text-[var(--accent)] [&>svg]:h-4 [&>svg]:w-4"
      aria-hidden
    >
      {children}
    </span>
  );
}

function CalendarIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5a2.25 2.25 0 0 0 2.25-2.25m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5a2.25 2.25 0 0 1 2.25 2.25v7.5"
      />
    </svg>
  );
}

export function BillingCycleSummary({
  billing,
  className,
}: {
  billing: BillingInfo | null;
  className?: string;
}) {
  if (!billing) {
    return (
      <p
        className={`mt-3 text-sm text-[var(--muted)]${className ? ` ${className}` : ""}`}
      >
        Monthly billing attaches once this VPS has an active subscription.
      </p>
    );
  }

  const n = billing.daysRemainingInCycle;
  const dayLabel =
    n === 0 ? "0 days — renewal due" : `${n} day${n === 1 ? "" : "s"} left in billing cycle`;

  const renewal = new Date(billing.nextPaymentAt);
  const renewalText = Number.isNaN(renewal.getTime())
    ? null
    : renewal.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });

  const overdue = billing.subscriptionStatus === "past_due";

  return (
    <ul
      className={`mt-3 flex flex-col gap-2.5${className ? ` ${className}` : ""}`}
      role="list"
    >
      <li className="flex items-center gap-3 text-sm">
        <IconWrap>
          <CalendarIcon />
        </IconWrap>
        <span>
          <span className="text-[var(--muted)]">Billing cycle:</span>{" "}
          <span
            className={
              overdue
                ? "font-medium text-orange-400"
                : "font-medium text-[var(--foreground)]"
            }
          >
            {dayLabel}
          </span>
          {renewalText ? (
            <span className="text-[var(--muted)]"> · Next renewal {renewalText}</span>
          ) : null}
        </span>
      </li>
    </ul>
  );
}
