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

describe("koFetch network / timeout transparency", () => {
  it("propagates a network/timeout rejection (readable, no hang)", async () => {
    fetchMock.mockRejectedValue(new Error("The operation timed out"));
    const { koFetch } = await import("../ko-fetch.js");
    await expect(koFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/x")).rejects.toThrow(/timed out/i);
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
    const h = reg(registerInstitutionTools).get("get_institution_holdings")!.schema;
    expect(isOptional(h.limit)).toBe(true);
    expect(isOptional(h.page)).toBe(true);
    expect(() => h.limit.parse(0)).toThrow();
    expect(() => h.limit.parse(99999)).toThrow();
    expect(h.limit.parse(50)).toBe(50);
  });
});
