"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import Link from "next/link";
import type { VNCApi } from "@/components/VNCViewer";

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
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [showPasteFallback, setShowPasteFallback] = useState(false);
  const [pasteFallbackText, setPasteFallbackText] = useState("");
  const vncApiRef = useRef<VNCApi | null>(null);

  const onConnect = useCallback(() => {
    setLoading(false);
    setError(null);
  }, []);
  const onDisconnect = useCallback((msg: string) => setError(msg), []);
  const onError = useCallback((msg: string) => {
    setError(msg);
    setLoading(false);
  }, []);
  const onApiReady = useCallback((api: VNCApi | null) => {
    vncApiRef.current = api;
  }, []);
  const onClipboardFromGuest = useCallback(() => {
    setPasteStatus("Guest clipboard copied to your local clipboard");
  }, []);

  useEffect(() => {
    if (!pasteStatus) return;
    const t = setTimeout(() => setPasteStatus(null), 2500);
    return () => clearTimeout(t);
  }, [pasteStatus]);

  const sendPasteText = useCallback((text: string) => {
    const api = vncApiRef.current;
    if (!api) {
      setPasteStatus("Console isn't connected yet");
      return;
    }
    if (!text) {
      setPasteStatus("Clipboard is empty");
      return;
    }
    api.pasteText(text);
    const preview = text.length > 20 ? `${text.slice(0, 20)}…` : text;
    setPasteStatus(`Pasted ${text.length} character${text.length === 1 ? "" : "s"}: ${preview}`);
  }, []);

  const handlePaste = useCallback(async () => {
    if (!vncApiRef.current) {
      setPasteStatus("Console isn't connected yet");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      sendPasteText(text);
    } catch {
      // Browser blocked clipboard read (permissions or insecure context) —
      // fall back to a modal where the user can paste manually.
      setPasteFallbackText("");
      setShowPasteFallback(true);
    }
  }, [sendPasteText]);

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
          <span className="hidden truncate px-2 text-center text-xs text-[var(--muted)] sm:inline sm:text-sm">
            VNC Console
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handlePaste}
              className="rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--background)]/70 sm:text-sm"
              title="Paste your local clipboard into the console (typed as keystrokes for TTY guests)"
            >
              Paste
            </button>
            <button
              type="button"
              onClick={() => setMaximized((m) => !m)}
              className="rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--background)]/70 sm:text-sm"
              aria-pressed={maximized}
              title={maximized ? "Shrink to window" : "Use full screen"}
            >
              {maximized ? "Restore" : "Maximize"}
            </button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col bg-black">
          <VNCViewer
            orderId={orderId}
            publicKey={user.publicKey}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onError={onError}
            onApiReady={onApiReady}
            onClipboardFromGuest={onClipboardFromGuest}
            debug={debug}
          />
          {pasteStatus && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-[3] -translate-x-1/2 rounded-md border border-[var(--card-border)] bg-black/80 px-3 py-1.5 text-xs text-[var(--foreground)] shadow-lg">
              {pasteStatus}
            </div>
          )}
          {showPasteFallback && (
            <div className="absolute inset-0 z-[4] flex items-center justify-center bg-black/80 p-4">
              <div className="w-full max-w-md rounded-xl border border-[var(--card-border)] bg-[var(--card)] p-4 shadow-2xl">
                <h3 className="mb-2 text-sm font-semibold text-[var(--foreground)]">
                  Paste text into console
                </h3>
                <p className="mb-3 text-xs text-[var(--muted)]">
                  Your browser blocked automatic clipboard access. Paste your text below
                  and press Send — it will be typed into the console.
                </p>
                <textarea
                  autoFocus
                  value={pasteFallbackText}
                  onChange={(e) => setPasteFallbackText(e.target.value)}
                  rows={6}
                  className="w-full resize-y rounded-md border border-[var(--card-border)] bg-[var(--background)]/40 p-2 font-mono text-xs text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                  placeholder="Paste with Ctrl/⌘+V here…"
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowPasteFallback(false)}
                    className="rounded-lg border border-[var(--card-border)] bg-[var(--background)]/40 px-3 py-1 text-xs text-[var(--foreground)] hover:bg-[var(--background)]/70"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const text = pasteFallbackText;
                      setShowPasteFallback(false);
                      setPasteFallbackText("");
                      sendPasteText(text);
                    }}
                    disabled={!pasteFallbackText}
                    className="rounded-lg border border-[var(--accent)] bg-[var(--accent)]/20 px-3 py-1 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/30 disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          )}
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
