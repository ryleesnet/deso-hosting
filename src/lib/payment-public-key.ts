/**
 * DeSo public key that receives hosting / renewal payments (server + client).
 */
export function getDesoPaymentRecipientPublicKey(): string {
  return (
    process.env.DESO_PAYMENT_PUBLIC_KEY?.trim() ||
    process.env.NEXT_PUBLIC_DESO_PAYMENT_PUBLIC_KEY?.trim() ||
    ""
  );
}
