"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";

const VNCViewer = dynamic(() => import("@/components/VNCViewer").then((m) => m.VNCViewer), {
  ssr: false,
});

export default function ConsolePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const debug = searchParams.get("debug") === "1";
  const [error, setError] = useState<string | null>(null);

  const onConnect = useCallback(() => {
    setLoading(false);
    setError(null);
  }, []);
  const onDisconnect = useCallback((msg: string) => setError(msg), []);
  const onError = useCallback((msg: string) => {
    setError(msg);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!user) router.push("/");
  }, [user, router]);

  if (!user) return null;

  const orderId = String(params.orderId);

  return (
    <div
      className={
        maximized
          ? "fixed inset-0 z-50 flex flex-col bg-black pt-[env(safe-area-inset-top)]"
          : "fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:p-6"
      }
    >
      <div
        className={
          maximized
            ? "flex h-full min-h-0 w-full min-w-0 flex-col"
            : "flex h-[min(78vh,640px)] w-full max-w-[880px] min-h-[280px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--card-border)] bg-[var(--card)] shadow-2xl shadow-black/40"
        }
      >
        <div className="flex shrink-0 min-h-11 items-center justify-between gap-2 border-b border-[var(--card-border)] bg-[var(--card)] px-3 py-2 sm:px-4">
          <Link
            href="/dashboard"
            className="min-w-0 shrink text-sm text-[var(--accent)] hover:underline"
          >
            ← Dashboard
          </Link>
          <span className="truncate px-2 text-center text-xs text-[var(--muted)] sm:text-sm">
            VNC Console
          </span>
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            className="shrink-0 rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--background)]/70 sm:text-sm"
            aria-pressed={maximized}
            title={maximized ? "Shrink to window" : "Use full screen"}
          >
            {maximized ? "Restore" : "Maximize"}
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col bg-black">
          <VNCViewer
            orderId={orderId}
            publicKey={user.publicKey}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onError={onError}
            debug={debug}
          />
          {loading && (
            <div className="absolute inset-0 z-[1] flex items-center justify-center bg-black/80">
              <p className="text-[var(--muted)]">Connecting to console...</p>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-4 bg-black/90 p-6">
              <p className="font-medium text-red-400">{error}</p>
              <div className="flex gap-4">
                <Link
                  href={`/dashboard/${orderId}/console?debug=1`}
                  className="text-sm text-[var(--accent)] hover:underline"
                >
                  Retry with debug
                </Link>
                <Link
                  href="/dashboard"
                  className="text-sm text-[var(--accent)] hover:underline"
                >
                  Back to Dashboard
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
