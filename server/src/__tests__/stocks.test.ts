import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ko-fetch.js", () => ({ koFetch: vi.fn() }));
import { koFetch } from "../ko-fetch.js";
import { registerStockTools } from "../tools/stocks.js";
import { makeFakeServer, textOf } from "./helpers.js";

const config = { baseUrl: "https://api.ko.io", apiKey: "" };
const mock = vi.mocked(koFetch);

function tools() {
  const { server, tools } = makeFakeServer();
  registerStockTools(server, config);
  return tools;
}

beforeEach(() => mock.mockReset());

const HOLDER = {
  cik: "1067983",
  name: "Berkshire Hathaway",
  slug: "berkshire",
  shares_held: "915560382", // Int64-as-string from ko-api
  holding_value: "173250000000",
  share_change: "1000000",
  action: "ADDED",
  portfolio_weight_pct: 45.2,
};

describe("get_stock_holders — dual response shape", () => {
  // Shape A: ko-api double-nests, ko-fetch strips outer {data} -> object.
  it("renders the OBJECT shape ({data:[...],totalCount,quarterDate})", async () => {
    mock.mockResolvedValue({
      data: [HOLDER],
      totalCount: 5833,
      page: 1,
      per_page: 20,
      totalPages: 292,
      quarterDate: "2026-03-31",
    });
    const t = tools().get("get_stock_holders")!;
    const out = textOf(await t.handler({ ticker: "aapl", page: 1, limit: 20 }));
    expect(mock.mock.calls[0][1]).toBe("/api/v1/stock-holders/AAPL");
    expect(out).toContain("Berkshire Hathaway");
    expect(out).toContain("2026-03-31"); // quarterDate rendered
    expect(out).toContain("5833"); // totalCount rendered
    expect(out).toContain("$173.25B"); // Int64-string holding_value coerced
    expect(out).toContain("915.56M"); // Int64-string shares_held coerced
    expect(out).not.toMatch(/no institutional holders/i);
  });

  // Shape B: standard {data:[...],meta} -> ko-fetch hands back a bare array.
  it("renders the ARRAY shape (standard {data:[...]} envelope unwrapped)", async () => {
    mock.mockResolvedValue([HOLDER]);
    const t = tools().get("get_stock_holders")!;
    const out = textOf(await t.handler({ ticker: "AAPL", page: 1, limit: 20 }));
    expect(out).toContain("Berkshire Hathaway");
    expect(out).toContain("$173.25B");
    // No quarterDate/totalCount available in bare-array shape -> falls back to row count.
    expect(out).toContain("**Total institutions:** 1");
    expect(out).not.toMatch(/no institutional holders/i);
  });

  it("reports no holders when the list is empty (object shape)", async () => {
    mock.mockResolvedValue({ data: [], totalCount: 0, quarterDate: "2026-03-31" });
    const t = tools().get("get_stock_holders")!;
    const out = textOf(await t.handler({ ticker: "ZZZZ" }));
    expect(out).toMatch(/no institutional holders/i);
  });

  it("reports no holders when the list is empty (array shape)", async () => {
    mock.mockResolvedValue([]);
    const t = tools().get("get_stock_holders")!;
    const out = textOf(await t.handler({ ticker: "ZZZZ" }));
    expect(out).toMatch(/no institutional holders/i);
  });
});

describe("get_stock_activity — Int64-as-string net values", () => {
  it("coerces string netShares/netValue instead of mis-rendering", async () => {
    mock.mockResolvedValue({
      ticker: "NVDA",
      summary: {
        quarterDate: "2026-03-31",
        institutionsIncreased: 100,
        institutionsDecreased: 50,
        institutionsNew: 10,
        institutionsExited: 5,
        institutionsTotal: 165,
        sharesAdded: "0",
        sharesRemoved: "0",
        netShares: "12500000", // string
        valueAdded: "0",
        valueRemoved: "0",
        netValue: "9500000000", // string
      },
      trend: [
        {
          quarter: "2026-03-31",
          institutionsIncreased: 100,
          institutionsDecreased: 50,
          institutionsNew: 10,
          institutionsExited: 5,
          netShares: "12500000",
          netValue: "9500000000",
        },
      ],
    });
    const t = tools().get("get_stock_activity")!;
    const out = textOf(await t.handler({ ticker: "nvda", quarters: 8 }));
    expect(out).toContain("12.50M"); // netShares string coerced
    expect(out).toContain("$9.50B"); // netValue string coerced
  });
});
