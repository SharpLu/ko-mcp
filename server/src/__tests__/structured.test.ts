/**
 * The final-eval (2026-09-26) fidelity fixes, end to end through a REAL
 * McpServer + Client pair (in-memory transport, no network -- koFetch is
 * mocked, iron rule #6).
 *
 * Going through the SDK on both sides is the point: the server rejects a
 * success result whose structuredContent does not validate against the tool's
 * outputSchema, and the client re-validates it with its own JSON-Schema
 * validator. A schema/handler mismatch therefore fails here, offline, instead
 * of turning a live answer into "Output validation error".
 *
 * Fixtures are trimmed copies of live api.ko.io responses (demo, 2026-09-26).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ko-fetch.js", async () => ({
  ...(await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js")),
  koFetch: vi.fn(),
}));
import { koFetch, KoApiError, type KoConfig } from "../ko-fetch.js";

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
import { makeFakeServer } from "./helpers.js";

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
  // listTools first: the client caches outputSchema validators from it.
  await client.listTools();
  return (await client.callTool({ name, arguments: args })) as Result;
}
const text = (r: Result) => r.content.map((c) => c.text).join("\n");

const KEYLESS_WINDOW = (basis: string, returned: number, cap = 25) => ({
  policy_version: "softwall-v1", window_start: "2026-06-26", window_end: "2026-09-26", date_basis: basis,
  row_cap: cap, truncated: false, returned, continuation: "SIGNIN_REQUIRED",
});

// Braces matter: an arrow that RETURNS the mock is taken by vitest as a cleanup
// callback and the mock gets called after every test.
beforeEach(() => { mock.mockReset(); });

// ── tools/list ──────────────────────────────────────────────────────────────
describe("tools/list: annotations on all 24, outputSchema where structured", () => {
  it("every tool is read-only and open-world", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.length).toBe(24);
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, openWorldHint: true, destructiveHint: false });
    }
  });

  it("every one of the 24 tools declares an outputSchema", async () => {
    const { tools } = await (await connect()).listTools();
    const without = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(without, `tools without outputSchema: ${without.join(", ")}`).toEqual([]);
  });
});

// ── #2 insider grain ────────────────────────────────────────────────────────
describe("get_insider_trades never collapses a day into one SELL", () => {
  // AAPL, Newstead, 2026-09-15: S 1,438 ($474,813.22) + M 30,104 + F 16,228
  // ($5,376,985.52) + derivative M. The old tool: "SELL 17,666 sh, $5.85M".
  const newsteadDay = {
    ticker: "AAPL", company_name: "Apple Inc.", person_name: "Newstead Jennifer", person_cik: "1780525",
    officer_title: "SVP, GC and Government Affairs", is_director: 0, is_officer: 1, is_ten_percent_owner: 0,
    trade_date: "2026-09-15", stock_shares_bought: 30104, stock_value_bought: null, stock_shares_sold: 17666,
    stock_value_sold: 5851798.74, om_value_bought: null, om_value_sold: 474813.22, om_buy_tx: "0", om_sell_tx: "1",
    total_transactions: "4", shares_owned_after: 32914, ps_shares_bought: null, ps_shares_sold: 1438,
    ps_buy_unpriced_lines: null, ps_sell_unpriced_lines: 0, first_filed_date: "2026-09-17", last_filed_date: "2026-09-17",
  };

  it("aggregate view: labels the grain and splits open-market from other dispositions", async () => {
    mock.mockResolvedValue({ data: [newsteadDay], meta: { total_count: 7, page: 1, per_page: 50, softwall: KEYLESS_WINDOW("trade_date", 1) } } as never);
    const r = await call("get_insider_trades", { ticker: "AAPL" });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toMatch(/one row per insider per trade date/);
    expect(t).toContain("1,438 sh / $474,813.22 (1 line)");
    expect(t).not.toMatch(/discretionary/i);
    expect(t).toMatch(/open market or private/);
    expect(t).toContain("17,666 / $5,851,798.74");
    expect(t).not.toMatch(/\*\*SELL\*\*/);
    const row = r.structuredContent!.rows[0];
    expect(r.structuredContent!.grain).toBe("insider_trade_date");
    expect(row).toMatchObject({
      form4_lines: 4, ps_value_sold: "474813.22", ps_shares_sold: "1438", ps_sell_unpriced_lines: 0,
      ps_value_sold_complete: true,
      all_shares_acquired: "30104", all_shares_disposed: "17666", all_value_disposed: "5851798.74",
      ps_value_bought: null,
    });
    const [, path, params] = mock.mock.calls[0];
    expect(path).toBe("/api/v1/insider-trades");
    expect(params).toMatchObject({ ticker: "AAPL", period: "1Q", include: "detail,codes", per_page: 50 });
    // an API without include=codes: the Lines cell is the bare count, codes are null (unknown)
    expect(t).toContain("| SVP, GC and Government Affairs | 4 | — |");
    expect(row).toMatchObject({ transaction_codes: null, transaction_code_breakdown: null });
  });

  it("aggregate view with codes (ko-api#340): Lines cell and structuredContent carry the day's SEC codes", async () => {
    // A1 2026-09-26, the four lines of that day.
    const withCodes = {
      ...newsteadDay,
      transaction_codes: ["F", "M", "S"],
      transaction_code_breakdown: [
        { code: "F", acquired_disposed: "D", derivative: false, lines: 1, shares: 16228, value: 5376985.52 },
        { code: "M", acquired_disposed: "A", derivative: false, lines: 1, shares: 30104, value: null },
        { code: "M", acquired_disposed: "D", derivative: true, lines: 1, shares: 30104, value: null },
        { code: "S", acquired_disposed: "D", derivative: false, lines: 1, shares: 1438, value: 474813.22 },
      ],
    };
    mock.mockResolvedValue({ data: [withCodes], meta: { total_count: 7, page: 1, per_page: 50, softwall: KEYLESS_WINDOW("trade_date", 1) } } as never);
    const r = await call("get_insider_trades", { ticker: "AAPL" });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain("| 4 (F 1, M 2, S 1) |");
    // the table header does not move with the upstream version
    expect(t).toContain("| Date | Insider (CIK) | Title | Lines | Code P Bought (sh / $) |");
    const row = r.structuredContent!.rows[0];
    expect(row.transaction_codes).toEqual(["F", "M", "S"]);
    expect(row.transaction_code_breakdown).toHaveLength(4);
    expect(row.transaction_code_breakdown[0]).toEqual({
      code: "F", code_meaning: "Shares withheld to pay exercise price or tax", acquired_disposed: "D",
      is_derivative: false, lines: 1, shares: "16228", value: "5376985.52",
    });
    expect(row.transaction_code_breakdown[2]).toMatchObject({ code: "M", acquired_disposed: "D", is_derivative: true, value: null });
  });

  it("with executive_cik: one row per Form 4 line, with its code", async () => {
    const line = (code: string, side: string, shares: number, price: number | null, value: number | null, deriv = 0, title = "Common Stock") => ({
      transaction_date: "2026-09-15", ticker: "AAPL", company: "Apple Inc.", transaction_code: code, signal_class: "X",
      side, trade_type: "x", security_title: title, shares, price, value, shares_owned_after: 1, is_derivative: deriv, ownership_type: "D",
    });
    mock.mockResolvedValue({
      data: [
        line("S", "SELL", 1438, 330.19, 474813.22),
        line("M", "BUY", 30104, null, null),
        line("F", "SELL", 16228, 331.34, 5376985.52),
        line("M", "SELL", 30104, null, null, 1, "Restricted Stock Unit"),
      ],
      meta: { total_count: "10", page: 1, per_page: 50 },
    } as never);
    const r = await call("get_insider_trades", { ticker: "aapl", executive_cik: "1780525" });
    expect(r.isError).toBeFalsy();
    expect(mock.mock.calls[0][1]).toBe("/api/v1/insider/1780525/transactions");
    const rows = r.structuredContent!.rows;
    expect(r.structuredContent!.grain).toBe("form4_transaction_line");
    expect(rows.map((x: { transaction_code: string }) => x.transaction_code)).toEqual(["S", "M", "F", "M"]);
    expect(rows[0]).toMatchObject({ code_p_or_s: true, code_meaning: "Open-market or private sale", value: "474813.22", shares: "1438" });
    expect(rows[2]).toMatchObject({ code_p_or_s: false, code_meaning: "Shares withheld to pay exercise price or tax" });
    expect(text(r)).toContain("Shares withheld to pay exercise price or tax");
  });

  it("period=ALL sends neither detail nor codes (ko-api refuses both with ALL)", async () => {
    mock.mockResolvedValue({ data: [], meta: {} } as never);
    await call("get_insider_trades", { ticker: "AAPL", period: "ALL" });
    expect((mock.mock.calls[0][2] as Record<string, unknown>).include).toBeUndefined();
  });
});

// ── #4 plan-emptied data is an error, never "no data" ───────────────────────
describe("get_stock_financials: a plan limit is not 'No financial data found'", () => {
  const q = { period_end: "2026-06-27", revenue: 94036000000, net_income: 23434000000, eps_basic: 1.57, eps_diluted: 1.57,
    gross_profit: 43718000000, operating_income: 28202000000, operating_cashflow: null, long_term_debt: null,
    short_term_debt: null, stockholders_equity: 65830000000 };

  it("annual under the soft wall -> isError naming Pro", async () => {
    mock.mockResolvedValue({ data: { quarterly: [q], annual: [] }, meta: { softwall: { policy_version: "softwall-v1", date_basis: "period_end" } } } as never);
    const r = await call("get_stock_financials", { ticker: "AAPL", period_type: "annual", limit: 2 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/plan limit \(PLAN_REQUIRED\)/);
    expect(text(r)).toMatch(/require Pro/);
    expect(text(r)).not.toMatch(/No financial data found/);
  });

  it("quarterly under the soft wall -> the latest statement, with the limit stated", async () => {
    mock.mockResolvedValue({ data: { quarterly: [q], annual: [] }, meta: { softwall: { policy_version: "softwall-v1" } } } as never);
    const r = await call("get_stock_financials", { ticker: "AAPL" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/only the latest quarterly statement/);
    expect(r.structuredContent!.periods[0]).toMatchObject({ revenue: "94036000000", eps_diluted: "1.57" });
  });

  it("a genuinely empty annual series (no soft wall) is still reported as absent", async () => {
    mock.mockResolvedValue({ data: { quarterly: [q], annual: [] }, meta: {} } as never);
    const r = await call("get_stock_financials", { ticker: "AAPL", period_type: "annual" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe("No annual financial data found for AAPL.");
  });
});

describe("plan-limit 403s say they are plan limits", () => {
  it("the error names the code, the parameter and that the data is not missing", async () => {
    const { koFetch: realKoFetch } = await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      json: async () => ({ error: { code: "PLAN_REQUIRED", message: "Earlier periods require Pro.",
        details: { reason: "history", param: "quarters", window_start: "2026-06-30", date_basis: "quarter_date", required_plan: "developer" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const e: any = await realKoFetch({ baseUrl: "https://api.ko.io", apiKey: "" }, "/api/v1/stock-holders/NVDA", { quarters: 8 }).catch((x) => x);
      expect(e).toBeInstanceOf(KoApiError);
      expect(e.isPlanLimit).toBe(true);
      expect(e.message).toMatch(/^ko\.io API error \(403\): Access forbidden \(check your plan\): Earlier periods require Pro\./);
      expect(e.message).toMatch(/PLAN_REQUIRED \(history\); parameter `quarters`; Free window starts quarter_date 2026-06-30/);
      expect(e.message).toMatch(/not missing data/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── #6 defaults within the plan ─────────────────────────────────────────────
describe("get_stock_activity defaults to what the caller's plan allows", () => {
  const activity = {
    ticker: "NVDA",
    summary: { quarterDate: "2026-06-30", institutionsIncreased: 1, institutionsDecreased: 2, institutionsNew: 3,
      institutionsExited: 4, institutionsTotal: 10, sharesAdded: "5", sharesRemoved: "6", netShares: "-1", valueAdded: "7",
      valueRemoved: "8", netValue: "-1" },
    trend: [{ quarter: "2026-06-30", institutionsIncreased: 1, institutionsDecreased: 2, institutionsNew: 3, institutionsExited: 4, netShares: "-1", netValue: "-1" }],
  };

  it("keyless: does not send quarters (ko-api injects the Free maximum) and says why only one quarter came back", async () => {
    mock.mockResolvedValue({ data: activity, meta: { softwall: { policy_version: "softwall-v1", window_start: "2026-06-30" } } } as never);
    const r = await call("get_stock_activity", { ticker: "NVDA" });
    expect(r.isError).toBeFalsy();
    expect((mock.mock.calls[0][2] as Record<string, unknown>).quarters).toBeUndefined();
    expect(text(r)).toMatch(/multi-quarter trend requires Pro/);
    expect(r.structuredContent).toMatchObject({ quarters_requested: null, quarters_returned: 1 });
  });

  it("with a Free key: asks for 8, and on PLAN_REQUIRED(quarters) retries once without it", async () => {
    mock
      .mockRejectedValueOnce(new KoApiError("ko.io API error (403): ...", 403, "PLAN_REQUIRED", { param: "quarters", reason: "history" }) as never)
      .mockResolvedValueOnce({ data: activity, meta: { softwall: { policy_version: "softwall-v1" } } } as never);
    const r = await call("get_stock_activity", { ticker: "NVDA" }, "ko_live_free");
    expect(r.isError).toBeFalsy();
    expect((mock.mock.calls[0][2] as Record<string, unknown>).quarters).toBe(8);
    expect((mock.mock.calls[1][2] as Record<string, unknown>).quarters).toBeUndefined();
    expect(text(r)).toMatch(/returned the plan maximum/);
  });

  it("an explicit quarters over the plan is an error, never silently reduced", async () => {
    // Straight at the handler: the SDK turns the throw into isError:true (the
    // envelope every other upstream refusal uses); what matters here is that
    // it is thrown, and that no retry quietly shrank the request.
    const err = new KoApiError("ko.io API error (403): Access forbidden (check your plan): Earlier periods require Pro.", 403, "PLAN_REQUIRED", { param: "quarters" });
    mock.mockImplementation(async () => { throw err; });
    const { server, tools } = makeFakeServer();
    registerStockTools(server, { baseUrl: "https://api.ko.io", apiKey: "" });
    await expect(tools.get("get_stock_activity")!.handler({ ticker: "NVDA", quarters: 8 })).rejects.toBe(err);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

// ── #1 holdings grain ───────────────────────────────────────────────────────
describe("get_institution_holdings states entity and security grain", () => {
  const goog = {
    cik: "1067983", quarter_date: "2026-06-30", ticker: "GOOG", name_of_issuer: "ALPHABET INC", shares_held: "105979600",
    holding_value: "37764088383", total_portfolio_value: "299253556246", portfolio_weight_pct: 12.620000000000001, action: "ADDED",
    share_change: "48144587", prev_shares: "57835013", prev_value: "16628526688", is_option: 0, call_shares: "0", put_shares: "0",
    share_classes: [{ ticker: "GOOGL", shares_held: 78791167, holding_value: 28157599351 }, { ticker: "GOOG", shares_held: 27188433, holding_value: 9606489032 }],
  };
  const aapl = { ...goog, ticker: "AAPL", name_of_issuer: "APPLE INC", shares_held: "227917808", holding_value: "65950296923", share_classes: undefined };

  it("today's response: a merged row is labelled issuer grain with the per-class breakdown", async () => {
    mock.mockResolvedValue({ data: [aapl, goog], meta: { total_count: "27", page: 1, per_page: 50, consolidated_share_classes: true } } as never);
    const r = await call("get_institution_holdings", { institution: "1067983" });
    expect(r.isError).toBeFalsy();
    const t = text(r);
    expect(t).toContain("**GOOG**†");
    expect(t).toContain("GOOGL 78,791,167 sh");
    expect(t).toContain("GOOG 27,188,433 sh");
    expect(t).toMatch(/Entity grain:\*\* filer/);
    const sc = r.structuredContent!;
    expect(sc.security_grain).toBe("mixed");
    expect(sc.rows[0]).toMatchObject({ security_grain: "security", tickers: ["AAPL"], shares_held: "227917808" });
    expect(sc.rows[1]).toMatchObject({ security_grain: "issuer", tickers: ["GOOGL", "GOOG"], shares_held: "105979600" });
    expect(sc.rows[1].share_classes[0]).toEqual({ ticker: "GOOGL", shares_held: "78791167", holding_value: "28157599351" });
  });

  it("a ticker asks ko-api for the security grain", async () => {
    mock.mockResolvedValue({ data: [{ ...goog, shares_held: "27188433", holding_value: "9606489032", share_classes: undefined }], meta: { consolidated_share_classes: false } } as never);
    const r = await call("get_institution_holdings", { institution: "1067983", ticker: "goog" });
    expect(mock.mock.calls[0][2]).toMatchObject({ ticker: "GOOG", raw_share_classes: "true" });
    expect(text(r)).toMatch(/Security grain:\*\* security -- only GOOG/);
    expect(r.structuredContent).toMatchObject({ security_grain: "security", ticker_filter: "GOOG" });
  });

  it("a family answer says which CIK was asked for and which answered (today's is_family)", async () => {
    mock.mockResolvedValue({ data: [{ ...aapl, cik: "918950" }], meta: { is_family: true, consolidated_share_classes: true } } as never);
    const r = await call("get_institution_holdings", { institution: "1446194" });
    expect(text(r)).toMatch(/Entity grain:\*\* family .*requested 1446194, answered for canonical CIK 918950/);
    expect(r.structuredContent).toMatchObject({ entity_grain: "family", requested_cik: "1446194", resolved_cik: "918950" });
  });

  it("uses ko-api's new grain fields when present (SPEC C1-C3)", async () => {
    mock.mockResolvedValue({
      data: [{ ...aapl, cik: "918950", shares_held: "76689700", holding_value: "22190931592", equity_shares: "6426000",
        call_shares: "43119100", put_shares: "27144600", has_option_legs: 1, security_grain: "security", tickers: ["AAPL"], reported_by_members: 1 }],
      meta: { entity_grain: "family", requested_cik: "1446194", position_basis: "13f_reported_all_legs",
        family: { slug: "susquehanna-investment-group-918950", name: "Susquehanna", canonical_cik: "918950" } },
    } as never);
    const r = await call("get_institution_holdings", { institution: "1446194" });
    const t = text(r);
    expect(t).toContain("**AAPL** (opt)");
    expect(t).toContain("6,426,000 common + 43,119,100 via calls + 27,144,600 via puts");
    expect(t).toMatch(/Susquehanna \(susquehanna-investment-group-918950\)/);
    expect(r.structuredContent).toMatchObject({
      entity_grain: "family", requested_cik: "1446194", resolved_cik: "918950", position_basis: "13f_reported_all_legs",
      family: { canonical_cik: "918950" },
    });
    expect(r.structuredContent!.rows[0]).toMatchObject({ equity_shares: "6426000", call_shares: "43119100", has_option_legs: true, reported_by_members: 1 });
  });

  it("entity='filer' sends single_entity", async () => {
    mock.mockResolvedValue({ data: [], meta: {} } as never);
    const r = await call("get_institution_holdings", { institution: "1446194", entity: "filer" });
    expect(mock.mock.calls[0][2]).toMatchObject({ single_entity: "true" });
    expect(r.isError).toBeFalsy();
  });
});

// ── #5 exact values ─────────────────────────────────────────────────────────
describe("structuredContent carries the exact numbers the Markdown rounds", () => {
  it("get_ftd_data: 57,727 stays 57727", async () => {
    mock.mockResolvedValue({ data: [{ settlement_date: "2026-09-10", ticker: "GME", quantity: 57727, price: 24.31 }], meta: {} } as never);
    const r = await call("get_ftd_data", { ticker: "gme" });
    expect(r.structuredContent!.rows[0]).toEqual({ settlement_date: "2026-09-10", ticker: "GME", quantity: "57727", price: "24.31" });
    expect(r.structuredContent!.measure).toBe("outstanding_fail_balance");
    expect(text(r)).toContain("57,727");
  });

  it("get_stock_holders: 227,917,808 stays 227917808", async () => {
    mock.mockResolvedValue({
      data: { data: [{ cik: "1067983", name: "Berkshire", slug: "b", shares_held: "227917808", holding_value: "65950296923", share_change: "0", action: "UNCHANGED", portfolio_weight_pct: 22.04 }],
        totalCount: 5000, page: 1, per_page: 20, totalPages: 250, quarterDate: "2026-06-30" },
      meta: {},
    } as never);
    const r = await call("get_stock_holders", { ticker: "AAPL" });
    expect(r.structuredContent!.rows[0]).toMatchObject({ shares_held: "227917808", holding_value: "65950296923" });
  });
});

// ── #7 FTD description ──────────────────────────────────────────────────────
describe("get_ftd_data describes the measure honestly", () => {
  it("balance not flow, no summing, not evidence of naked shorting", async () => {
    const { tools } = await (await connect()).listTools();
    const d = tools.find((t) => t.name === "get_ftd_data")!.description!;
    expect(d).toMatch(/BALANCE of shares/);
    expect(d).toMatch(/NOT the number of new fails/);
    expect(d).toMatch(/never sum quantities across dates/);
    expect(d).toMatch(/not evidence of naked short selling/);
    expect(d).not.toMatch(/may indicate naked short/);
  });
});
