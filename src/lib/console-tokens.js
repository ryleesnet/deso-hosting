/**
 * Signed tokens for VNC console proxy.
 * Uses HMAC so the token works across processes (API route vs custom server).
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Loaded by bare Node (`server.js`) via require(); keep CommonJS. */

const crypto = require("crypto");

/**
 * HMAC secret for console-token signing. Required (no fallback) — a default would let
 * anyone mint a valid token and open a VNC tunnel to any VM via /api/proxmox-ws.
 * Set to a 32+ char random value (e.g. `openssl rand -hex 32`).
 */
const SECRET = process.env.CONSOLE_TOKEN_SECRET;
if (!SECRET || typeof SECRET !== "string" || SECRET.length < 32) {
  throw new Error(
    "CONSOLE_TOKEN_SECRET must be set to a 32+ character random value. " +
      "Generate one with `openssl rand -hex 32` and add it to .env."
  );
}
const TTL_MS = 60_000;

function createConsoleToken(ticket, port, node, vmid) {
  const payload = {
    ticket,
    port,
    node,
    vmid,
    exp: Date.now() + TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", SECRET)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

function consumeConsoleToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expectedSig = crypto
    .createHmac("sha256", SECRET)
    .update(payloadB64)
    .digest("base64url");
  if (sig !== expectedSig) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  if (
    !payload.ticket ||
    !payload.port ||
    !payload.node ||
    payload.vmid == null
  ) {
    return null;
  }
  return {
    ticket: payload.ticket,
    port: String(payload.port),
    node: payload.node,
    vmid: payload.vmid,
  };
}

module.exports = { createConsoleToken, consumeConsoleToken };
