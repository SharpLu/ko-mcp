import { describe, it, expect, vi, beforeEach } from "vitest";

// ko-mcp#39: `insider_cik` is the FILER of the notice. ko-api's `cik` on
// /form144-notices is the ISSUER, so the tool must send `filer_cik`. The two
// differ exactly when one CIK is both: 49071 (Humana) filed 65 notices and is
// the issuer on 82 (A1, 2026-10-13); sending it as `cik` answered with the 82.

vi.mock("../ko-fetch.js", async () => ({
  ...(await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js")),
  koFetch: vi.fn(),
}));
import { koFetch } from "../ko-fetch.js";
import { registerForm144Tools } from "../tools/form144.js";
import { makeFakeServer, textOf } from "./helpers.js";

const config = { baseUrl: "https://api.ko.io", apiKey: "" };
const mock = vi.mocked(koFetch);

const HUMANA = "49071"; // both a Form 144 filer and an issuer
const ROW = {
  accession_no: "0001958244-23-000809", filed_date: "2023-05-16", issuer_ticker: "HUM", issuer_name: "HUMANA INC",
  issuer_cik: HUMANA, seller_name: "X", relationship: "Officer", securities_class: "Common",
  num_units_to_sell: 100, aggregate_market_value: 1000, approx_sale_date: "2023-05-16", broker_name: "B", has_10b5_1_plan: 0,
};

function tool() {
  const { server, tools } = makeFakeServer();
  registerForm144Tools(server, config);
  return tools.get("get_form144_notices")!;
}

beforeEach(() => {
  mock.mockReset();
  mock.mockResolvedValue({ data: [ROW], meta: { total_count: 65, page: 1, per_page: 50 } });
});

describe("get_form144_notices insider_cik (ko-mcp#39)", () => {
  it("a CIK that is both filer and issuer is sent as filer_cik, never as the issuer cik", async () => {
    const out = textOf(await tool().handler({ insider_cik: HUMANA, limit: 50 }));
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][1]).toBe("/api/v1/form144-notices");
    const params = mock.mock.calls[0][2] as Record<string, unknown>;
    expect(params).toMatchObject({ filer_cik: HUMANA, per_page: 50 });
    expect(params.cik).toBeUndefined();
    expect(out).toContain(`filed by CIK ${HUMANA}`);
  });

  it("ticker and insider_cik combine on the one route", async () => {
    await tool().handler({ ticker: "hum", insider_cik: HUMANA, limit: 50 });
    expect(mock.mock.calls[0][2]).toMatchObject({ ticker: "HUM", filer_cik: HUMANA });
  });

  it("without insider_cik no CIK filter is sent", async () => {
    const out = textOf(await tool().handler({ ticker: "HUM", limit: 50 }));
    const params = mock.mock.calls[0][2] as Record<string, unknown>;
    expect(params.filer_cik).toBeUndefined();
    expect(params.cik).toBeUndefined();
    expect(out).not.toContain("filed by CIK");
  });
});
