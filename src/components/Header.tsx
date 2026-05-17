"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import { desoProfilePictureUrl } from "@/lib/deso";

/** Base shell matching the DESO price pill; hover lifts toward a lighter (whiter) surface. */
const HEADER_PILL_SHELL =
  "rounded-xl border border-[var(--card-border)] bg-[var(--card)]/40 px-3 py-2 text-sm transition hover:bg-[color-mix(in_srgb,var(--card)_82%,white_18%)]";

function UserMenu({
  picUrl,
  displayName,
  publicKey,
  isAdmin,
  onLogout,
}: {
  picUrl: string;
  displayName: string | undefined;
  publicKey: string;
  isAdmin: boolean;
  onLogout: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const handleLabel =
    displayName != null && displayName !== ""
      ? `@${displayName}`
      : `Account ${publicKey.slice(0, 8)}…`;

  const menuButtonLabel = `Account menu, ${handleLabel}`;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const el = rootRef.current;
      if (el && !el.contains(e.target as Node)) close();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        className={`flex max-w-full items-center gap-2 py-1.5 pl-1.5 pr-2.5 text-left ${HEADER_PILL_SHELL}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-label={menuButtonLabel}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={picUrl}
          alt=""
          width={32}
          height={32}
          className="h-8 w-8 shrink-0 rounded-full border border-[var(--card-border)] object-cover sm:h-9 sm:w-9"
        />
        <span
          className="min-w-0 max-w-[5.5rem] truncate text-sm font-medium text-[var(--foreground)] sm:max-w-[10rem] md:max-w-[14rem]"
          title={handleLabel}
        >
          {displayName != null && displayName !== "" ? (
            <>@{displayName}</>
          ) : (
            <span className="font-mono text-xs font-normal text-[var(--muted)]">
              {publicKey.slice(0, 8)}…{publicKey.slice(-4)}
            </span>
          )}
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-[var(--muted)] transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-[60] mt-1 min-w-[10rem] rounded-xl border border-[var(--card-border)] bg-[var(--background)] py-1 shadow-lg"
        >
          {isAdmin && (
            <Link
              href="/admin"
              role="menuitem"
              className="flex w-full items-center px-3 py-2 text-left text-sm font-medium text-[var(--accent)] transition hover:bg-[var(--card)] hover:text-[var(--accent-muted)]"
              onClick={close}
            >
              Admin
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center px-3 py-2 text-left text-sm text-[var(--foreground)] transition hover:bg-[var(--card)]"
            onClick={() => {
              void onLogout();
              close();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function HeaderDesoPrice() {
  const [desoFormatted, setDesoFormatted] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/pricing/deso-rate")
        .then((r) => r.json())
        .then(
          (data: {
            formatted?: string;
            error?: string;
          }) => {
            if (cancelled) return;
            if (typeof data.formatted === "string") {
              setDesoFormatted(data.formatted);
            } else {
              setDesoFormatted(null);
            }
          }
        )
        .catch(() => {
          if (!cancelled) {
            setDesoFormatted(null);
          }
        });
    };
    load();
    const id = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!desoFormatted) return null;

  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2 sm:flex-nowrap">
      <span
        className={`inline-flex max-w-full shrink-0 items-center text-[var(--muted)] ${HEADER_PILL_SHELL}`}
        title="Approximate USD price for 1 DESO (from your DeSo node)"
      >
        <span className="font-medium text-[var(--foreground)]">DESO</span>
        <span className="mx-2 text-[var(--card-border)]" aria-hidden>
          ·
        </span>
        <span className="font-semibold tabular-nums text-[var(--accent)]">
          {desoFormatted}
        </span>
      </span>
    </div>
  );
}

export function Header() {
  const { user, loading, login, logout, isAdmin } = useAuth();
  const displayName = user?.username?.replace(/^@/, "")?.trim();
  const picUrl = user?.publicKey
    ? desoProfilePictureUrl(user.publicKey, {
        fallbackDisplayName: displayName,
      })
    : null;

  return (
    <header className="sticky top-0 z-50 overflow-visible border-b border-[var(--card-border)] bg-[var(--background)]/95 backdrop-blur">
      <div className="mx-auto grid h-16 max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 justify-start">
          <Link
            href="/"
            className="flex items-center gap-2 text-xl font-bold tracking-tight"
          >
            <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent-muted)] bg-clip-text text-transparent">
              DeSoHosting
            </span>
          </Link>
        </div>

        <nav
          className="flex flex-wrap items-center justify-center gap-2 sm:gap-2"
          aria-label="Main"
        >
          {user && (
            <Link
              href="/dashboard"
              className={`inline-flex max-w-full shrink-0 items-center justify-center font-medium text-[var(--foreground)] ${HEADER_PILL_SHELL}`}
            >
              Dashboard
            </Link>
          )}
          <Link
            href="/services"
            className={`inline-flex max-w-full shrink-0 items-center justify-center font-medium text-[var(--foreground)] ${HEADER_PILL_SHELL}`}
          >
            New VM
          </Link>
        </nav>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
          <HeaderDesoPrice />
          {loading ? (
            <div className="h-10 w-24 shrink-0 animate-pulse rounded-xl bg-[var(--card)]" />
          ) : user && picUrl ? (
            <UserMenu
              picUrl={picUrl}
              displayName={displayName}
              publicKey={user.publicKey}
              isAdmin={isAdmin}
              onLogout={logout}
            />
          ) : (
            <button
              type="button"
              onClick={login}
              className={`inline-flex max-w-full shrink-0 items-center justify-center font-medium text-[var(--foreground)] ${HEADER_PILL_SHELL}`}
            >
              Login with DeSo
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
