import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ko-fetch.js", () => ({ koFetch: vi.fn() }));
import { koFetch } from "../ko-fetch.js";
import { registerCryptoTools } from "../tools/crypto.js";
import { makeFakeServer, textOf } from "./helpers.js";

const config = { baseUrl: "https://api.ko.io", apiKey: "" };
const mock = vi.mocked(koFetch);

function tools() {
  const { server, tools } = makeFakeServer();
  registerCryptoTools(server, config);
  return tools;
}

beforeEach(() => mock.mockReset());

describe("get_crypto_exposure", () => {
  it("proxies /crypto/exposure-summary and renders complex + per-ETF table", async () => {
    mock.mockResolvedValue({
      complex: { total_usd: 16058608240, qoq_change: -3034047728, products: 11 },
      products: [{ product_ticker: "IBIT", product_name: "iShares Bitcoin Trust ETF", sponsor: "BlackRock", holders: "1456", total_usd: "9184839201", prev_usd: "10597896632", qoq_change: "-1413057431" }],
    });
    const t = tools().get("get_crypto_exposure")!;
    const out = textOf(await t.handler({}));
    expect(mock.mock.calls[0][1]).toBe("/api/v1/crypto/exposure-summary");
    expect(out).toContain("$16.06B");      // complex total (number)
    expect(out).toContain("IBIT");
    expect(out).toContain("$9.18B");        // per-ETF total (string coerced)
    expect(out).toContain("BlackRock");
  });
});

describe("get_crypto_holders", () => {
  it("proxies /crypto/institutional-holders, coerces string USD, passes product filter", async () => {
    mock.mockResolvedValue({
      product: "IBIT", page: 1, per_page: 50, total_count: 1456,
      holders: [{ cik: "1512857", name: "Brevan Howard Capital Management LP", slug: "x", total_usd: "933789955", prev_usd: "923865255", qoq_value_change: "9924700", product_count: "1", products: ["IBIT"], rank: 1 }],
    });
    const t = tools().get("get_crypto_holders")!;
    const out = textOf(await t.handler({ product: "ibit", page: 1, limit: 50 }));
    expect(mock.mock.calls[0][1]).toBe("/api/v1/crypto/institutional-holders");
    expect(mock.mock.calls[0][2]).toMatchObject({ product: "IBIT", page: 1, per_page: 50 });
    expect(out).toContain("Brevan Howard");
    expect(out).toContain("$933.79M");      // string "933789955" coerced via Number
    expect(out).toContain("1512857");
  });

  it("renders an empty-but-valid message when there are no holders", async () => {
    mock.mockResolvedValue({ total_count: 0, holders: [] });
    const t = tools().get("get_crypto_holders")!;
    const out = textOf(await t.handler({}));
    expect(out).toMatch(/no institutional holders/i);
  });
});

describe("get_crypto_holder", () => {
  it("proxies /crypto/holder/:cik and renders positions", async () => {
    mock.mockResolvedValue({
      institution: { cik: "1512857", name: "Brevan Howard Capital Management LP", slug: "x", latest_quarter: "2026-03-31", total_usd: 933789955, qoq_change: 9924700, products: 1, portfolio_weight_pct: 8.26, rank: 1, total_holders: 1992 },
      positions: [{ product_ticker: "IBIT", product_name: "iShares Bitcoin Trust ETF", sponsor: "BlackRock", shares_held: "24304788", usd_value: "933789955", prev_usd_value: "923865255", qoq_value_change: "9924700", share_change: "5697230", action: "ADDED", portfolio_weight_pct: 8.26 }],
      history: [],
    });
    const t = tools().get("get_crypto_holder")!;
    const out = textOf(await t.handler({ institution: "1512857" }));
    expect(mock.mock.calls[0][1]).toBe("/api/v1/crypto/holder/1512857");
    expect(out).toContain("Brevan Howard");
    expect(out).toContain("IBIT");
    expect(out).toContain("ADDED");
  });

  it("rejects a non-numeric CIK without calling ko-api", async () => {
    const t = tools().get("get_crypto_holder")!;
    const out = textOf(await t.handler({ institution: "not-a-cik" }));
    expect(mock).not.toHaveBeenCalled();
    expect(out).toMatch(/numeric CIK/i);
  });

  it("strips non-digits from the CIK before proxying", async () => {
    mock.mockResolvedValue({ institution: { cik: "1512857" }, positions: [], history: [] });
    const t = tools().get("get_crypto_holder")!;
    await t.handler({ institution: "CIK 1512857" });
    expect(mock.mock.calls[0][1]).toBe("/api/v1/crypto/holder/1512857");
  });
});
