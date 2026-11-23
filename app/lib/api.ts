/**
 * Returns the backend base URL.
 * When accessed from another device on the network, uses the same hostname
 * as the frontend so API calls reach this machine's backend.
 */
export function getBackendUrl(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:8002";
  const host = window.location.hostname;
  // Use 127.0.0.1 instead of "localhost" — Windows resolves localhost to IPv6
  // (::1) first, fails, then falls back to IPv4, adding a ~2s delay per request.
  const resolved = host === "localhost" ? "127.0.0.1" : host;
  return `http://${resolved}:8002`;
}
