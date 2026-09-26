/**
 * ko-bastion#126, the half the registry gates cannot see: the RENDERING.
 *
 * THE BUG
 * -------
 * A tool declared `limit`, described it to the model as "results per page", and
 * forwarded it to ko-api under that name. Almost every ko-api list route reads
 * `per_page` and nothing else, so `limit` landed in the query string, nobody
 * read it, and the route fell back to its own 50-row default. The tool rendered
 * those 50 rows as a complete answer. `limit: 5` produced 50 rows; so did
 * `limit: 200`. Three more tools sent no row-count param at all and were handed
 * the same 50 out of a much larger window, with nothing in the output saying a
 * page boundary had been crossed.
 *
 * It is invisible by construction: the request succeeds, the JSON is well
 * formed, the table is full, and the only evidence is a row count nobody counts.
 *
 * WHAT IS ASSERTED WHERE (one defect, one gate -- house rule)
 * ----------------------------------------------------------
 *   params on the wire   src/__tests__/registry/ gates (b) and (d)/(e): the
 *                        registry declares `per_page`, gate (b) proves the code
 *                        really sends it, gate (d) proves the pinned ko-api
 *                        handler really reads it, gate (e) proves no tool calls
 *                        a paginated route without a row count. Retiring those
 *                        exception entries is what closes #126 upstream-side.
 *   THIS FILE            what the caller is shown once the parameter lands: the
 *                        page they asked for is the page that is rendered (no
 *                        second, hardcoded 50-row cap downstream of it), and a
 *                        full page is disclosed rather than presented as the
 *                        whole answer. No registry gate looks at rendered text.
 *
 * Iron rule #6: no network. koFetch is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

// importActual first (iron rule #6): a hand-listed factory made every new
// ko-fetch export (asEnvelope, KoApiError) undefined in the tools under test.
vi.mock("../ko-fetch.js", async () => ({
  ...(await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js")),
  koFetch: vi.fn(),
}));
import { koFetch } from "../ko-fetch.js";

import { registerInsiderTools } from "../tools/insiders.js";
import { registerMacroTools } from "../tools/macro.js";
import { makeFakeServer } from "./helpers.js";

const mock = vi.mocked(koFetch);
const config = { baseUrl: "https://api.ko.io", apiKey: "" };

function tools() {
  const { server, tools } = makeFakeServer();
  registerInsiderTools(server, config);
  registerMacroTools(server, config);
  return tools;
}

/**
 * makeFakeServer bypasses zod, so the defaults the SDK would apply are passed
 * explicitly here. The defaults THEMSELVES are asserted off the schema below,
 * which is the only place they can be checked without a live Worker.
 */
const dataRows = (text: string, prefix: string) =>
  text.split("\n").filter((l) => l.startsWith(prefix)).length;

// Braces matter: an arrow that RETURNS the mock is taken by vitest as a cleanup
// callback and the mock gets called after every test.
beforeEach(() => { mock.mockReset(); });

describe("get_insider_trades renders the page it asked for", () => {
  // /api/v1/insider-trades row (one insider, one trade date).
  const row = (i: number) => ({
    ticker: "AAPL", company_name: "Apple", person_name: `Exec ${i}`, person_cik: String(i),
    officer_title: "CFO", is_director: 0, is_officer: 1, is_ten_percent_owner: 0, trade_date: "2026-01-02",
    stock_shares_bought: null, stock_value_bought: null, stock_shares_sold: 100, stock_value_sold: 1000,
    om_value_bought: null, om_value_sold: 1000, om_buy_tx: "0", om_sell_tx: "1", total_transactions: "1",
    shares_owned_after: 5000, ps_shares_bought: null, ps_shares_sold: 100,
  });

  it("renders all 120 rows of a 120-row page (no second, hardcoded 50-row cap)", async () => {
    // Before the fix this rendered truncate(trades, 50) -- so even once per_page
    // reached ko-api, limit=120 still produced 50 rows. Same #126 symptom, one
    // layer further down, and invisible to any gate that only reads query params.
    mock.mockResolvedValue(Array.from({ length: 120 }, (_, i) => row(i)) as unknown as never);
    const res = await tools().get("get_insider_trades")!.handler({ ticker: "AAPL", page: 1, limit: 120 });
    const text = res.content[0].text as string;
    expect(dataRows(text, "| 2026-")).toBe(120);
    expect(text).toContain("use page=2");
  });

  it("says nothing about more pages when the page came back short", async () => {
    mock.mockResolvedValue(Array.from({ length: 3 }, (_, i) => row(i)) as unknown as never);
    const res = await tools().get("get_insider_trades")!.handler({ ticker: "AAPL", page: 1, limit: 50 });
    expect(res.content[0].text as string).not.toContain("use page=");
  });
});

describe("the three `days`-window tools disclose a full page instead of hiding it", () => {
  const ftdRow = (i: number) => ({
    settlement_date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    ticker: "GME", quantity: 1000, price: 25,
  });

  it("a full page says so and names the next one", async () => {
    // The measured case: {GME, days:1825} is a 1,025-row window that ko-api
    // serves 50 rows of. Silence there is the whole defect -- a model reads a
    // complete-looking table as the complete window.
    mock.mockResolvedValue(Array.from({ length: 25 }, (_, i) => ftdRow(i)) as unknown as never);
    const res = await tools().get("get_ftd_data")!.handler({ ticker: "GME", days: 1825, page: 1, limit: 25 });
    const text = res.content[0].text as string;
    expect(dataRows(text, "| 2026-")).toBe(25);
    expect(text).toContain("Full page of 25 rows");
    expect(text).toContain("use page=2");
  });

  it("a short page stays silent -- the window really did end there", async () => {
    mock.mockResolvedValue([ftdRow(0)] as unknown as never);
    const res = await tools().get("get_ftd_data")!.handler({ ticker: "GME", days: 1825, page: 1, limit: 25 });
    expect(res.content[0].text as string).not.toContain("Full page");
  });

  it("the disclosure claims only a boundary, never a total it cannot know", async () => {
    // koFetch drops ko-api's `meta` when it unwraps { data, meta }, so
    // total_count never reaches this Worker and an honest "showing 25 of 1,025"
    // is not available. ko-fetch.ts is owned by ko-bastion#127. Until it
    // surfaces meta, a full page is evidence of a boundary and nothing more --
    // and the wording must not over-claim.
    mock.mockResolvedValue(Array.from({ length: 25 }, (_, i) => ftdRow(i)) as unknown as never);
    const res = await tools().get("get_ftd_data")!.handler({ ticker: "GME", days: 1825, page: 1, limit: 25 });
    const text = res.content[0].text as string;
    expect(text).toContain("more may exist");             // a boundary, hedged
    expect(text).not.toMatch(/showing\s+[\d,]+\s+of\s+[\d,]+/i); // not a total
  });

  for (const name of ["get_ftd_data", "get_economic_indicators", "get_financial_stress"] as const) {
    it(`${name} declares a page size with a default and ko-api's own ceiling`, () => {
      const schema = tools().get(name)!.schema as Record<string, z.ZodTypeAny>;
      expect(schema.page.parse(undefined)).toBe(1);
      expect(schema.limit.parse(undefined)).toBe(100);
      // 500 is ko-api's per_page clamp on all three routes; a tool that offered
      // more would promise a page size the route silently shrinks.
      expect(schema.limit.parse(500)).toBe(500);
      expect(() => schema.limit.parse(501)).toThrow();
    });
  }

  it("the two NON-paginating days tools are deliberately left alone", async () => {
    // /treasury/yields and /fed/rates run `LIMIT {days}` with no per_page at all,
    // so `days` already governs the row count and adding paging there would be
    // inventing a boundary that does not exist upstream.
    for (const name of ["get_treasury_yields", "get_fed_rates"] as const) {
      mock.mockReset();
      mock.mockResolvedValue([] as unknown as never);
      await tools().get(name)!.handler({ days: 90 });
      const params = mock.mock.calls[0][2] as Record<string, unknown>;
      expect(params).toEqual({ days: 90 });
    }
  });
});

describe("paging never advertises a page the caller cannot open (EVAL_CODEX_TECH #6)", () => {
  const ftdRow = (i: number) => ({ settlement_date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`, ticker: "GME", quantity: 57727, price: 25 });
  const keyless = (returned: number, total: number) => ({
    total_count: String(total), page: 1, per_page: 25,
    softwall: {
      policy_version: "softwall-v1", window_start: "2026-06-26", window_end: "2026-09-26", date_basis: "settlement_date",
      row_cap: 25, truncated: returned < total, returned, continuation: "SIGNIN_REQUIRED",
    },
  });

  it("a keyless full page says sign-in is needed instead of 'use page=2'", async () => {
    mock.mockResolvedValue({ data: Array.from({ length: 25 }, (_, i) => ftdRow(i)), meta: keyless(25, 61) } as unknown as never);
    const res = await tools().get("get_ftd_data")!.handler({ ticker: "GME", days: 90, page: 1, limit: 100 });
    const text = res.content[0].text as string;
    expect(text).not.toMatch(/use page=2/);
    expect(text).toContain("SIGNIN_REQUIRED");
    expect(text).toContain("rows 1-25 of 61");
    const sc = res.structuredContent as { paging: { next_page: number | null; continuation: string; truncated_by_plan: boolean } };
    expect(sc.paging.next_page).toBeNull();
    expect(sc.paging.continuation).toBe("SIGNIN_REQUIRED");
    expect(sc.paging.truncated_by_plan).toBe(true);
  });

  it("names the plan window so a 92-day slice is not read as the whole history", async () => {
    mock.mockResolvedValue({ data: [ftdRow(0)], meta: keyless(1, 1) } as unknown as never);
    const res = await tools().get("get_ftd_data")!.handler({ ticker: "GME", days: 90, page: 1, limit: 100 });
    expect(res.content[0].text as string).toMatch(/Free-plan window: settlement_date 2026-06-26 to 2026-09-26/);
  });

  it("a paid caller with a known total gets a real range and the next page", async () => {
    mock.mockResolvedValue({ data: Array.from({ length: 25 }, (_, i) => ftdRow(i)), meta: { total_count: "61", page: 1, per_page: 25 } } as unknown as never);
    const res = await tools().get("get_ftd_data")!.handler({ ticker: "GME", days: 1825, page: 1, limit: 25 });
    const text = res.content[0].text as string;
    expect(text).toContain("rows 1-25 of 61");
    expect(text).toContain("use page=2");
  });

  it("the last page of a known total says nothing about more", async () => {
    mock.mockResolvedValue({ data: Array.from({ length: 11 }, (_, i) => ftdRow(i)), meta: { total_count: "61", page: 3, per_page: 25 } } as unknown as never);
    const res = await tools().get("get_ftd_data")!.handler({ ticker: "GME", days: 1825, page: 3, limit: 25 });
    expect(res.content[0].text as string).not.toContain("use page=");
  });
});
