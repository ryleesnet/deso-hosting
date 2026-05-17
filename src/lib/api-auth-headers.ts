/**
 * Shared (client + server safe) header name for the authenticated DeSo public key.
 *
 * Imported by both the server-side auth middleware ({@link "@/lib/api-auth"}) and the
 * browser fetch helper ({@link "@/lib/api-client"}); kept in its own module so the client
 * bundle never pulls in `next/server`.
 */
export const PUBLIC_KEY_HEADER = "x-deso-public-key";
