/**
 * Public PayPal SDK configuration.
 *
 * Serves the JS SDK the correct `client-id` (and env) for the currently
 * configured `PAYPAL_ENV`, so the browser can load the SDK against the same
 * PayPal environment (sandbox/live) that the server is issuing Plan ids for.
 *
 * Without this, a `NEXT_PUBLIC_PAYPAL_CLIENT_ID` baked into the client bundle
 * that doesn't match `PAYPAL_ENV` on the server causes RESOURCE_NOT_FOUND
 * during checkout — the SDK looks up a plan in the wrong PayPal environment.
 *
 * Safe to call unauthenticated: the values here are the *public* client id
 * (which PayPal itself embeds in every SDK URL) and the env label — no
 * secrets or webhook ids are ever included.
 */

import { NextResponse } from "next/server";
import {
  paypalEnv,
  paypalIsConfigured,
  paypalPublicClientId,
} from "@/lib/paypal";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!paypalIsConfigured()) {
    return NextResponse.json(
      { configured: false, clientId: "", env: null },
      { status: 200 }
    );
  }
  const clientId = paypalPublicClientId();
  if (!clientId) {
    return NextResponse.json(
      { configured: false, clientId: "", env: paypalEnv() },
      { status: 200 }
    );
  }
  return NextResponse.json(
    {
      configured: true,
      clientId,
      env: paypalEnv(),
    },
    { status: 200 }
  );
}
