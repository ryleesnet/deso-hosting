# DeSoHosting

A modern VPS hosting panel for DeSo (Decentralized Social) users. Pay with DeSo, control your Proxmox VE servers.

## Features

- **DeSo Login** – Sign in with your DeSo account (no passwords)
- **VPS Ordering** – Plans priced in USD; pay in DeSo at checkout (both shown on confirmation)
- **VPS Control** – Start, Stop, Restart, Force Restart
- **VNC Console** – Access your VM console in the browser
- **Admin Panel** – Add/edit/remove services, provision orders
- **Monthly Subscriptions** – DeSo-based recurring payments

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` in this project directory and fill in values (the dev server loads `.env` from the project root):

```bash
cp .env.example .env
```

**Proxmox VE:**
- `PROXMOX_HOST` – Your Proxmox server hostname (must be reachable from the browser for console)
- `PROXMOX_PORT` – Usually 8006
- `PROXMOX_USERNAME` – e.g. `root@pam`
- `PROXMOX_PASSWORD` – Or use `PROXMOX_TOKEN_ID` + `PROXMOX_TOKEN_SECRET` for API token auth

**DeSo:**
- `DESO_PAYMENT_PUBLIC_KEY` – Your DeSo public key for receiving payments
- `NEXT_PUBLIC_DESO_PAYMENT_PUBLIC_KEY` – Same (for client-side payment flow)
- `ADMIN_PUBLIC_KEYS` – Comma-separated DeSo public keys for admin access
- `NEXT_PUBLIC_ADMIN_PUBLIC_KEYS` – Same (for client-side admin check)
- `DESO_USD_PRICE` – Optional. Fixed **USD per 1 DESO** for conversion (e.g. `12.50`). If unset, the app reads **`USDCentsPerDeSoExchangeRate`** from the DeSo node’s **`GET /api/v0/get-exchange-rate`** (same host as `NEXT_PUBLIC_DESO_NODE_URI` / `DESO_NODE_URI`, default `https://node.deso.org`).
- `DESO_NODE_URI` – Optional. Backend base URL for the exchange-rate request (no trailing slash). Defaults to `NEXT_PUBLIC_DESO_NODE_URI` or `https://node.deso.org`.
- `NEXT_PUBLIC_MAX_MONTHLY_PAYMENT_NANOS` / `NEXT_PUBLIC_IDENTITY_GLOBAL_DESO_LIMIT_NANOS` – Raise if your priciest plan (in DeSo, after USD conversion) exceeds the default Identity spending cap.

### 3. Run development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Proxmox API

Uses the [Proxmox VE API](https://pve.proxmox.com/wiki/Proxmox_VE_API):

- Ticket or API token authentication
- VM control: start, stop, shutdown, reboot, reset
- VNC proxy for console access

## DeSo Integration

- [DeSo Identity](https://docs.deso.org/deso-identity/window-api/basics) for login
- [deso-protocol](https://www.npmjs.com/package/deso-protocol) for payments
- **Catalogue prices** are stored as **USD cents per month** (`priceUsdCents`). At checkout, `GET /api/pricing/quote` converts to **nanos** using `DESO_USD_PRICE` if set, otherwise the **DeSo node** `get-exchange-rate` endpoint (cached ~1 minute server-side). The order page shows **USD and DeSo** before payment.
- `sendDeso` for one-time payments; subscriptions snapshot **DeSo nanos** when the subscription is created (from the same USD catalogue price at that moment).

## Console Access

The VNC console connects from the browser to your Proxmox server. Ensure:

1. `PROXMOX_HOST` is reachable from the client (use a public hostname if Proxmox is behind a firewall)
2. Or set up a WebSocket reverse proxy (e.g. nginx) to proxy `wss://yourdomain.com/proxmox-ws` to Proxmox

## Data Storage

VPS plans, orders, and subscriptions are stored in **Cloud Firestore** via the Firebase Admin SDK (`src/lib/db.ts`, `src/lib/firebase-admin.ts`).

**Environment:** Set credentials in `.env` (the dev server loads `.env` from the project root). Choose one of:

- **`FIREBASE_SERVICE_ACCOUNT_JSON`** — full service account JSON as a single line (or with escaped newlines in `private_key`).
- **`FIREBASE_PROJECT_ID`**, **`FIREBASE_CLIENT_EMAIL`**, **`FIREBASE_PRIVATE_KEY`** — separate fields; in `private_key`, use `\n` for newline breaks inside the string.
- **`GOOGLE_APPLICATION_CREDENTIALS`** — path to a service account JSON file on disk.

**Firestore collections:** `services`, `orders`, `subscriptions` (document ID = each record’s `id`), and **`public_ips`** (document ID = the IPv4 string, e.g. `68.122.49.208`).

**Public IPv4 pool:** Each address is one Firestore document with `status` (`available` \| `assigned` \| `reserved`), and when assigned: `userId`, `orderId`, `vmid`, `node`, `assignedAt`. Keep `PUBLIC_IP_GATEWAY` (and optional `PUBLIC_IP_PREFIX_LEN`, `PUBLIC_IP_DNS`) for cloud-init. Define which IPs exist by seeding from CIDR:

```bash
# PUBLIC_IP_POOL_CIDR + PUBLIC_IP_GATEWAY (+ optional PUBLIC_IP_EXTRA_EXCLUDE) in .env
npm run db:seed-public-ips
# Optionally align rows with orders that already have publicIpv4:
npm run db:seed-public-ips -- --sync-orders
```

You can also create or edit `public_ips` documents in the Firebase console (e.g. set `status: reserved` to hold addresses out of the automatic pool).

**Migrating from local JSON:** If you still have legacy `./data/*.json` files, run once after credentials work:

```bash
npm run db:migrate-json
```

Secure your Firestore with appropriate [security rules](https://firebase.google.com/docs/firestore/security/get-started) if you ever add client-side SDK access; this app only uses the Admin SDK on the server, so access is governed by your service account and IAM.

## Project Structure

```
src/
├── app/
│   ├── api/          # API routes
│   ├── admin/        # Admin panel
│   ├── dashboard/    # User dashboard + console
│   └── services/     # Service listing + order flow
├── components/
├── contexts/
└── lib/
    ├── db.ts         # Data layer
    ├── deso.ts       # DeSo auth & payments
    └── proxmox.ts    # Proxmox API client
```

## License

MIT
