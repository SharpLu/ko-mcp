import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerStockTools } from "../tools/stocks.js";
import { registerCongressTools } from "../tools/congress.js";
import { registerInstitutionTools } from "../tools/institutions.js";
import { makeFakeServer } from "./helpers.js";

// Uses the REAL koFetch with a mocked global fetch (status mapping itself is in
// ko-fetch.test). This avoids the vitest "mock implementation throws" unhandled
// quirk and exercises the true tool -> koFetch -> error path.
function reg(fn: (s: any, c: any) => void) {
  const { server, tools } = makeFakeServer();
  fn(server, { baseUrl: "https://api.ko.io", apiKey: "" });
  return tools;
}
const errResponse = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

/**
 * A fetch that behaves like the real one: it NEVER settles on its own, and it
 * rejects only when the caller's AbortSignal fires, with that signal's reason.
 *
 * This is the whole negative control. The test this replaces mocked an INSTANT
 * rejection and called itself "no hang" -- so it passed against a koFetch with
 * no timeout at all, which is exactly the code ko-bastion#127 describes. Against
 * an unbounded koFetch no signal is ever passed here, nothing rejects, and the
 * test hangs until vitest kills it. Against the bounded one, AbortSignal.timeout
 * fires and koFetch converts it into KoTimeoutError.
 */
const neverSettles = (_url: string, init?: { signal?: AbortSignal }) =>
  new Promise<never>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;                       // unbounded caller -> hang, like production did
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason));
  });

describe("koFetch is bounded (ko-bastion#127)", () => {
  it("a fetch that never answers is cut off by our own budget, not left to hang", async () => {
    fetchMock.mockImplementation(neverSettles);
    const { koFetch, KoTimeoutError } = await import("../ko-fetch.js");
    const err = await koFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/x", {}, { timeoutMs: 50 })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KoTimeoutError);
  }, 2000); // a hang fails here in 2s instead of running to the suite default

  it("the timeout reads as OUR limit, never as an upstream 5xx", async () => {
    fetchMock.mockImplementation(neverSettles);
    const { koFetch } = await import("../ko-fetch.js");
    const err = await koFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/x", {}, { timeoutMs: 50 })
      .then(() => null, (e: unknown) => e) as Error;
    expect(err.message).toMatch(/ko\.io MCP timeout/);
    expect(err.message).not.toMatch(/ko\.io API error/);   // that prefix means upstream ANSWERED
    expect(err.message).toMatch(/not an upstream failure/);
  }, 2000);

  it("the default budget is under the 30s the upstream route declares", async () => {
    const { KO_FETCH_TIMEOUT_MS } = await import("../ko-fetch.js");
    expect(KO_FETCH_TIMEOUT_MS).toBeLessThan(30_000);
    // ...and comfortably over the slowest healthy call ever measured (1,050ms).
    expect(KO_FETCH_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it("still propagates a plain network rejection unchanged", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));
    const { koFetch } = await import("../ko-fetch.js");
    await expect(koFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/x")).rejects.toThrow(/connection reset/);
  });
});

describe("tool error propagation (upstream 429/500 surfaced, not swallowed)", () => {
  const cases: Array<[() => Map<string, any>, string, Record<string, unknown>]> = [
    [() => reg(registerStockTools), "get_stock_profile", { ticker: "AAPL" }],
    [() => reg(registerCongressTools), "get_congress_member", { member: "mike-kelly" }],
    [() => reg(registerInstitutionTools), "get_institution_holdings", { institution: "1067983" }],
  ];

  for (const [build, name, args] of cases) {
    it(`${name} surfaces a 429`, async () => {
      fetchMock.mockResolvedValue(errResponse(429, { error: { message: "Rate limit exceeded" } }));
      const tool = build().get(name)!;
      await expect(tool.handler(args)).rejects.toThrow(/429/);
    });
    it(`${name} surfaces a 500`, async () => {
      fetchMock.mockResolvedValue(errResponse(500, { error: { message: "Upstream error" } }));
      const tool = build().get(name)!;
      await expect(tool.handler(args)).rejects.toThrow(/500/);
    });
  }
});

describe("tool parameter schemas (declarative validation)", () => {
  const isOptional = (z: any) => (typeof z?.isOptional === "function" ? z.isOptional() : true);

  it("required identifiers are not optional", () => {
    expect(isOptional(reg(registerStockTools).get("get_stock_profile")!.schema.ticker)).toBe(false);
    expect(isOptional(reg(registerCongressTools).get("get_congress_member")!.schema.member)).toBe(false);
    expect(isOptional(reg(registerInstitutionTools).get("get_institution_holdings")!.schema.institution)).toBe(false);
  });

  it("pagination params are optional and bounded (reject out-of-range)", () => {
    const h = reg(registerInstitutionTools).get("get_institution_holdings")!.schema as Record<string, any>;
    expect(isOptional(h.limit)).toBe(true);
    expect(isOptional(h.page)).toBe(true);
    expect(() => h.limit.parse(0)).toThrow();
    expect(() => h.limit.parse(99999)).toThrow();
    expect(h.limit.parse(50)).toBe(50);
  });
});
