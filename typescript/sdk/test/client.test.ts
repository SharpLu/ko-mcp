import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  BadRequestError,
  KoClient,
  KoError,
  NotFoundError,
  PlanRequiredError,
  RateLimitError,
  ServerError,
  VERSION,
} from "../src/index.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function mockFetch(...outcomes: Array<Response | Error>) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = outcomes.shift();
    if (!next) throw new Error("mockFetch: no more outcomes queued");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const OK = { data: [{ id: 1 }], meta: { total_count: 1, page: 1, per_page: 50, query_time_ms: 3 } };

beforeEach(() => {
  delete process.env.KO_API_KEY;
  delete process.env.KO_API_URL;
});

afterEach(() => {
  delete process.env.KO_API_KEY;
  delete process.env.KO_API_URL;
});

describe("envelope parsing and rows normalization", () => {
  it("returns data/meta and rows=data when data is an array", async () => {
    const { fn } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.institutions.list();
    expect(res.data).toEqual([{ id: 1 }]);
    expect(res.rows).toEqual([{ id: 1 }]);
    expect(res.meta.total_count).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it("normalizes double-nested data.data (stock-holders shape)", async () => {
    const body = { data: { summary: { holders: 2 }, data: [{ cik: "1" }, { cik: "2" }] }, meta: {} };
    const { fn } = mockFetch(jsonResponse(body));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.stocks.holders("nvda");
    expect(res.rows).toEqual([{ cik: "1" }, { cik: "2" }]);
    expect((res.data as { summary: { holders: number } }).summary.holders).toBe(2);
  });

  it("wraps plain-object data as [data] (financials historical shape)", async () => {
    const body = { data: { revenue: { "2025": 1 } }, meta: {} };
    const { fn } = mockFetch(jsonResponse(body));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.stocks.financialsHistory("NVDA");
    expect(res.rows).toEqual([{ revenue: { "2025": 1 } }]);
    expect(res.data).toEqual({ revenue: { "2025": 1 } });
  });

  it("extracts the single array-valued property (crypto holders / activity / by-company shapes)", async () => {
    const body = { data: { summary: { total: 2 }, holders: [{ cik: "1" }, { cik: "2" }] }, meta: {} };
    const { fn } = mockFetch(jsonResponse(body));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.crypto.holders();
    expect(res.rows).toEqual([{ cik: "1" }, { cik: "2" }]);
  });

  it("prefers data.data over the single-array-key rule", async () => {
    const body = { data: { data: [1, 2], meta_info: "x" }, meta: {} };
    const { fn } = mockFetch(jsonResponse(body));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.stocks.holders("NVDA");
    expect(res.rows).toEqual([1, 2]);
  });

  it("wraps objects with multiple array-valued properties as [data]", async () => {
    const payload = { adds: [1], drops: [2] };
    const { fn } = mockFetch(jsonResponse({ data: payload, meta: {} }));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.stocks.activity("NVDA");
    expect(res.rows).toEqual([payload]);
  });

  it("wraps non-object data as [data]", async () => {
    const { fn } = mockFetch(jsonResponse({ data: 42, meta: {} }));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.get("/api/v1/anything");
    expect(res.rows).toEqual([42]);
  });

  it("throws INVALID_RESPONSE when a 2xx body has no data property", async () => {
    const { fn } = mockFetch(jsonResponse({ meta: { page: 1 } }));
    const ko = new KoClient({ fetch: fn });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KoError);
    expect(err).toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
    expect((err as KoError).message).toMatch(/"data"/);
  });

  it("surfaces plan truncation via truncated flag and meta", async () => {
    const body = {
      data: [1, 2, 3],
      meta: { truncated: true, showing: 3, total_available: 500, upgrade_hint: "Upgrade to Pro" },
    };
    const { fn } = mockFetch(jsonResponse(body));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.congress.trades();
    expect(res.truncated).toBe(true);
    expect(res.meta.showing).toBe(3);
    expect(res.meta.total_available).toBe(500);
  });
});

describe("auth and demo mode", () => {
  it("appends demo=true when no API key is configured", async () => {
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    await ko.stocks.list();
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("demo")).toBe("true");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends Authorization Bearer header and no demo param when key is set", async () => {
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ apiKey: "ko_live_test123", fetch: fn });
    await ko.stocks.list();
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("demo")).toBeNull();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ko_live_test123");
  });

  it("defaults apiKey from KO_API_KEY env var", async () => {
    process.env.KO_API_KEY = "ko_live_from_env";
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    await ko.search("nvidia");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ko_live_from_env");
  });

  it("always sends the X-Ko-Client version header", async () => {
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    await ko.stocks.list();
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Ko-Client"]).toBe(`ko-sdk-js/${VERSION}`);
  });
});

describe("error mapping", () => {
  const errBody = (code: string, message: string) => ({ error: { code, message } });

  it("maps 401 to AuthenticationError with API code", async () => {
    const { fn } = mockFetch(jsonResponse(errBody("INVALID_API_KEY", "bad key"), { status: 401 }));
    const ko = new KoClient({ fetch: fn });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toMatchObject({ status: 401, code: "INVALID_API_KEY", message: "bad key" });
  });

  it("maps 403 to PlanRequiredError", async () => {
    const { fn } = mockFetch(jsonResponse(errBody("PLAN_REQUIRED", "Pro plan required"), { status: 403 }));
    const ko = new KoClient({ fetch: fn });
    await expect(ko.macro.treasuryYields()).rejects.toBeInstanceOf(PlanRequiredError);
  });

  it("maps 404 to NotFoundError and does not retry", async () => {
    const { fn } = mockFetch(jsonResponse(errBody("NOT_FOUND", "no such cik"), { status: 404 }));
    const ko = new KoClient({ fetch: fn });
    await expect(ko.institutions.get("0")).rejects.toBeInstanceOf(NotFoundError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maps 429 to RateLimitError with retryAfter and does not retry", async () => {
    const res = jsonResponse(errBody("RATE_LIMIT_EXCEEDED", "slow down"), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "7" },
    });
    const { fn } = mockFetch(res);
    const ko = new KoClient({ fetch: fn });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("maps 400 to BadRequestError", async () => {
    const { fn } = mockFetch(jsonResponse(errBody("INVALID_QUARTER", "bad quarter"), { status: 400 }));
    const ko = new KoClient({ fetch: fn });
    const err = await ko.institutions.holdings("123", { quarter: "nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ code: "INVALID_QUARTER" });
  });

  it("maps 500 with a non-JSON body to ServerError with fallback code", async () => {
    const { fn } = mockFetch(new Response("<html>oops</html>", { status: 500 }));
    const ko = new KoClient({ fetch: fn });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });

  it("parses the flat docs-style error shape {error: CODE, message}", async () => {
    const { fn } = mockFetch(
      jsonResponse({ error: "NOT_FOUND", message: "institution not found" }, { status: 404 }),
    );
    const ko = new KoClient({ fetch: fn });
    const err = await ko.institutions.get("999").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: "NOT_FOUND", message: "institution not found" });
  });

  it("treats an empty Retry-After header as undefined", async () => {
    const res = jsonResponse({ error: { code: "RATE_LIMIT_EXCEEDED", message: "slow down" } }, {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "" },
    });
    const { fn } = mockFetch(res);
    const ko = new KoClient({ fetch: fn });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });

  it("ignores non-digit Retry-After values (HTTP-date form)", async () => {
    const res = jsonResponse({ error: { code: "RATE_LIMIT_EXCEEDED", message: "slow down" } }, {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
    });
    const { fn } = mockFetch(res);
    const ko = new KoClient({ fetch: fn });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });
});

describe("retries and timeout", () => {
  it("retries a 503 and succeeds on the next attempt", async () => {
    const { fn } = mockFetch(
      new Response("unavailable", { status: 503 }),
      jsonResponse(OK),
    );
    const ko = new KoClient({ fetch: fn });
    const res = await ko.stocks.list();
    expect(res.rows).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a network error and succeeds", async () => {
    const { fn } = mockFetch(new TypeError("fetch failed"), jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.stocks.list();
    expect(res.rows).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries on persistent 503 and throws ServerError", async () => {
    const { fn } = mockFetch(
      new Response("down", { status: 503 }),
      new Response("down", { status: 503 }),
      new Response("down", { status: 503 }),
    );
    const ko = new KoClient({ fetch: fn, maxRetries: 2 });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("aborts via timeout and throws a TIMEOUT KoError when retries are exhausted", async () => {
    let attempts = 0;
    const hanging = ((_url: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const ko = new KoClient({ fetch: hanging, timeoutMs: 20, maxRetries: 1 });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KoError);
    expect(err).toMatchObject({ status: 0, code: "TIMEOUT" });
    expect(attempts).toBe(2); // timeouts are retried like network errors
  });

  it("retries a timeout and succeeds on the next attempt", async () => {
    let attempts = 0;
    const flaky = ((_url: RequestInfo | URL, init?: RequestInit) => {
      attempts++;
      if (attempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        });
      }
      return Promise.resolve(jsonResponse(OK));
    }) as unknown as typeof fetch;
    const ko = new KoClient({ fetch: flaky, timeoutMs: 20, maxRetries: 1 });
    const res = await ko.stocks.list();
    expect(res.rows).toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("does not retry non-network TypeErrors and wraps them in KoError", async () => {
    const { fn } = mockFetch(new TypeError("Headers.append: 'ko_live_\\n' is an invalid header value"));
    const ko = new KoClient({ fetch: fn });
    const err = await ko.stocks.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KoError);
    expect(err).toMatchObject({ status: 0, code: "REQUEST_ERROR" });
    expect((err as KoError).message).toContain("invalid header value");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancels the response body before retrying a retryable status", async () => {
    const first = new Response("gateway down", { status: 503 });
    const cancelSpy = vi.spyOn(first.body!, "cancel");
    const { fn } = mockFetch(first, jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    const res = await ko.stocks.list();
    expect(res.rows).toHaveLength(1);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});

describe("URL building and query serialization", () => {
  it("maps camelCase options to snake_case params and skips undefined", async () => {
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    await ko.institutions.holdings("1067983", {
      perPage: 50,
      tradesOnly: true,
      page: 2,
      quarter: undefined,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/holdings/1067983");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("trades_only")).toBe("true");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("quarter")).toBe(false);
    expect(url.searchParams.has("perPage")).toBe(false);
  });

  it("uppercases tickers in paths and maps date range params", async () => {
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    await ko.stocks.price("nvda", { startDate: "2026-01-01", endDate: "2026-02-01" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/stock-price/NVDA");
    expect(url.searchParams.get("start_date")).toBe("2026-01-01");
    expect(url.searchParams.get("end_date")).toBe("2026-02-01");
  });

  it("respects baseUrl override and strips trailing slash", async () => {
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ baseUrl: "https://staging.ko.io/", fetch: fn });
    await ko.search("tesla", { limit: 3 });
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://staging.ko.io");
    expect(url.pathname).toBe("/api/v1/search");
    expect(url.searchParams.get("q")).toBe("tesla");
    expect(url.searchParams.get("limit")).toBe("3");
  });

  it("exposes get() as a raw escape hatch", async () => {
    const { fn, calls } = mockFetch(jsonResponse(OK));
    const ko = new KoClient({ fetch: fn });
    await ko.get("/api/v1/insider-trades", { ticker: "NVDA", per_page: 5, role: null });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/api/v1/insider-trades");
    expect(url.searchParams.get("per_page")).toBe("5");
    expect(url.searchParams.has("role")).toBe(false);
  });
});
