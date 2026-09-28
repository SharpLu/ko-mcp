/**
 * get_stock_activity: ko-api's quarter-level comparability guard.
 *
 * ko-api states, per quarter, whether the 13F flows can be compared with other
 * quarters: comparable | split_adjusted (+ split_factor) | not_comparable
 * (share/value flows null) | first_reported (no filer held it last quarter) |
 * unknown (flows null, `changes` may be null). The tool must
 *   - pass comparability / reason / split factor / null_reason through into
 *     structuredContent verbatim,
 *   - keep every null flow null there, and
 *   - never render a null flow as 0 in the text (it says "unknown").
 *
 * SPCX / KLAC / IVV are live api.ko.io `?type=activity&demo=true` payloads
 * captured 2026-09-29. The not_comparable and changes=null cases are derived
 * from the KLAC / SPCX payloads with exactly the fields ko-api's parser nulls
 * in those states (lib/equity-changes.ts parseChangesRow / parseLegacyRow and
 * the route's not_recomputable branch).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../ko-fetch.js", async () => ({
  ...(await vi.importActual<typeof import("../ko-fetch.js")>("../ko-fetch.js")),
  koFetch: vi.fn(),
}));
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerStockTools } from "../tools/stocks.js";
import spcx from "./fixtures/activity_spcx.json";
import klac from "./fixtures/activity_klac.json";
import ivv from "./fixtures/activity_ivv.json";

const mock = vi.mocked(koFetch);
beforeEach(() => mock.mockReset());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const envOf = (f: J) => ({ data: structuredClone(f.data), meta: structuredClone(f.meta) });

/** Through a REAL McpServer + Client: the SDK validates structuredContent against outputSchema. */
async function call(env: unknown, ticker: string) {
  mock.mockResolvedValue(env as never);
  const config: KoConfig = { baseUrl: "https://api.ko.io", apiKey: "" };
  const server = new McpServer({ name: "ko-sec-data", version: "test" });
  registerStockTools(server, config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools();
  const r = (await client.callTool({ name: "get_stock_activity", arguments: { ticker } })) as J;
  expect(r.isError ?? false).toBe(false);
  return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n"), sc: r.structuredContent as J };
}

const FLOW_KEYS = ["shares_added", "shares_removed", "net_shares", "value_added", "value_removed", "net_value"] as const;
const LEGACY_FLOW_KEYS = ["sharesAdded", "sharesRemoved", "netShares", "valueAdded", "valueRemoved", "netValue"] as const;

/** ko-api's not_comparable quarter: counts kept, every share/value flow null (parseChangesRow / parseLegacyRow). */
function notComparable(src: J, nullReason: string): J {
  const env = envOf(src);
  const reason = "Share counts moved by a ratio that is not a split factor for the median continuing holder.";
  for (const row of [env.data.summary, ...env.data.trend]) {
    row.comparability = "not_comparable";
    row.nullReason = nullReason;
    for (const k of LEGACY_FLOW_KEYS) row[k] = null;
    Object.assign(row.changes, {
      comparability: "not_comparable", comparability_reason: reason, split_factor: null,
      price_corrected: false, null_reason: nullReason,
    });
    for (const k of FLOW_KEYS) row.changes[k] = null;
  }
  return env;
}

/** The route's not_recomputable branch: `changes: null`, legacy flows null, comparability unknown. */
function changesNull(src: J): J {
  const env = envOf(src);
  for (const row of [env.data.summary, ...env.data.trend]) {
    row.changes = null;
    row.comparability = "unknown";
    row.nullReason = "not_recomputable";
    for (const k of LEGACY_FLOW_KEYS) row[k] = null;
  }
  return env;
}

/** No cell / field in the text shows a withheld flow as zero. */
function expectNoZeroFlows(text: string) {
  expect(text).not.toMatch(/Net (shares|value): \$?0(\.00)?\b/);
  expect(text).not.toMatch(/(Shares|Value) (added|removed): \$?0(\.00)?\b/);
  // Trend rows: the Net Shares / Net Value cells (the two before Comparability
  // in the basis table, the last two in the legacy table) are never a zero.
  for (const line of text.split("\n").filter((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l))) {
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    const flows = c.length === 11 ? c.slice(8, 10) : c.slice(-2);
    for (const f of flows) expect(f, line).not.toMatch(/^\$?0(\.00)?$/);
  }
}

describe("get_stock_activity comparability pass-through", () => {
  it("SPCX (first_reported): state, reason and flows reach structuredContent; text says no prior-quarter baseline", async () => {
    const { text, sc } = await call(envOf(spcx), "SPCX");
    const rest = (spcx as J).data.summary;
    expect(sc.latest.comparability).toBe("first_reported");
    expect(sc.latest.null_reason).toBeNull();
    expect(sc.latest.changes.comparability).toBe("first_reported");
    expect(sc.latest.changes.comparability_reason).toBe(rest.changes.comparability_reason);
    expect(sc.latest.changes.split_factor).toBeNull();
    expect(sc.latest.changes.price_corrected).toBe(false);
    expect(sc.latest.changes.null_reason).toBeNull();
    expect(sc.latest.changes.flow_excluded_filers).toBe(rest.changes.flow_excluded_filers);
    expect(sc.latest.changes.net_shares).toBe(rest.changes.net_shares);
    expect(sc.trend[0].comparability).toBe("first_reported");
    expect(text).toContain("- Comparability: first_reported -- first reported this quarter: no 13F filer held it last quarter, so there is no prior-quarter baseline");
    expect(text).toMatch(/\| 2026-06-30 \|.*\| first_reported \|$/m);
  });

  it("KLAC (split_adjusted, k=10): split factor in structuredContent and text", async () => {
    const { text, sc } = await call(envOf(klac), "KLAC");
    expect(sc.latest.comparability).toBe("split_adjusted");
    expect(sc.latest.changes.comparability).toBe("split_adjusted");
    expect(sc.latest.changes.split_factor).toBe(10);
    expect(sc.trend[0].changes.split_factor).toBe(10);
    expect(sc.latest.changes.comparability_reason).toMatch(/split factor/);
    expect(text).toContain("- Comparability: split_adjusted -- split factor 10: last quarter's shares were multiplied by 10 before classifying.");
    expect(text).toMatch(/\| split_adjusted \(x10\) \|$/m);
  });

  it("IVV (comparable): normal quarter keeps its numbers and says comparable", async () => {
    const { text, sc } = await call(envOf(ivv), "IVV");
    const rest = (ivv as J).data.summary;
    expect(sc.latest.comparability).toBe("comparable");
    expect(sc.latest.changes.comparability).toBe("comparable");
    expect(sc.latest.changes.split_factor).toBeNull();
    expect(sc.latest.net_shares).toBe(String(rest.netShares));
    expect(sc.latest.changes.net_value).toBe(rest.changes.net_value);
    expect(text).toContain("- Comparability: comparable");
    expect(text).not.toMatch(/: unknown|\| unknown \|/);
  });

  it("not_comparable: every flow stays null in structuredContent and reads 'unknown' (never 0) in the text", async () => {
    const { text, sc } = await call(notComparable(klac, "share_ratio_not_a_split_factor"), "KLAC");
    for (const r of [sc.latest, ...sc.trend]) {
      expect(r.comparability).toBe("not_comparable");
      expect(r.null_reason).toBe("share_ratio_not_a_split_factor");
      expect(r.net_shares).toBeNull();
      expect(r.net_value).toBeNull();
      expect(r.changes.comparability).toBe("not_comparable");
      expect(r.changes.null_reason).toBe("share_ratio_not_a_split_factor");
      for (const k of FLOW_KEYS) expect(r.changes[k]).toBeNull();
      // counts are kept
      expect(r.changes.holders).toBe((klac as J).data.summary.changes.holders);
    }
    for (const k of ["shares_added", "shares_removed", "value_added", "value_removed"]) expect(sc.latest[k]).toBeNull();
    expect(text).toContain("- Comparability: not_comparable -- share and value flows are withheld as unknown (share_ratio_not_a_split_factor), not zero.");
    expect(text).toContain("- Net shares: unknown | Net value: unknown");
    expect(text).toContain("- Shares added: unknown | Shares removed: unknown | Value added: unknown | Value removed: unknown");
    expect(text).toContain("Net shares: unknown | Net value: unknown"); // legacy note line
    expect(text).toMatch(/\| unknown \| unknown \| not_comparable \|$/m);
    expectNoZeroFlows(text);
  });

  it("changes=null (unknown / not_recomputable): structured `changes` is null, legacy flows null, text never 0", async () => {
    const { text, sc } = await call(changesNull(spcx), "SPCX");
    expect(sc.latest.changes).toBeNull();
    expect(sc.trend[0].changes).toBeNull();
    expect(sc.latest.comparability).toBe("unknown");
    expect(sc.latest.null_reason).toBe("not_recomputable");
    expect(sc.latest.net_shares).toBeNull();
    expect(sc.latest.value_added).toBeNull();
    // counts kept
    expect(sc.latest.institutions_new).toBe((spcx as J).data.summary.institutionsNew);
    expect(text).toContain("- Comparability: unknown -- share and value flows are unknown (not_recomputable), not zero.");
    expect(text).toContain("- Net shares: unknown | Net value: unknown");
    expect(text).toMatch(/\| unknown \| unknown \|$/m); // legacy trend row
    expectNoZeroFlows(text);
  });

  it("a genuine zero flow is still rendered as 0 (only null means unknown)", async () => {
    const env = envOf(ivv);
    env.data.summary.netShares = 0;
    env.data.trend[0].netShares = 0;
    const { text, sc } = await call(env, "IVV");
    expect(sc.latest.net_shares).toBe("0");
    expect(text).toMatch(/Net shares: 0 \|/);
  });
});

describe("get_stock_holders passes the equity_filer_baseline row view through", () => {
  it("equity_share_change null (NO_BASELINE) stays null; split-restated value and action pass through", async () => {
    // Shape of live api.ko.io /stock-holders/KLAC?type=holders (2026-09-29): the
    // all-legs share_change is not split-restated (+124,390,538 on a 10-for-1),
    // the equity view is (-594,865, TRIMMED).
    const rows = [
      {
        cik: "102909", name: "VANGUARD GROUP INC", slug: "vanguard-group-inc-102909", shares_held: 138277805,
        holding_value: 41719796546, share_change: 124390538, action: "ADDED", portfolio_weight_pct: 0.54,
        equity_shares: 138277805, call_shares: 0, put_shares: 0, has_option_legs: 0,
        equity_share_change: -594865, equity_action: "TRIMMED", flags: [],
      },
      {
        cik: "1", name: "NEW FILER LLC", slug: "new-filer-llc-1", shares_held: 1000, holding_value: 300000,
        share_change: 1000, action: "NEW", portfolio_weight_pct: 0.1, equity_shares: 1000, call_shares: 0,
        put_shares: 0, has_option_legs: 0, equity_share_change: null, equity_action: null, flags: ["NO_BASELINE"],
      },
    ];
    mock.mockResolvedValue({
      data: { data: rows, totalCount: 2, page: 1, per_page: 20, totalPages: 1, quarterDate: "2026-06-30" },
      meta: { entity_grain: "filer" },
    } as never);
    const config: KoConfig = { baseUrl: "https://api.ko.io", apiKey: "" };
    const server = new McpServer({ name: "ko-sec-data", version: "test" });
    registerStockTools(server, config);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.listTools();
    const r = (await client.callTool({ name: "get_stock_holders", arguments: { ticker: "KLAC" } })) as J;
    expect(r.isError ?? false).toBe(false);
    const [v, n] = r.structuredContent.rows;
    expect(v).toMatchObject({ share_change: "124390538", equity_share_change: "-594865", equity_action: "TRIMMED", flags: [] });
    expect(n).toMatchObject({ equity_share_change: null, equity_action: null, flags: ["NO_BASELINE"] });
  });
});
