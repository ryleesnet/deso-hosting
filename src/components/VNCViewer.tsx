"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

interface VNCViewerProps {
  orderId: string;
  publicKey: string;
  onConnect: () => void;
  onDisconnect: (message: string) => void;
  onError: (message: string) => void;
  debug?: boolean;
}

export function VNCViewer({ orderId, publicKey, onConnect, onDisconnect, onError, debug: debugProp }: VNCViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<unknown>(null);
  const debugWsRef = useRef<WebSocket | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const debug = !!debugProp;

  const log = (msg: string) => {
    console.log("[VNC debug]", msg);
    setDebugLog((prev) => [...prev.slice(-19), msg]);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    let mounted = true;
    let connectTimeout: ReturnType<typeof setTimeout> | null = null;
    let alreadyDisconnected = false;

    async function connect() {
      try {
        const res = await apiFetch(`/api/vm/${orderId}/console`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.detail || data.error);
        const proxyPath = data.proxyPath;
        if (!proxyPath) throw new Error("Invalid console data");
        // PVE's vncticket is also the password QEMU's VNC server expects in the
        // RFB security handshake (DES-encrypted). Without it the console connects
        // through the WebSocket, then disconnects right after the auth response.
        const vncPassword: string =
          typeof data.vncPassword === "string" ? data.vncPassword : "";

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}${proxyPath}`;

        if (!mounted) return;

        if (debug) {
          log("Connecting to proxy...");
          let msgCount = 0;
          const ws = new WebSocket(wsUrl, "binary");
          debugWsRef.current = ws;
          ws.binaryType = "arraybuffer";
          ws.onopen = () => log("WebSocket OPEN");
          ws.onmessage = (e) => {
            if (!mounted) return;
            msgCount++;
            const d = e.data;
            const len = d instanceof ArrayBuffer ? d.byteLength : typeof d === "string" ? d.length : 0;
            const preview =
              d instanceof ArrayBuffer
                ? new TextDecoder().decode(new Uint8Array(d).slice(0, 30))
                : typeof d === "string"
                  ? d.slice(0, 30)
                  : "[?]";
            log(`RECV #${msgCount} (${len}b): "${preview.replace(/[\r\n]/g, "\\n")}"`);
            // Echo RFB version back to complete handshake (minimal RFB client)
            if (msgCount === 1 && preview.startsWith("RFB ")) {
              const bytes =
                d instanceof ArrayBuffer
                  ? new Uint8Array(d)
                  : new TextEncoder().encode(String(d));
              ws.send(bytes);
              log("SENT: RFB version echo (binary frame)");
            }
          };
          ws.onclose = (e) => mounted && log(`CLOSED code=${e.code} reason=${e.reason || "(none)"}`);
          ws.onerror = () => mounted && log("ERROR");
          return;
        }

        const RFB = (await import("novnc-next")).default;
        const rfb = new RFB(containerRef.current!, wsUrl, {
          credentials: { password: vncPassword },
          // novnc-next reads this from options at runtime; types don't expose it.
          wsProtocols: ["binary"],
        } as ConstructorParameters<typeof RFB>[2]);
        rfbRef.current = rfb;
        rfb.scaleViewport = true;
        rfb.resizeSession = true;

        rfb.addEventListener("connect", () => mounted && onConnect());
        rfb.addEventListener("disconnect", (...args: unknown[]) => {
          const ev = args[0] as { detail?: { clean?: boolean } };
          alreadyDisconnected = true;
          if (mounted && !ev.detail?.clean) onDisconnect("Console disconnected unexpectedly");
        });
        rfb.addEventListener("securityfailure", (...args: unknown[]) => {
          const ev = args[0] as { detail?: { status?: string } };
          if (mounted) onError(`Security failure: ${ev.detail?.status || "unknown"}`);
        });
        rfb.addEventListener("serververification", () => rfb.approveServer());
      } catch (e) {
        if (mounted) onError(e instanceof Error ? e.message : "Failed to connect to console");
      }
    }

    // Delay connect to avoid Strict Mode double-mount: first mount unmounts before delay,
    // so we only fetch token + connect on the real mount.
    connectTimeout = setTimeout(() => {
      connectTimeout = null;
      connect();
    }, 150);

    return () => {
      mounted = false;
      if (connectTimeout) clearTimeout(connectTimeout);
      debugWsRef.current?.close();
      debugWsRef.current = null;
      if (!alreadyDisconnected && rfbRef.current && typeof (rfbRef.current as { disconnect?: () => void }).disconnect === "function") {
        (rfbRef.current as { disconnect: () => void }).disconnect();
      }
    };
  }, [orderId, publicKey, onConnect, onDisconnect, onError, debug]);

  return (
    <div className="relative flex-1">
      <div ref={containerRef} className="h-full w-full" />
      {debug && (
        <div className="absolute bottom-2 left-2 right-2 z-20 max-h-48 overflow-auto rounded border border-[var(--card-border)] bg-black/95 p-3 font-mono text-xs text-green-400">
          <div className="mb-1 text-[var(--muted)]">Debug (raw WebSocket):</div>
          {debugLog.length === 0 ? (
            <div>Connecting...</div>
          ) : (
            debugLog.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      )}
    </div>
  );
}
