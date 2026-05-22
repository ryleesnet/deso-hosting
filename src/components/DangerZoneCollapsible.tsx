"use client";

import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
};

/**
 * Collapsed-by-default destructive actions rail (dashboard).
 * Native disclosure — no JS state required.
 */
export function DangerZoneCollapsible({ children }: Props) {
  return (
    <details className="min-w-0 rounded-xl border border-red-500/30 bg-red-500/[0.06] [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-red-500/[0.08] focus-visible:ring-2 focus-visible:ring-red-400/35">
        <span className="text-sm font-semibold text-red-400">Danger Zone</span>
        <span className="text-xs text-[var(--muted)]">
          Reinstall · Delete VPS
        </span>
      </summary>
      <div className="border-t border-red-500/20 px-3 pb-3 pt-3">{children}</div>
    </details>
  );
}
