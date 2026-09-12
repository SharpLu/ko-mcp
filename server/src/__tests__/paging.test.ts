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

vi.mock("../ko-fetch.js", () => ({ koFetch: vi.fn() }));
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

beforeEach(() => mock.mockReset());

describe("get_insider_trades renders the page it asked for", () => {
  const row = (i: number) => ({
    ticker: "AAPL", company_name: "Apple", executive_name: `Exec ${i}`, executive_cik: String(i),
    officer_title: "CFO", is_ceo: false, is_director: false, trade_date: "2026-01-02",
    action: "SELL", shares: 100, value: 1000, price: 10, is_derivative: false,
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
