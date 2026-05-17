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

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between border-b border-[var(--card-border)] bg-[var(--card)] px-4 py-2">
        <Link
          href="/dashboard"
          className="text-sm text-[var(--accent)] hover:underline"
        >
          ← Back to Dashboard
        </Link>
        <span className="text-sm text-[var(--muted)]">VNC Console</span>
      </div>
      {user && (
        <VNCViewer
          orderId={String(params.orderId)}
          publicKey={user.publicKey}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onError={onError}
          debug={debug}
        />
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <p className="text-[var(--muted)]">Connecting to console...</p>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/90 p-6">
          <p className="text-red-400 font-medium">{error}</p>
          <div className="flex gap-4">
            <Link
              href={`/dashboard/${params.orderId}/console?debug=1`}
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
  );
}
