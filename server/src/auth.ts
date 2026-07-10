// Per-user key extraction + resolution for MCP requests. Kept separate from
// index.ts so it can be unit-tested without importing the Worker/MCP runtime.

/**
 * Pull a caller-supplied ko.io API key from the request, in priority order:
 *   1. Authorization: Bearer ko_...
 *   2. x-ko-api-key: ko_...
 *   3. ?api_key= / ?key= query param (DISCOURAGED -- see keyTransport(); kept for
 *      clients that genuinely cannot set headers)
 * Returns undefined when none is present.
 */
export function extractUserKey(req: Request): string | undefined {
  const auth = req.headers.get("Authorization");
  if (auth && /^Bearer\s+ko_/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const xkey = req.headers.get("x-ko-api-key");
  if (xkey && xkey.startsWith("ko_")) return xkey.trim();
  const sp = new URL(req.url).searchParams;
  const qp = sp.get("api_key") || sp.get("key");
  if (qp && qp.startsWith("ko_")) return qp.trim();
  return undefined;
}

/**
 * Which transport carried the API key. A key in a URL query param leaks into
 * browser history, Referer headers, and proxy/CDN access logs, so we keep
 * supporting it (some MCP clients can't set headers) but surface a warning
 * header instead of silently accepting it. Header transports are preferred.
 */
export function keyTransport(req: Request): "header" | "query" | "none" {
  const auth = req.headers.get("Authorization");
  if (auth && /^Bearer\s+ko_/i.test(auth)) return "header";
  const xkey = req.headers.get("x-ko-api-key");
  if (xkey && xkey.startsWith("ko_")) return "header";
  const sp = new URL(req.url).searchParams;
  const qp = sp.get("api_key") || sp.get("key");
  if (qp && qp.startsWith("ko_")) return "query";
  return "none";
}

/**
 * Resolve the API key the MCP server will pass to ko-api. A missing user key
 * resolves to "" -> koFetch uses demo mode (free tier, rate-limited). There is
 * intentionally NO deployment-key fallback: that would let anonymous MCP traffic
 * spend a shared paid quota un-metered.
 */
export function resolveApiKey(userApiKey: string | undefined): string {
  return userApiKey || "";
}
