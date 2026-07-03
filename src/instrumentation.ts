/**
 * Server startup hook — runs billing dunning on an interval while the Node process lives.
 * External cron (`POST /api/cron/billing-dunning`) remains supported for multi-instance setups.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.BILLING_DUNNING_DISABLE === "1") return;

  const raw = process.env.BILLING_DUNNING_INTERVAL_MS?.trim();
  const parsed = raw ? parseInt(raw, 10) : 3_600_000;
  const intervalMs =
    Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 3_600_000;

  const { runBillingDunning } = await import("@/lib/order-lifecycle");

  void runBillingDunning().catch((err) => {
    console.error("[instrumentation] initial billing dunning failed:", err);
  });

  setInterval(() => {
    void runBillingDunning().catch((err) => {
      console.error("[instrumentation] periodic billing dunning failed:", err);
    });
  }, intervalMs);

  console.info(
    `[instrumentation] billing dunning scheduled every ${Math.round(intervalMs / 60_000)} min`
  );
}
