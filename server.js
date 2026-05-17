/**
 * Custom Next.js server with WebSocket proxy for Proxmox VNC console.
 * The browser cannot connect directly to Proxmox wss:// due to self-signed cert.
 * This proxy accepts ws:// from the client (same origin) and forwards to Proxmox.
 *
 * Auth: PVE API token (PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET) plus the `vncticket`
 * URL parameter from POST /vncproxy. With the `binary` subprotocol, PVE authenticates
 * at the HTTP upgrade and the first frame is real RFB data — DO NOT send a
 * "<user>:<vncticket>" first-frame handshake; PVE would relay it to QEMU as VNC bytes
 * and corrupt the protocol (QEMU closes, you see "RFB ..." then 1006).
 */
require("dotenv").config({ path: require("path").join(process.cwd(), ".env") });

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");
const { consumeConsoleToken } = require("./src/lib/console-tokens.js");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const PROXMOX_WS_HOST =
  process.env.PROXMOX_CONSOLE_HOST || process.env.PROXMOX_HOST || "localhost";
const PROXMOX_PORT = process.env.PROXMOX_PORT || "8006";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const server = createServer((req, res) => {
  const parsedUrl = parse(req.url, true);
  handle(req, res, parsedUrl);
});

app.prepare().then(async () => {
  // Proxmox's vncwebsocket requires the `binary` subprotocol; offer it on both legs.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has("binary") ? "binary" : false,
  });
  const nextUpgradeHandler = app.getUpgradeHandler();

  server.on("upgrade", (req, socket, head) => {
    const { pathname, query } = parse(req.url || "", true);
    if (pathname !== "/api/proxmox-ws" || !query.token) {
      if (pathname && pathname.startsWith("/_next/")) {
        nextUpgradeHandler(req, socket, head).catch((err) => {
          console.error("[server.js] Next.js upgrade error:", err?.message);
          socket.destroy();
        });
      } else {
        socket.destroy();
      }
      return;
    }

    const rawToken = Array.isArray(query.token) ? query.token[0] : query.token;
    const tokenData = consumeConsoleToken(rawToken);
    if (!tokenData) {
      console.log("[Proxmox WS proxy] Token invalid or expired");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const { ticket: vncTicket, port: vncPort, node, vmid } = tokenData;
    const tokenId = process.env.PROXMOX_TOKEN_ID;
    const tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
    if (!tokenId || !tokenSecret) {
      console.log("[Proxmox WS proxy] Missing PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET");
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    const targetUrl = `wss://${PROXMOX_WS_HOST}:${PROXMOX_PORT}/api2/json/nodes/${node}/qemu/${vmid}/vncwebsocket?port=${vncPort}&vncticket=${encodeURIComponent(vncTicket)}`;
    console.log(
      "[Proxmox WS proxy] Connecting to:",
      targetUrl.replace(/vncticket=[^&]+/, "vncticket=...")
    );

    try {
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const https = require("https");
        const WebSocket = require("ws");

        const proxmoxHost = process.env.PROXMOX_HOST || "localhost";
        const wsOpts = {
          rejectUnauthorized: false,
          agent: new https.Agent({ rejectUnauthorized: false }),
          handshakeTimeout: 15000,
          perMessageDeflate: false,
          headers: {
            Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
          },
        };
        // TLS SNI: cert is for FQDN, but we may connect to PROXMOX_CONSOLE_HOST (IP).
        if (PROXMOX_WS_HOST !== proxmoxHost) {
          wsOpts.servername = proxmoxHost;
        }

        // Proxmox's vncwebsocket expects the `binary` subprotocol; without it the relay
        // closes immediately after sending QEMU's first RFB version line (1006 abnormal).
        const proxmoxWs = new WebSocket(targetUrl, ["binary"], wsOpts);
        const clientBuffer = [];
        let proxmoxReady = false;
        let clientClosedFirst = false;
        let clientMsgCount = 0;
        let upForwardCount = 0;
        let downForwardCount = 0;

        const toBinary = (d) => {
          if (Buffer.isBuffer(d)) return d;
          if (d instanceof ArrayBuffer) return Buffer.from(d);
          if (ArrayBuffer.isView(d)) {
            return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
          }
          if (typeof d === "string") return Buffer.from(d, "utf8");
          return Buffer.alloc(0);
        };

        const forwardClientToProxmox = (raw) => {
          if (proxmoxWs.readyState !== WebSocket.OPEN) return;
          const buf = toBinary(raw);
          upForwardCount++;
          if (upForwardCount <= 4) {
            console.log(
              "[Proxmox WS proxy] client->PVE msg",
              upForwardCount,
              "len:",
              buf.length,
              "hex:",
              buf.slice(0, 48).toString("hex")
            );
          }
          // After the username:vncticket handshake, the rest of the VNC protocol is binary.
          // Always forward as a binary frame so QEMU's VNC server gets the bytes verbatim.
          proxmoxWs.send(buf, { binary: true });
        };

        const flushBuffer = () => {
          if (!proxmoxReady) return;
          while (clientBuffer.length) {
            forwardClientToProxmox(clientBuffer.shift());
          }
        };

        clientWs.on("message", (data) => {
          clientMsgCount++;
          if (clientMsgCount <= 3) {
            const len = Buffer.isBuffer(data)
              ? data.length
              : data?.byteLength ?? Buffer.byteLength(String(data));
            console.log(
              "[Proxmox WS proxy] From browser, msg#",
              clientMsgCount,
              "len:",
              len
            );
          }
          if (proxmoxReady) {
            forwardClientToProxmox(data);
          } else {
            clientBuffer.push(data);
          }
        });

        proxmoxWs.on("open", () => {
          // The vncticket in the URL already authenticated us; the WS is now a transparent
          // VNC tunnel for QEMU. Anything we inject here would corrupt the RFB stream.
          proxmoxReady = true;
          console.log(
            "[Proxmox WS proxy] Upgrade OK; subprotocol:",
            proxmoxWs.protocol || "(none)",
            "buffered client frames:",
            clientBuffer.length
          );
          flushBuffer();
        });

        proxmoxWs.on("message", (data) => {
          downForwardCount++;
          if (downForwardCount === 1) {
            const buf = toBinary(data);
            console.log(
              "[Proxmox WS proxy] First message from Proxmox, len:",
              buf.length,
              "hex:",
              buf.slice(0, 48).toString("hex")
            );
          }
          // noVNC reads with `new Uint8Array(e.data)` which only works for binary frames.
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(toBinary(data), { binary: true });
          }
        });

        proxmoxWs.on("error", (err) => {
          const msg = err?.message || String(err);
          if (
            clientClosedFirst &&
            msg.includes("closed before the connection was established")
          ) {
            return;
          }
          console.error("[Proxmox WS proxy] Proxmox error:", msg, "code:", err?.code);
          clientWs.close();
        });

        proxmoxWs.on("close", (code, reason) => {
          if (!clientClosedFirst) {
            console.log(
              "[Proxmox WS proxy] Proxmox closed:",
              code,
              reason?.toString() || "",
              "(forwarded:",
              downForwardCount,
              "frames)"
            );
          }
          clientWs.close();
        });

        clientWs.on("error", (err) => {
          console.error("[Proxmox WS proxy] Client error:", err.message);
          proxmoxWs.close();
        });

        clientWs.on("close", () => {
          clientClosedFirst = true;
          proxmoxWs.close();
        });
      });
    } catch (err) {
      console.error("[Proxmox WS proxy] Error:", err);
      socket.destroy();
    }
  });

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
    console.log(`> VNC proxy: ws://${hostname}:${port}/api/proxmox-ws`);
    console.log(`> [Proxmox WS proxy] Listening for WebSocket upgrades`);
  });
});
