export interface KoConfig {
  baseUrl: string;
  apiKey: string;
}

export interface KoFetchOptions {
  /** Override the default budget. Only for a call that legitimately needs longer. */
  timeoutMs?: number;
}

/**
 * How long this proxy will wait for api.ko.io before it gives up (ko-bastion#127).
 *
 * The number is calibrated, not guessed:
 *
 *   - p50 across the 24-tool surface is ~155 ms and the SLOWEST healthy call ever
 *     measured is 1,050 ms (`sec_get_filing_index` on a cache hit) --
 *     KO_MCP_TOOL_MATRIX_20260912.md. 20 s is ~129x the median and ~19x the
 *     slowest healthy call, so no working request can reach this bound.
 *   - The upstream ko-api route this tool proxies declares `timeoutMs: 30000`.
 *     Ours MUST fire first, or we inherit the route's failure instead of
 *     reporting our own: the measured worst case was 60,222 ms ending in a 502,
 *     twice the budget the route itself declares. 20 s leaves 10 s of margin for
 *     the api.ko.io geo-router hop.
 *
 * A bound below the upstream's is the whole point: the proxy must fail before
 * the thing it proxies, so the failure carries OUR name and not a 5xx that
 * looks like the upstream broke.
 */
export const KO_FETCH_TIMEOUT_MS = 20_000;

/**
 * Our budget was exhausted -- deliberately NOT an upstream error.
 *
 * A `ko.io API error (502)` means api.ko.io answered and said it was broken.
 * This means api.ko.io said nothing at all inside the window we were prepared
 * to wait, which is our limit being reached, not evidence that anything
 * upstream is down. The two must read differently to a model: one is "the data
 * source is having a problem", the other is "we stopped waiting". It surfaces
 * through the same `isError: true` envelope as every other thrown error,
 * because the MCP SDK renders a thrown error that way.
 */
export class KoTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly path: string;
  constructor(timeoutMs: number, path: string) {
    super(
      `ko.io MCP timeout (${timeoutMs}ms): no response from the ko.io API for ${path} within this ` +
      `proxy's budget. This is our own wait limit, not an upstream failure -- the request may still ` +
      `be in flight. Retry, or narrow the request.`,
    );
    this.name = "KoTimeoutError";
    this.timeoutMs = timeoutMs;
    this.path = path;
  }
}

/** True for the abort a timed-out `AbortSignal.timeout` raises (Workers and Node agree on the name). */
function isTimeoutAbort(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export async function koFetch<T = unknown>(
  config: KoConfig,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  options: KoFetchOptions = {}
): Promise<T> {
  const url = new URL(path, config.baseUrl);

  // When no API key, use demo mode
  if (!config.apiKey) {
    url.searchParams.set("demo", "true");
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "ko-mcp-worker/1.0",
  };

  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  // BOUNDED. Without this, an EDGAR miss that stalls upstream blocks the client
  // for as long as the network is willing to hold the socket open -- 60.2 s in
  // the ko-bastion#127 measurement -- and then surfaces as a 502, so the same
  // input could return either a 404 or a 5xx depending on nothing the caller
  // controls.
  const timeoutMs = options.timeoutMs ?? KO_FETCH_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (isTimeoutAbort(e)) throw new KoTimeoutError(timeoutMs, path);
    throw e;
  }

  if (!res.ok) {
    // Surface a generic, status-based message — do NOT pass through ko-api's raw
    // error body (could contain internal/upstream detail) to the model/user.
    // Prefer the structured { error: { message } } field if ko-api provided one.
    let detail = "";
    try {
      const j = await res.json() as { error?: { message?: string } };
      if (typeof j?.error?.message === "string") detail = `: ${j.error.message}`;
    } catch { /* non-JSON body — ignore */ }
    const generic: Record<number, string> = {
      400: "Bad request", 401: "Authentication required", 403: "Access forbidden (check your plan)",
      404: "Not found", 429: "Rate limit exceeded", 500: "Upstream error", 502: "Upstream error", 503: "Service unavailable",
    };
    throw new Error(`ko.io API error (${res.status}): ${generic[res.status] ?? "Request failed"}${detail}`);
  }

  const json = await res.json() as Record<string, unknown>;
  // ko-api wraps responses in { data: ..., meta: ... } — unwrap automatically
  return (json.data !== undefined ? json.data : json) as T;
}
