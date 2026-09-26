/**
 * get_stock_activity `changes` (PLAN_DATA 1.2 / 2A / 3, consistency gate 5(2)).
 *
 * Two replays of the ko-api response for NVDA 2026-06-30:
 *   - OLD = live api.ko.io `?type=activity&demo=true` captured 2026-09-26 (no `changes`);
 *   - NEW = the REAL payload of the ko-api branch handlers (fix/data-api-consistency)
 *     run on A1 data (codex-studio/final-review2/replays/nvda_activity_new.json):
 *     the same legacy fields plus `changes` and meta.definitions.
 * The OLD replay must render byte-identically to the pre-change tool (the expected
 * snapshot was produced by the unmodified handler), and in both replays every
 * number in the text must equal the number in structuredContent.
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
import { fmtMoney, fmtShares, fmtPct2 } from "../format.js";
import { fmtIntExact } from "../paging.js";
import { makeFakeServer, textOf } from "./helpers.js";
import oldReplay from "./fixtures/nvda_activity_old.json";
import newReplay from "./fixtures/nvda_activity_new.json";
import oldExpected from "./fixtures/nvda_activity_old.expected.json";

const mock = vi.mocked(koFetch);
beforeEach(() => mock.mockReset());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const envOf = (f: J) => ({ data: f.data, meta: f.meta });

const OLD: J = oldReplay;
const NEW: J = newReplay;
const OLD_EXPECTED: J = oldExpected;

/** Through a REAL McpServer + Client: the SDK validates structuredContent against outputSchema. */
async function callReal(env: unknown, args: Record<string, unknown> = { ticker: "NVDA" }) {
  mock.mockResolvedValue(env as never);
  const config: KoConfig = { baseUrl: "https://api.ko.io", apiKey: "" };
  const server = new McpServer({ name: "ko-sec-data", version: "test" });
  registerStockTools(server, config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  await client.listTools();
  const r = (await client.callTool({ name: "get_stock_activity", arguments: args })) as J;
  expect(r.isError ?? false).toBe(false);
  return { text: (r.content as Array<{ text: string }>).map((c) => c.text).join("\n"), sc: r.structuredContent as J };
}

/** `| a | b | ... |` -> cells. */
const cells = (line: string) => line.split("|").slice(1, -1).map((c) => c.trim());
const lineWith = (text: string, prefix: string) => {
  const l = text.split("\n").find((x) => x.startsWith(prefix));
  expect(l, `line starting with ${prefix}`).toBeDefined();
  return l!;
};
const field = (line: string, label: string) => {
  const m = line.match(new RegExp(`${label.replace(/[()]/g, "\\$&")}: ([^|]+?)(?: \\||$)`));
  expect(m, `${label} in ${line}`).not.toBeNull();
  return m![1].trim();
};

describe("get_stock_activity OLD replay (ko-api without `changes`)", () => {
  it("text and structuredContent are byte-identical to the pre-change output", async () => {
    const { text, sc } = await callReal(envOf(OLD));
    expect(text).toBe(OLD_EXPECTED.text);
    expect(sc).toEqual(OLD_EXPECTED.sc);
    expect(text).not.toMatch(/equity_filer_baseline|Basis:|no_baseline|baseline/i);
    expect(JSON.stringify(sc)).not.toContain('"changes"');
  });

  it("text numbers == structuredContent numbers", async () => {
    const { text, sc } = await callReal(envOf(OLD));
    const L = sc.latest;
    const inc = lineWith(text, "- Institutions increased:");
    expect(Number(field(inc, "Institutions increased"))).toBe(L.institutions_increased);
    expect(Number(field(inc, "Decreased"))).toBe(L.institutions_decreased);
    const np = lineWith(text, "- New positions:");
    expect(Number(field(np, "New positions"))).toBe(L.institutions_new);
    expect(Number(field(np, "Exited"))).toBe(L.institutions_exited);
    const net = lineWith(text, "- Net shares:");
    expect(field(net, "Net shares")).toBe(fmtShares(L.net_shares));
    expect(field(net, "Net value")).toBe(fmtMoney(L.net_value));
    const row = cells(lineWith(text, `| ${sc.trend[0].quarter} |`));
    const t = sc.trend[0];
    expect(row).toEqual([
      t.quarter, String(t.institutions_increased), String(t.institutions_decreased), String(t.institutions_new),
      String(t.institutions_exited), fmtShares(t.net_shares), fmtMoney(t.net_value),
    ]);
  });
});

describe("get_stock_activity NEW replay (ko-api with `changes`)", () => {
  it("is additive: every legacy structuredContent path/type/value is unchanged", async () => {
    const { sc } = await callReal(envOf(NEW));
    const strip = (o: J) => {
      const { changes: _c, ...rest } = o; // eslint-disable-line @typescript-eslint/no-unused-vars
      return rest;
    };
    expect({ ...sc, latest: strip(sc.latest), trend: sc.trend.map(strip) }).toEqual(OLD_EXPECTED.sc);
  });

  it("passes `changes` through with the same names and values as REST", async () => {
    const { sc } = await callReal(envOf(NEW));
    expect(sc.latest.changes).toEqual(NEW.data.summary.changes);
    expect(sc.trend.map((r: J) => r.changes)).toEqual(NEW.data.trend.map((r: J) => r.changes));
    const REAL = {
      basis: "equity_filer_baseline", new: 211, added: 3001, trimmed: 2353, exited: 114, unchanged: 322,
      no_baseline: 93, holders: 5980, shares_added: 518713045, shares_removed: 402146859, net_shares: 116566186,
      value_added: 103789291274, value_removed: 80465563545, net_value: 23323727729,
    };
    expect(sc.latest.changes).toStrictEqual(REAL);
    expect(sc.trend[0].changes).toStrictEqual(REAL);
    // The replay's own legacy fields are the live (old) ones, untouched by the new basis.
    expect(NEW.data.summary).toMatchObject(OLD.data.summary);
  });

  it("first text line states the basis; changes are listed first, legacy counts kept as a note", async () => {
    const { text } = await callReal(envOf(NEW));
    const lines = text.split("\n");
    expect(NEW.meta.definitions.changes.startsWith("changes (basis equity_filer_baseline): ")).toBe(true);
    expect(lines[0]).toBe(
      `Basis: equity_filer_baseline -- ${NEW.meta.definitions.changes.slice("changes (basis equity_filer_baseline): ".length)}`,
    );
    const iChanges = lines.findIndex((l) => l.startsWith("- New positions:"));
    const iLegacy = lines.findIndex((l) => l.startsWith("- Note -- legacy counts"));
    expect(iChanges).toBeGreaterThan(0);
    expect(iLegacy).toBeGreaterThan(iChanges);
    expect(lines[iLegacy]).toContain("Institutions increased (incl. new): 3292");
    expect(lines[iLegacy]).toContain("Decreased (incl. exited): 2480");
  });

  it("text numbers == structuredContent numbers (changes and legacy)", async () => {
    const { text, sc } = await callReal(envOf(NEW));
    const C = sc.latest.changes;
    const np = lineWith(text, "- New positions:");
    expect(Number(field(np, "New positions"))).toBe(C.new);
    expect(Number(field(np, "Added"))).toBe(C.added);
    expect(Number(field(np, "Trimmed"))).toBe(C.trimmed);
    expect(Number(field(np, "Exited"))).toBe(C.exited);
    expect(Number(field(np, "Unchanged"))).toBe(C.unchanged);
    const nb = lineWith(text, "- No prior-quarter baseline");
    expect(Number(field(nb, "No prior-quarter baseline (not classified)"))).toBe(C.no_baseline);
    expect(Number(field(nb, "Holders"))).toBe(C.holders);
    const net = lineWith(text, "- Net shares:");
    expect(field(net, "Net shares")).toBe(`${fmtShares(C.net_shares)} (${fmtIntExact(C.net_shares)})`);
    expect(field(net, "Net value")).toBe(fmtMoney(C.net_value));
    const amt = lineWith(text, "- Shares added:");
    expect(field(amt, "Shares added")).toBe(fmtShares(C.shares_added));
    expect(field(amt, "Shares removed")).toBe(fmtShares(C.shares_removed));
    expect(field(amt, "Value added")).toBe(fmtMoney(C.value_added));
    expect(field(amt, "Value removed")).toBe(fmtMoney(C.value_removed));

    const L = sc.latest;
    const legacy = lineWith(text, "- Note -- legacy counts");
    expect(Number(field(legacy, "Institutions increased (incl. new)"))).toBe(L.institutions_increased);
    expect(Number(field(legacy, "Decreased (incl. exited)"))).toBe(L.institutions_decreased);
    expect(Number(field(legacy, "New"))).toBe(L.institutions_new);
    expect(Number(field(legacy, "Exited"))).toBe(L.institutions_exited);
    expect(field(legacy, "Net shares")).toBe(fmtShares(L.net_shares));
    expect(field(legacy, "Net value")).toBe(fmtMoney(L.net_value));

    // Two trend tables: basis first, then the legacy note table.
    const rows = text.split("\n").filter((l) => l.startsWith(`| ${sc.trend[0].quarter} |`)).map(cells);
    expect(rows).toHaveLength(2);
    const t = sc.trend[0];
    const c = t.changes;
    expect(rows[0]).toEqual([
      t.quarter, ...[c.new, c.added, c.trimmed, c.exited, c.unchanged, c.no_baseline, c.holders].map(String),
      fmtShares(c.net_shares), fmtMoney(c.net_value),
    ]);
    expect(rows[1]).toEqual([
      t.quarter, String(t.institutions_increased), String(t.institutions_decreased), String(t.institutions_new),
      String(t.institutions_exited), fmtShares(t.net_shares), fmtMoney(t.net_value),
    ]);
  });

  it("falls back to its own definition when meta.definitions is absent", async () => {
    const { text } = await callReal({ data: NEW.data, meta: OLD.meta });
    expect(text.split("\n")[0]).toMatch(/^Basis: equity_filer_baseline -- common stock only \(option legs excluded\); one holder per filer CIK;/);
  });

  it("does not repeat the basis name when ko-api's definition starts with it", async () => {
    const meta = { ...NEW.meta, definitions: { changes: "equity_filer_baseline: Common stock only." } };
    const { text } = await callReal({ data: NEW.data, meta });
    expect(text.split("\n")[0]).toBe("Basis: equity_filer_baseline -- Common stock only.");
  });

  it("a trend row without `changes` keeps its legacy fields and renders dashes", async () => {
    const data = structuredClone(NEW.data);
    data.trend.push({ ...structuredClone(OLD.data.trend[0]), quarter: "2026-03-31" });
    const { text, sc } = await callReal({ data, meta: NEW.meta }, { ticker: "NVDA", quarters: 2 });
    expect(sc.trend[1].changes).toBeUndefined();
    expect(sc.trend[1].institutions_increased).toBe(3292);
    expect(text).toContain("| 2026-03-31 | — | — | — | — | — | — | — | — | — |");
    expect(text).toContain("| 2026-03-31 | 3292 | 2480 | 274 | 115 | 194.70M | $38.96B |");
  });
});

describe("percentages display at 2 decimals (PLAN_DATA 2E.3), structuredContent keeps the served value", () => {
  it("fmtPct2", () => {
    expect(fmtPct2(12.620000000000001)).toBe("12.62");
    expect(fmtPct2("45.2")).toBe("45.20");
    expect(fmtPct2(null)).toBe("—");
    expect(fmtPct2(undefined)).toBe("—");
  });

  it("get_stock_holders renders portfolio_weight_pct 12.620000000000001 as 12.62%", async () => {
    mock.mockResolvedValue({
      data: [{ cik: "1", name: "Filer A", shares_held: "100", holding_value: "1000", share_change: "0", action: "HOLD", portfolio_weight_pct: 12.620000000000001 },
             { cik: "2", name: "Filer B", shares_held: "100", holding_value: "1000", share_change: "0", action: "HOLD", portfolio_weight_pct: "3.1" }],
      totalCount: 2, page: 1, per_page: 20, totalPages: 1, quarterDate: "2026-06-30",
    });
    const { server, tools } = makeFakeServer();
    registerStockTools(server, { baseUrl: "https://api.ko.io", apiKey: "" });
    const r = await tools.get("get_stock_holders")!.handler({ ticker: "NVDA" });
    const out = textOf(r);
    expect(out).toContain("| 12.62% |");
    expect(out).toContain("| 3.10% |");
    expect(out).not.toContain("12.620000000000001");
    expect(JSON.stringify(r.structuredContent)).toContain("12.620000000000001");
  });
});
