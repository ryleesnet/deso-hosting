"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-client";

export interface VNCApi {
  /**
   * Send text to the console. Uses the RFB clipboard channel (for guests with a
   * clipboard agent) *and* types every character as keystrokes so it also works
   * for plain text consoles / TTYs.
   */
  pasteText: (text: string) => void;
}

interface VNCViewerProps {
  orderId: string;
  publicKey: string;
  onConnect: () => void;
  onDisconnect: (message: string) => void;
  onError: (message: string) => void;
  onApiReady?: (api: VNCApi | null) => void;
  onClipboardFromGuest?: (text: string) => void;
  debug?: boolean;
}

// Minimal subset of the novnc-next RFB API we rely on. novnc-next ships loose
// types, so we describe just what we call.
interface RFBLike {
  disconnect?: () => void;
  scaleViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  addEventListener: (event: string, listener: (...args: unknown[]) => void) => void;
  clipboardPasteFrom?: (text: string) => void;
  sendKey: (keysym: number, code?: string, down?: boolean) => void;
  focus?: () => void;
}

// X keysyms we need for control characters when typing pasted text.
const XK_Return = 0xff0d;
const XK_Tab = 0xff09;
const XK_BackSpace = 0xff08;
const XK_Escape = 0xff1b;

// Overall bounding-box (CSS pixels) of the fallback arrow cursor we draw when
// the guest doesn't provide one. Browsers typically render URL cursors up to
// ~128 px; 28 is roughly OS-cursor sized on a HiDPI display.
const ARROW_CURSOR_SIZE = 28;

// Build a classic top-left-pointing arrow cursor as an RGBA pixel array.
// The shape is drawn on an offscreen canvas from a polygon designed in a
// 24-unit grid, then scaled up to the requested size so it stays crisp.
function buildArrowCursorImage(size: number): {
  rgbaPixels: Uint8Array;
  w: number;
  h: number;
  hotx: number;
  hoty: number;
} {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // Extremely unlikely in a browser context; fall back to a single pixel.
    return {
      rgbaPixels: new Uint8Array([0, 0, 0, 255]),
      w: 1,
      h: 1,
      hotx: 0,
      hoty: 0,
    };
  }

  // Design in a 24-unit-wide coordinate system, then scale to `size`.
  const s = size / 24;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 2 * s;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Classic arrow polygon (top-left pointing) traced clockwise from the tip.
  // Vertices chosen so the tip is at (2, 2) in the 24-unit grid.
  ctx.beginPath();
  ctx.moveTo(2 * s, 2 * s); // tip
  ctx.lineTo(2 * s, 18 * s); // down along the back edge
  ctx.lineTo(7 * s, 14 * s); // inner joint at the base of the arrowhead
  ctx.lineTo(10.5 * s, 21.5 * s); // outside of the tail
  ctx.lineTo(13 * s, 20 * s); // opposite side of the tail
  ctx.lineTo(9.5 * s, 12.5 * s); // inner joint on the underside
  ctx.lineTo(16 * s, 12.5 * s); // far end of the arrowhead's diagonal
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  const imgData = ctx.getImageData(0, 0, size, size);
  return {
    rgbaPixels: new Uint8Array(imgData.data),
    w: size,
    h: size,
    hotx: Math.round(2 * s),
    hoty: Math.round(2 * s),
  };
}

export function VNCViewer({
  orderId,
  publicKey,
  onConnect,
  onDisconnect,
  onError,
  onApiReady,
  onClipboardFromGuest,
  debug: debugProp,
}: VNCViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBLike | null>(null);
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

    function pasteText(text: string) {
      const rfb = rfbRef.current;
      if (!rfb || !text) return;
      // Best-effort: also push into the RFB clipboard channel for guests that
      // have a clipboard agent running (e.g. spice-vdagent under X).
      try {
        rfb.clipboardPasteFrom?.(text);
      } catch {
        // clipboardPasteFrom is a no-op if not connected; ignore.
      }
      // Normalize line endings so a single Enter is sent per line.
      const normalized = text.replace(/\r\n?/g, "\n");
      for (const ch of normalized) {
        let keysym: number;
        let code = "";
        switch (ch) {
          case "\n":
            keysym = XK_Return;
            code = "Enter";
            break;
          case "\t":
            keysym = XK_Tab;
            code = "Tab";
            break;
          case "\b":
            keysym = XK_BackSpace;
            code = "Backspace";
            break;
          case "\x1b":
            keysym = XK_Escape;
            code = "Escape";
            break;
          default: {
            const cp = ch.codePointAt(0);
            if (cp === undefined) continue;
            // Basic Latin / Latin-1 map directly to X keysyms. Higher code
            // points use the Unicode-to-keysym convention (0x01000000 | cp).
            keysym = cp <= 0xff ? cp : 0x01000000 | cp;
          }
        }
        try {
          rfb.sendKey(keysym, code);
        } catch {
          // Ignore keys the current guest can't map; keep going.
        }
      }
    }

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
        // Replace noVNC's built-in 3x3 "dot" fallback with a normal-looking
        // arrow. RFB.cursors.dot is read every time noVNC refreshes the
        // cursor, so overriding the static value is enough to affect this
        // (and any subsequent) connection.
        const rfbStatics = RFB as unknown as {
          cursors?: { dot?: unknown };
        };
        if (rfbStatics.cursors) {
          rfbStatics.cursors.dot = buildArrowCursorImage(ARROW_CURSOR_SIZE);
        }

        const rfb = new RFB(containerRef.current!, wsUrl, {
          credentials: { password: vncPassword },
          // novnc-next reads this from options at runtime; types don't expose it.
          wsProtocols: ["binary"],
        } as ConstructorParameters<typeof RFB>[2]) as unknown as RFBLike & {
          approveServer: () => void;
        };
        rfbRef.current = rfb;
        rfb.scaleViewport = true;
        rfb.resizeSession = true;
        // Many guests (especially Linux TTYs and BIOS/boot screens) never send
        // cursor data, so noVNC hides the local cursor and leaves nothing in
        // its place. Enabling this makes noVNC draw our overridden fallback
        // (an arrow) whenever the guest doesn't supply a cursor.
        rfb.showDotCursor = true;

        rfb.addEventListener("connect", () => {
          if (!mounted) return;
          onConnect();
          onApiReady?.({ pasteText });
        });
        rfb.addEventListener("disconnect", (...args: unknown[]) => {
          const ev = args[0] as { detail?: { clean?: boolean } };
          alreadyDisconnected = true;
          onApiReady?.(null);
          if (mounted && !ev.detail?.clean) onDisconnect("Console disconnected unexpectedly");
        });
        rfb.addEventListener("securityfailure", (...args: unknown[]) => {
          const ev = args[0] as { detail?: { status?: string } };
          if (mounted) onError(`Security failure: ${ev.detail?.status || "unknown"}`);
        });
        rfb.addEventListener("serververification", () => rfb.approveServer());
        rfb.addEventListener("clipboard", (...args: unknown[]) => {
          if (!mounted) return;
          const ev = args[0] as { detail?: { text?: string } };
          const text = ev.detail?.text;
          if (typeof text !== "string" || text.length === 0) return;
          onClipboardFromGuest?.(text);
          if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).catch(() => {
              // Writing to the OS clipboard can fail when the tab isn't
              // focused or the browser withholds permission; that's fine,
              // the parent still gets the text through onClipboardFromGuest.
            });
          }
        });
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
      onApiReady?.(null);
      if (!alreadyDisconnected && rfbRef.current && typeof rfbRef.current.disconnect === "function") {
        rfbRef.current.disconnect();
      }
      rfbRef.current = null;
    };
  }, [orderId, publicKey, onConnect, onDisconnect, onError, onApiReady, onClipboardFromGuest, debug]);

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
