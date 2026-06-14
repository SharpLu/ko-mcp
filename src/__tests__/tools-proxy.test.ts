import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ko-fetch.js", () => ({ koFetch: vi.fn() }));
import { koFetch } from "../ko-fetch.js";

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

function registerAll() {
  const { server, tools } = makeFakeServer();
  const config = { baseUrl: "https://api.ko.io", apiKey: "" };
  registerInstitutionTools(server, config);
  registerStockTools(server, config);
  registerInsiderTools(server, config);
  registerCongressTools(server, config);
  registerSearchTool(server, config);
  registerForm144Tools(server, config);
  registerFilingTools(server, config);
  registerFinancialTools(server, config);
  registerMacroTools(server, config);
  registerCryptoTools(server, config);
  return tools;
}

// Representative args superset -- each handler destructures what it needs.
const ARGS = {
  institution: "1067983", ticker: "AAPL", member: "Mike Kelly", query: "apple",
  cik: "320193", accession_no: "0000320193-24-000123", days: 30,
};

const EXPECTED_TOOLS = [
  "get_institution_holdings", "list_institutions",
  "get_stock_profile", "get_stock_holders", "get_stock_activity", "get_stock_price",
  "get_insider_trades", "list_insider_traders",
  "get_congress_trades", "get_congress_member",
  "search", "get_form144_notices",
  "sec_list_filings", "sec_get_filing_index", "sec_get_filing_document",
  "get_stock_financials",
  "get_treasury_yields", "get_fed_rates", "get_economic_indicators", "get_ftd_data", "get_financial_stress",
  "get_crypto_exposure", "get_crypto_holders", "get_crypto_holder",
];

describe("tool coverage gate", () => {
  it("registers exactly the expected tool set (new tool without manifest entry fails here)", () => {
    const registered = [...registerAll().keys()].sort();
    expect(registered).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("registers 24 tools (21 base + 3 crypto)", () => {
    expect(registerAll().size).toBe(24);
  });
});

describe("every tool proxies to a ko-api /api/ path", () => {
  beforeEach(() => mock.mockReset());

  const tools = registerAll();
  for (const name of EXPECTED_TOOLS) {
    it(`${name} calls koFetch with an /api/ path`, async () => {
      mock.mockReset();
      mock.mockResolvedValue([] as unknown as never); // array default; object tools tolerate via optional chaining
      const tool = tools.get(name)!;
      try { await tool.handler({ ...ARGS }); } catch { /* formatting may throw on empty mock; the proxy call is what we assert */ }
      expect(mock, `${name} did not call koFetch`).toHaveBeenCalled();
      const path = mock.mock.calls[0][1] as string;
      expect(path, `${name} path: ${path}`).toMatch(/^\/api\//);
    });
  }
});
