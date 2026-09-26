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

/**
 * ko-api's `meta.softwall` block (ko-api src/middleware/softwall.ts
 * shapeResponse). Present ONLY for Free / keyless-demo callers while the soft
 * wall is enforced; a paid caller never sees it. It is the one place the plan's
 * effect on a 200 response is stated: which window was applied, whether the
 * keyless row cap cut the collection, and whether a next page needs sign-in.
 */
export interface SoftwallMeta {
  policy_version?: string;
  window_start?: string;
  window_end?: string;
  effective_period?: string;
  date_basis?: string;
  row_cap?: number;
  truncated?: boolean;
  returned?: number;
  /** "SIGNIN_REQUIRED" = page>1 is refused without a (free) API key. */
  continuation?: string;
}

/** The `meta` half of ko-api's `{ data, meta }` envelope. */
export interface KoMeta {
  total_count?: number | string;
  page?: number;
  per_page?: number;
  softwall?: SoftwallMeta;
  [key: string]: unknown;
}

export interface KoEnvelope<T> {
  data: T;
  meta: KoMeta;
}

/**
 * Accept either a `{ data, meta }` envelope (what `koFetch(..., { envelope:
 * true })` returns) or a bare payload (what a unit-test mock of koFetch
 * usually returns) and hand back the envelope. An object is treated as an
 * envelope only when it carries BOTH keys: ko-api's double-nested stock-holders
 * body (`{ data: [...], totalCount, ... }`, no `meta`) must stay a payload.
 */
export function asEnvelope<T>(raw: unknown): KoEnvelope<T> {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "data" in raw && "meta" in raw) {
    const r = raw as { data: T; meta: unknown };
    const meta = r.meta && typeof r.meta === "object" && !Array.isArray(r.meta) ? (r.meta as KoMeta) : {};
    return { data: r.data, meta };
  }
  return { data: raw as T, meta: {} };
}

/**
 * ko-api refused the call. `code` is ko-api's structured `error.code` when it
 * sent one (PLAN_REQUIRED, SIGNIN_REQUIRED, NOT_FOUND ...).
 *
 * A 403 PLAN_REQUIRED / SIGNIN_REQUIRED is an ACCESS LIMIT of the caller's
 * ko.io plan, not an absence of data, and the message says so in words -- a
 * model that reads "forbidden" with no reason tends to report the data as
 * missing, which is the exact false statement this class exists to prevent.
 */
export class KoApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;
  constructor(message: string, status: number, code: string | null, details: Record<string, unknown> | null) {
    super(message);
    this.name = "KoApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** True for a plan / sign-in limit (as opposed to a bad request or an outage). */
  get isPlanLimit(): boolean {
    return this.status === 403 && (this.code === "PLAN_REQUIRED" || this.code === "SIGNIN_REQUIRED");
  }
}

/** The sentence appended to a plan-limit 403 so it cannot be read as "no data". */
function planLimitExplanation(code: string, details: Record<string, unknown> | null): string {
  const d = details ?? {};
  const bits: string[] = [];
  const reason = typeof d.reason === "string" ? d.reason : null;
  bits.push(reason ? `${code} (${reason})` : code);
  if (typeof d.param === "string" && d.param) bits.push(`parameter \`${d.param}\``);
  if (typeof d.window_start === "string") {
    const basis = typeof d.date_basis === "string" ? `${d.date_basis} ` : "";
    bits.push(`Free window starts ${basis}${d.window_start}`);
  }
  const head = ` [${bits.join("; ")}]`;
  if (code === "SIGNIN_REQUIRED") {
    return (
      `${head} This is a limit of keyless (anonymous) access, not missing data: without an API key ` +
      `ko.io serves only the first page, capped at 25 rows. Send a free ko.io API key ` +
      `(Authorization: Bearer ko_...) to page further.`
    );
  }
  if (typeof d.param === "string" && d.param) {
    return (
      `${head} This is a limit of the caller's ko.io plan, not missing data. Retry inside the Free ` +
      `window (omit \`${d.param}\` to get the plan default), or use a Pro API key: https://ko.io/pricing`
    );
  }
  return `${head} This endpoint is not included in the caller's ko.io plan; it is a plan limit, not missing data.`;
}

/**
 * `options.envelope: true` returns ko-api's whole `{ data, meta }` envelope
 * (call it as `koFetch<KoEnvelope<Row[]>>(...)`) instead of `data` alone.
 * `meta` is where `total_count` and the plan's `softwall` block live; a tool
 * that pages, or that can be emptied by a plan limit, needs it.
 */
export async function koFetch<T = unknown>(
  config: KoConfig,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  options: KoFetchOptions & { envelope?: boolean } = {}
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
    let code: string | null = null;
    let details: Record<string, unknown> | null = null;
    try {
      const j = await res.json() as { error?: { message?: string; code?: string; details?: Record<string, unknown> } };
      if (typeof j?.error?.message === "string") detail = `: ${j.error.message}`;
      if (typeof j?.error?.code === "string") code = j.error.code;
      if (j?.error?.details && typeof j.error.details === "object") details = j.error.details;
    } catch { /* non-JSON body — ignore */ }
    const generic: Record<number, string> = {
      400: "Bad request", 401: "Authentication required", 403: "Access forbidden (check your plan)",
      404: "Not found", 429: "Rate limit exceeded", 500: "Upstream error", 502: "Upstream error", 503: "Service unavailable",
    };
    const plan = res.status === 403 && (code === "PLAN_REQUIRED" || code === "SIGNIN_REQUIRED")
      ? planLimitExplanation(code, details)
      : "";
    throw new KoApiError(
      `ko.io API error (${res.status}): ${generic[res.status] ?? "Request failed"}${detail}${plan}`,
      res.status, code, details,
    );
  }

  const json = await res.json() as Record<string, unknown>;
  // ko-api wraps responses in { data: ..., meta: ... } — unwrap automatically
  const data = json.data !== undefined ? json.data : json;
  if (options.envelope) {
    const meta = json.meta && typeof json.meta === "object" && !Array.isArray(json.meta) ? (json.meta as KoMeta) : {};
    return { data, meta } as T;
  }
  return data as T;
}
