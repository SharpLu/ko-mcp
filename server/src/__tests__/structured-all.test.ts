/**
 * Every tool, populated AND empty, through a real McpServer + Client
 * (final-eval R1 #7). The SDK validates structuredContent against each tool's
 * outputSchema on the server and again on the client, so this proves that all
 * 24 tools return schema-valid structured output on both success shapes.
 *
 * The fixture table is keyed by tool name and compared with tools/list: a new
 * tool with no fixture fails here, so coverage cannot silently stay at "some".
 * Also carries the R1 #4 (history), #6 (filing-document outcomes) and #8
 * (holder entity grain) cases, which need the same harness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../ko-fetch.js", async () => ({
  ...(await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js")),
  koFetch: vi.fn(),
}));
import { koFetch, KoApiError, KoTimeoutError, type KoConfig } from "../ko-fetch.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerInstitutionTools } from "../tools/institutions.js";
import { registerStockTools } from "../tools/stocks.js";
import { registerInsiderTools } from "../tools/insiders.js";
import { registerCongressTools } from "../tools/congress.js";
import { registerSearchTool } from "../tools/search.js";
import { registerForm144Tools } from "../tools/form144.js";
import { registerFilingTools } from "../tools/filings.js";
import { registerFinancialTools } from "../tools/financials.js";
import { registerMacroTools } from "../tools/macro.js";
import { registerCryptoTools } from "../tools/crypto.js";

const mock = vi.mocked(koFetch);

async function connect(apiKey = "") {
  const config: KoConfig = { baseUrl: "https://api.ko.io", apiKey };
  const server = new McpServer({ name: "ko-sec-data", version: "test" });
  for (const reg of [
    registerInstitutionTools, registerStockTools, registerInsiderTools, registerCongressTools, registerSearchTool,
    registerForm144Tools, registerFilingTools, registerFinancialTools, registerMacroTools, registerCryptoTools,
  ]) reg(server, config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Result = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
async function call(name: string, args: Record<string, unknown>, apiKey = ""): Promise<Result> {
  const client = await connect(apiKey);
  await client.listTools(); // the client caches outputSchema validators from tools/list
  return (await client.callTool({ name, arguments: args })) as Result;
}
const text = (r: Result) => r.content.map((c) => c.text).join("\n");
const env = (data: unknown, meta: Record<string, unknown> = {}) => ({ data, meta });

// Minimal but realistic rows (shapes from live api.ko.io, 2026-09-26).
const HOLDING = {
  cik: "1067983", quarter_date: "2026-06-30", ticker: "AAPL", name_of_issuer: "APPLE INC", shares_held: "227917808",
  holding_value: "65950296923", total_portfolio_value: "1", portfolio_weight_pct: 22.04, action: "UNCHANGED",
  share_change: "0", prev_shares: "1", prev_value: "1", is_option: 0, call_shares: "0", put_shares: "0",
};
const HOLDER = { cik: "102909", name: "Vanguard", slug: "v", shares_held: "1000", holding_value: "2000", share_change: "5", action: "ADDED", portfolio_weight_pct: 1.5 };
const DAY = {
  ticker: "AAPL", company_name: "Apple", person_name: "X", person_cik: "1", officer_title: "CFO", is_director: 0, is_officer: 1,
  is_ten_percent_owner: 0, trade_date: "2026-09-15", stock_shares_bought: null, stock_value_bought: null, stock_shares_sold: 10,
  stock_value_sold: 100, om_value_bought: null, om_value_sold: 100, om_buy_tx: "0", om_sell_tx: "1", total_transactions: "1",
  shares_owned_after: 5, ps_shares_sold: 10, ps_sell_unpriced_lines: 0,
};
const TXN = {
  transaction_date: "2026-09-15", ticker: "AAPL", company: "Apple", transaction_code: "S", signal_class: "HIGH", side: "SELL",
  trade_type: "sell", security_title: "Common Stock", shares: 10, price: 10, value: 100, shares_owned_after: 5, is_derivative: 0, ownership_type: "D",
};
const CONGRESS = {
  member_name: "N P", chamber: "house", ticker: "NVDA", asset_description: "NVIDIA", transaction_type: "Purchase",
  transaction_date: "2026-09-01", disclosure_date: "2026-09-10", amount_range: "$1,001 - $15,000", owner: "spouse",
};
const ACTIVITY = {
  ticker: "NVDA",
  summary: { quarterDate: "2026-06-30", institutionsIncreased: 1, institutionsDecreased: 1, institutionsNew: 1, institutionsExited: 1,
    institutionsTotal: 4, sharesAdded: "1", sharesRemoved: "1", netShares: "0", valueAdded: "1", valueRemoved: "1", netValue: "0" },
  trend: [{ quarter: "2026-06-30", institutionsIncreased: 1, institutionsDecreased: 1, institutionsNew: 1, institutionsExited: 1, netShares: "0", netValue: "0" }],
};
const FIN = { period_end: "2026-06-27", revenue: 1, net_income: 1, eps_basic: 1, eps_diluted: 1, gross_profit: 1, operating_income: 1,
  operating_cashflow: 1, long_term_debt: 1, short_term_debt: 1, stockholders_equity: 1 };

interface Fixture {
  args: Record<string, unknown>;
  /** path -> upstream body, populated. */
  populated: (path: string) => unknown;
  /** path -> upstream body, empty-but-successful. */
  empty: (path: string) => unknown;
  /** The bare-fetch excerpt leg (sec_get_filing_document only). */
  fetchStatus?: { populated: number; empty: number };
}

const same = (body: unknown) => () => body;

const FIXTURES: Record<string, Fixture> = {
  get_institution_holdings: { args: { institution: "1067983" }, populated: same(env([HOLDING], { total_count: "1" })), empty: same(env([])) },
  list_institutions: {
    args: {},
    populated: same(env([{ cik: "1", name: "A", slug: "a", rank: 1, category: "Hedge Fund", portfolio_value: "10", stock_count: 3 }])),
    empty: same(env([])),
  },
  get_stock_profile: {
    args: { ticker: "AAPL" },
    populated: same({ stock: { ticker: "AAPL", sector: "Tech", current_price: 1.5, market_cap: 3 }, top_holders: [{ name: "V", shares_held: "1", holding_value: "2", portfolio_weight_pct: 1 }] }),
    empty: same({ stock: { ticker: "AAPL" }, top_holders: [] }),
  },
  get_stock_holders: {
    args: { ticker: "AAPL" },
    populated: same(env({ data: [HOLDER], totalCount: 1, totalPages: 1, quarterDate: "2026-06-30" })),
    empty: same(env({ data: [], totalCount: 0, totalPages: 0 })),
  },
  get_stock_activity: { args: { ticker: "NVDA" }, populated: same(env(ACTIVITY)), empty: same(env(null)) },
  get_stock_price: {
    args: { ticker: "AAPL" },
    populated: same(env([{ date: "2026-09-25", open: 1, high: 2, low: 1, close: 2, volume: 10 }, { date: "2026-09-24", open: 1, high: 1, low: 1, close: 1, volume: 5 }])),
    empty: same(env([])),
  },
  get_stock_financials: { args: { ticker: "AAPL" }, populated: same(env({ quarterly: [FIN], annual: [] })), empty: same(env({ quarterly: [], annual: [] })) },
  get_insider_trades: { args: { ticker: "AAPL" }, populated: same(env([DAY], { total_count: 1 })), empty: same(env([])) },
  list_insider_traders: { args: {}, populated: same(env([DAY])), empty: same(env([])) },
  get_congress_trades: { args: {}, populated: same(env([CONGRESS])), empty: same(env([])) },
  get_congress_member: { args: { member: "nancy-pelosi" }, populated: same(env([CONGRESS])), empty: same(env([])) },
  search: {
    args: { query: "apple" },
    populated: same({ institutions: [{ type: "i", cik: "1", name: "A", slug: "a", aum: 5, rank: 1, category: null }], stocks: [{ type: "s", ticker: "AAPL", name: "Apple", sector: null, industry: null, market_cap: 1 }], insiders: [], congress: [] }),
    empty: same({ institutions: [], stocks: [], insiders: [], congress: [] }),
  },
  get_form144_notices: {
    args: { ticker: "AAPL" },
    populated: same(env([{ accession_no: "a", filed_date: "2026-09-01", issuer_ticker: "AAPL", issuer_name: "Apple", issuer_cik: "320193",
      seller_name: "X", relationship: "Officer", securities_class: "Common", num_units_to_sell: 100, aggregate_market_value: 1000,
      approx_sale_date: "2026-09-02", broker_name: "B", has_10b5_1_plan: 1 }])),
    empty: same(env([])),
  },
  sec_list_filings: {
    args: { cik: "320193" },
    populated: same([{ accession: "0000320193-25-000079", form: "10-K", filingDate: "2025-10-31", primaryDocument: "a.htm", primaryDocDescription: "10-K" }]),
    empty: same([]),
  },
  sec_get_filing_index: {
    args: { cik: "320193", accession_no: "0000320193-25-000079" },
    populated: same({ cik: "320193", accession: "0000320193-25-000079", files: [{ name: "a.htm", type: "10-K", size: 10, lastModified: "x" }] }),
    empty: same({ cik: "320193", accession: "0000320193-25-000079", files: [] }),
  },
  sec_get_filing_document: {
    args: { cik: "320193", accession_no: "0000320193-25-000079" },
    populated: same({ url: "https://api.ko.io/signed", expires_at: "2026-09-27T00:00:00Z" }),
    // "Empty": a signed link but the excerpt is unavailable -- still a usable, successful answer.
    empty: same({ url: "https://api.ko.io/signed", expires_at: "2026-09-27T00:00:00Z" }),
    fetchStatus: { populated: 200, empty: 404 },
  },
  get_treasury_yields: { args: {}, populated: same([{ date: "2026-09-25", m1: 4.1, m3: 4, m6: 3.9, y1: 3.8, y2: 3.6, y5: 3.7, y10: 4.1, y30: 4.7 }]), empty: same([]) },
  get_fed_rates: { args: {}, populated: same([{ date: "2026-09-25", fed_funds_rate: 4.33, sofr: 4.3, prime_rate: 7.5, treasury_3m: 4, treasury_2y: 3.6, treasury_10y: 4.1, treasury_30y: 4.7 }]), empty: same([]) },
  get_economic_indicators: { args: {}, populated: same(env([{ date: "2026-08-01", series_id: "CPI", series_name: "CPI", value: 321.5, category: "cpi" }])), empty: same(env([])) },
  get_ftd_data: { args: { ticker: "GME" }, populated: same(env([{ settlement_date: "2026-09-10", ticker: "GME", quantity: 57727, price: 24.31 }])), empty: same(env([])) },
  get_financial_stress: { args: {}, populated: same(env([{ date: "2026-09-25", series_name: "OFR FSI", value: -1.234 }])), empty: same(env([])) },
  get_crypto_exposure: {
    args: {},
    populated: same({ complex: { total_usd: "28000000000", qoq_change: "1", products: 1 }, products: [{ product_ticker: "IBIT", product_name: "iShares", sponsor: "BlackRock", holders: "1400", total_usd: "1", prev_usd: "1", qoq_change: "0" }] }),
    empty: same({ complex: { total_usd: "0", qoq_change: "0", products: 0 }, products: [] }),
  },
  get_crypto_holders: {
    args: { product: "IBIT" },
    populated: same(env({ total_count: 1, holders: [{ cik: "1", name: "A", slug: "a", total_usd: "5", prev_usd: "4", qoq_value_change: "1", product_count: "1", products: ["IBIT"], rank: 1 }] })),
    empty: same(env({ total_count: 0, holders: [] })),
  },
  get_crypto_holder: {
    args: { institution: "1512857" },
    populated: same(env({ institution: { cik: "1512857", name: "Brevan", slug: "b", latest_quarter: "2026-06-30", total_usd: "5", qoq_change: "1", products: 1, portfolio_weight_pct: 1.2, rank: 3, total_holders: 100 },
      positions: [{ product_ticker: "IBIT", product_name: "iShares", sponsor: "B", shares_held: "10", usd_value: "5", prev_usd_value: "4", qoq_value_change: "1", share_change: "1", action: "ADDED", portfolio_weight_pct: 1 }] })),
    empty: same(env({ institution: null, positions: [] })),
  },
};

let realFetch: typeof fetch;
beforeEach(() => { mock.mockReset(); realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

function stubExcerpt(status: number) {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300, status, text: async () => "# Excerpt\nbody", json: async () => ({}),
  })) as unknown as typeof fetch;
}

describe("all 24 tools return schema-valid structuredContent (R1 #7)", () => {
  it("the fixture table covers exactly the tools/list surface", async () => {
    const { tools } = await (await connect()).listTools();
    expect(Object.keys(FIXTURES).sort()).toEqual(tools.map((t) => t.name).sort());
  });

  for (const [name, fx] of Object.entries(FIXTURES)) {
    for (const shape of ["populated", "empty"] as const) {
      it(`${name}: ${shape} success carries structuredContent`, async () => {
        mock.mockImplementation(async (_c: unknown, path: string) => fx[shape](path) as never);
        if (fx.fetchStatus) stubExcerpt(fx.fetchStatus[shape]);
        const r = await call(name, fx.args);
        expect(r.isError, `${name} ${shape}: ${text(r).slice(0, 300)}`).toBeFalsy();
        expect(r.structuredContent, `${name} ${shape} has no structuredContent`).toBeTypeOf("object");
      });
    }
  }
});

describe("get_institution_holdings: history is labelled as history (R1 #4)", () => {
  it("a paid family+ticker multi-quarter response shows each row's quarter and says it is history", async () => {
    // ko-api's family + ticker branch: ONE row per quarter (paid: whole history).
    const q = (quarter_date: string, shares_held: string, action: string) => ({
      ...HOLDING, cik: "102909", ticker: "AMD", name_of_issuer: "AMD", quarter_date, shares_held, action,
    });
    mock.mockResolvedValue(env([q("2026-06-30", "150", "ADDED"), q("2026-03-31", "100", "NEW_POSITION")], { is_family: true, total_count: "2" }) as never);
    const r = await call("get_institution_holdings", { institution: "102909", ticker: "AMD" }, "ko_live_paid");
    const t = text(r);
    expect(t).not.toMatch(/## 13F Holdings — Quarter: 2026-06-30/);
    expect(t).toMatch(/Position History — AMD — 2 quarters on this page \(2026-03-31 to 2026-06-30\)/);
    expect(t).not.toMatch(/current holding/i);
    expect(t).toMatch(/HISTORY, not a current portfolio/);
    expect(t).toMatch(/\| # \| Quarter \|/);
    expect(t).toMatch(/\| 1 \| 2026-06-30 \|/);
    expect(t).toMatch(/\| 2 \| 2026-03-31 \|/);
    expect(r.structuredContent).toMatchObject({ view: "history", quarters: ["2026-06-30", "2026-03-31"], quarter_date: null });
    expect(r.structuredContent!.rows.map((x: { quarter_date: string }) => x.quarter_date)).toEqual(["2026-06-30", "2026-03-31"]);
  });

  const famRow = (quarter_date: string) => ({ ...HOLDING, cik: "102909", ticker: "AMD", name_of_issuer: "AMD", quarter_date });

  it("page 2 of a family+ticker history is still a history, with no 'current' claim", async () => {
    mock.mockResolvedValue(env([famRow("2025-12-31"), famRow("2025-09-30")], { is_family: true, total_count: "8", page: 2, per_page: 2 }) as never);
    const r = await call("get_institution_holdings", { institution: "102909", ticker: "AMD", page: 2, limit: 2 }, "ko_live_paid");
    const t = text(r);
    expect(t).toMatch(/Position History — AMD/);
    expect(t).not.toMatch(/current holding|Quarter: 2025-12-31/i);
    expect(t).toMatch(/\| 3 \| 2025-12-31 \|/);
    expect(r.structuredContent).toMatchObject({ view: "history", quarter_date: null, quarters: ["2025-12-31", "2025-09-30"] });
  });

  it("a one-row family+ticker page is still a history", async () => {
    mock.mockResolvedValue(env([famRow("2026-06-30")], { is_family: true, total_count: "1" }) as never);
    const r = await call("get_institution_holdings", { institution: "102909", ticker: "AMD" });
    expect(text(r)).toMatch(/Position History — AMD — 1 quarter on this page/);
    expect(text(r)).toMatch(/\| # \| Quarter \|/);
    expect(r.structuredContent).toMatchObject({ view: "history", quarter_date: null });
  });

  it("a filer (non-family) ticker query stays a snapshot", async () => {
    mock.mockResolvedValue(env([{ ...HOLDING, ticker: "GOOG" }], { consolidated_share_classes: false }) as never);
    const r = await call("get_institution_holdings", { institution: "1067983", ticker: "GOOG" });
    expect(r.structuredContent).toMatchObject({ view: "snapshot", quarter_date: "2026-06-30" });
  });

  it("a single-quarter answer stays a snapshot", async () => {
    mock.mockResolvedValue(env([HOLDING]) as never);
    const r = await call("get_institution_holdings", { institution: "1067983" });
    expect(text(r)).toMatch(/## 13F Holdings — Quarter: 2026-06-30/);
    expect(r.structuredContent).toMatchObject({ view: "snapshot", quarter_date: "2026-06-30" });
  });
});

describe("get_insider_trades: partial dollar totals are labelled (R1 #5)", () => {
  it("an unpriced code-S line makes the sold total PARTIAL, in text and in structuredContent", async () => {
    mock.mockResolvedValue(env([{ ...DAY, om_sell_tx: "2", ps_shares_sold: 20, om_value_sold: 100, ps_sell_unpriced_lines: 1, total_transactions: "2" }]) as never);
    const r = await call("get_insider_trades", { ticker: "AAPL" });
    expect(text(r)).toContain("20 sh / $100.00 PARTIAL (1 of 2 lines unpriced) (2 lines)");
    expect(r.structuredContent!.rows[0]).toMatchObject({ ps_sell_lines: 2, ps_sell_unpriced_lines: 1, ps_value_sold: "100", ps_value_sold_complete: false });
  });

  it("never claims P/S codes prove discretionary open-market trading", async () => {
    const { tools } = await (await connect()).listTools();
    for (const n of ["get_insider_trades", "list_insider_traders"]) {
      expect(tools.find((t) => t.name === n)!.description).not.toMatch(/discretionary/i);
    }
    mock.mockResolvedValue(env([TXN]) as never);
    const r = await call("get_insider_trades", { ticker: "AAPL", executive_cik: "1" });
    expect(text(r)).not.toMatch(/discretionary/i);
    expect(text(r)).toContain("Open-market or private sale");
  });
});

describe("sec_get_filing_document: a confirmed plan denial is not laundered into success (R1 #6)", () => {
  const denied = () => new KoApiError("ko.io API error (403): Access forbidden (check your plan): Source filing documents require Pro.", 403, "PLAN_REQUIRED", null);
  const args = FIXTURES.sec_get_filing_document.args;

  const cases: Array<{ name: string; share: "denied" | "ok" | "5xx" | "timeout"; excerpt: number | "timeout" | "network"; expect: "plan" | "success" | "failure" }> = [
    { name: "share PLAN_REQUIRED + excerpt 502", share: "denied", excerpt: 502, expect: "plan" },
    { name: "share PLAN_REQUIRED + excerpt timeout", share: "denied", excerpt: "timeout", expect: "plan" },
    { name: "share PLAN_REQUIRED + excerpt network error", share: "denied", excerpt: "network", expect: "plan" },
    { name: "share PLAN_REQUIRED + excerpt 403", share: "denied", excerpt: 403, expect: "plan" },
    { name: "share PLAN_REQUIRED + excerpt 200 (usable excerpt)", share: "denied", excerpt: 200, expect: "success" },
    { name: "share 5xx + excerpt 403 (denial confirmed by the other leg)", share: "5xx", excerpt: 403, expect: "plan" },
    { name: "share timeout + excerpt 502 (nothing usable, no denial)", share: "timeout", excerpt: 502, expect: "failure" },
    { name: "share ok + excerpt 403 (signed link is usable)", share: "ok", excerpt: 403, expect: "success" },
    { name: "share ok + excerpt 200", share: "ok", excerpt: 200, expect: "success" },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      mock.mockImplementation(async () => {
        if (c.share === "denied") throw denied();
        if (c.share === "5xx") throw new KoApiError("ko.io API error (502): Upstream error", 502, null, null);
        if (c.share === "timeout") throw new KoTimeoutError(20000, "/share");
        return { url: "https://api.ko.io/signed", expires_at: "2026-09-27T00:00:00Z" } as never;
      });
      if (c.excerpt === "timeout") {
        globalThis.fetch = (async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }) as unknown as typeof fetch;
      } else if (c.excerpt === "network") {
        globalThis.fetch = (async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;
      } else {
        stubExcerpt(c.excerpt);
      }
      const r = await call("sec_get_filing_document", args);
      if (c.expect === "success") {
        expect(r.isError, text(r)).toBeFalsy();
        expect(r.structuredContent).toBeTypeOf("object");
      } else if (c.expect === "plan") {
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/plan limit \(PLAN_REQUIRED\)/);
      } else {
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(/could not serve this filing document/);
        expect(text(r)).not.toMatch(/PLAN_REQUIRED/);
      }
    });
  }

  it("include_excerpt=false with a PLAN_REQUIRED share is a plan error", async () => {
    mock.mockImplementation(async () => { throw denied(); });
    const r = await call("sec_get_filing_document", { ...args, include_excerpt: false });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/PLAN_REQUIRED/);
  });
});

describe("get_stock_holders: entity grain and family attribution survive the projection (R1 #8)", () => {
  it("ko-api C2 metadata and option legs are rendered and carried in structuredContent", async () => {
    mock.mockResolvedValue(env(
      { data: [{ ...HOLDER, cik: "1446194", name: "SUSQUEHANNA SECURITIES", shares_held: "76689700", holding_value: "22190931592",
          equity_shares: "6426000", call_shares: "43119100", put_shares: "27144600", has_option_legs: 1,
          family: { slug: "susquehanna-investment-group-918950", name: "Susquehanna", canonical_cik: "918950" }, reported_by_members: 1 }],
        totalCount: 1, totalPages: 1, quarterDate: "2026-06-30" },
      { entity_grain: "filer", position_basis: "13f_reported_all_legs",
        position_basis_note: "shares_held and holding_value are both the 13F-reported total over all legs", requested_cik: null },
    ) as never);
    const r = await call("get_stock_holders", { ticker: "AAPL" });
    const t = text(r);
    expect(t).toMatch(/\*\*Entity grain:\*\* filer -- each row is ONE 13F filer CIK/);
    expect(t).toContain("(family: Susquehanna)");
    expect(t).toContain("6,426,000 common + 43,119,100 via calls + 27,144,600 via puts");
    expect(r.structuredContent).toMatchObject({
      entity_grain: "filer", position_basis: "13f_reported_all_legs",
      position_basis_note: "shares_held and holding_value are both the 13F-reported total over all legs",
    });
    expect(r.structuredContent!.rows[0]).toMatchObject({
      cik: "1446194", shares_held: "76689700", equity_shares: "6426000", call_shares: "43119100", put_shares: "27144600",
      has_option_legs: true, family: { canonical_cik: "918950", name: "Susquehanna" }, reported_by_members: 1,
    });
  });

  it("an older build without the metadata says the grain is not stated (null, not guessed)", async () => {
    mock.mockResolvedValue(env({ data: [HOLDER], totalCount: 1, totalPages: 1, quarterDate: "2026-06-30" }) as never);
    const r = await call("get_stock_holders", { ticker: "AAPL" });
    expect(text(r)).toMatch(/Entity grain:\*\* not stated by ko\.io/);
    expect(r.structuredContent).toMatchObject({ entity_grain: null, family: null });
    expect(r.structuredContent!.rows[0]).toMatchObject({ family: null, equity_shares: null, has_option_legs: null });
  });
});

describe("get_stock_profile: the price as-of date survives (R2 #2)", () => {
  it("reads ko-api's sibling data.price_date into Markdown and structuredContent", async () => {
    mock.mockResolvedValue({ stock: { ticker: "AAPL", current_price: 255.46 }, price_date: "2026-09-25", top_holders: [] } as never);
    const r = await call("get_stock_profile", { ticker: "AAPL" });
    expect(text(r)).toContain("$255.46 (as of 2026-09-25)");
    expect(r.structuredContent!.stock).toMatchObject({ current_price: "255.46", price_date: "2026-09-25" });
  });

  it("falls back to stock.price_date on the older shape, and to null when absent", async () => {
    mock.mockResolvedValue({ stock: { ticker: "AAPL", current_price: 1, price_date: "2026-09-24" }, top_holders: [] } as never);
    expect((await call("get_stock_profile", { ticker: "AAPL" })).structuredContent!.stock.price_date).toBe("2026-09-24");
    mock.mockResolvedValue({ stock: { ticker: "AAPL", current_price: 1 }, top_holders: [] } as never);
    const r = await call("get_stock_profile", { ticker: "AAPL" });
    expect(r.structuredContent!.stock.price_date).toBeNull();
    expect(text(r)).not.toMatch(/as of/);
  });
});
