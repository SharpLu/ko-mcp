import { describe, it, expect } from "vitest";
import {
  shapeOf,
  diffShape,
  normalizeLine,
  rawValuesIn,
  textSkeleton,
  contractOf,
  diffContract,
  checkDefect,
  assertLoopback,
  runGoldenGate,
  goldenDir,
  loadFixtures,
} from "../../contract/skeleton.mjs";
import { CASES, CASE_COUNT, EXCLUDED, PLAN_GATED_TOOLS, TOOLS } from "../../contract/cases.mjs";
import type { GoldenFixture } from "../../contract/skeleton.d.mts";

/**
 * Offline half of the golden contract harness.
 *
 * The blocking half (scripts/golden-gate.mjs) boots the Worker built from this
 * working tree and replays every case against it. This file checks everything
 * that does not need a network: that the comparison logic actually catches
 * breaks, that every tool has a fixture, that no fixture is vacuous, that no
 * fixture pins a defect as correct, and -- the one that matters most -- that no
 * committed skeleton carries a value that can move on its own.
 */

const fixtures: GoldenFixture[] = await loadFixtures(goldenDir());
const allCases = fixtures.flatMap((f) => f.cases.map((c) => ({ fixture: f, c })));

// The 24 tools the deploy health check counts, asserted independently of the
// manifest so the two cannot drift into agreeing with each other while both
// being wrong.
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

// ---------------------------------------------------------------------------

describe("value normalisation", () => {
  it("erases money, percents, dates, counts and accessions", () => {
    expect(normalizeLine("**Total institutional USD:** $28.24B")).toBe("**Total institutional USD:** <MONEY>");
    expect(normalizeLine("**Portfolio weight:** 4.86%")).toBe("**Portfolio weight:** <PCT>");
    expect(normalizeLine("**Latest quarter:** 2026-06-30")).toBe("**Latest quarter:** <DATE>");
    expect(normalizeLine("**Total holders:** 1481 · Page 1")).toBe("**Total holders:** <VAL> · Page <VAL>");
    expect(normalizeLine("## Filing 0000320193-25-000079 — CIK 320193")).toBe("## Filing <ACCESSION> — CIK <VAL>");
  });

  it("keeps the words, so a renamed label is still a break", () => {
    expect(normalizeLine("**Total institutional USD:** $1")).not.toBe(normalizeLine("**Total USD:** $1"));
  });

  it("keeps the HTTP status in an error, because that is a class and not a value", () => {
    expect(normalizeLine("ko.io API error (403): Access forbidden (check your plan)"))
      .toBe("ko.io API error (403): Access forbidden (check your plan)");
    expect(normalizeLine("*(excerpt unavailable: 403)*")).toBe("*(excerpt unavailable: 403)*");
    // ...and a 403 turning into a 404 must NOT normalise to the same thing.
    expect(normalizeLine("ko.io API error (403): x")).not.toBe(normalizeLine("ko.io API error (404): x"));
  });

  it("strips the variable part of a leaked upstream URL but keeps the error class", () => {
    expect(normalizeLine("ko.io API error (404): Not found: SEC did not publish: https://data.sec.gov/submissions/CIK99999999999.json"))
      .toBe("ko.io API error (404): Not found: SEC did not publish: <URL>");
  });

  it("rawValuesIn finds a value that escaped normalisation", () => {
    expect(rawValuesIn("TEXT **Total holders:** <VAL>")).toEqual([]);
    expect(rawValuesIn("TEXT **Total holders:** 1481")).toEqual(["1481"]);
    expect(rawValuesIn("H2 Q2026-06-30")).toEqual(["Q2026-06-30"]);
  });
});

describe("markdown skeleton", () => {
  const table = "## Head\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";

  it("collapses a table body -- row count is data, not contract", () => {
    const two = textSkeleton(table);
    const one = textSkeleton("## Head\n\n| A | B |\n|---|---|\n| 9 | 9 |\n");
    expect(two.lines).toEqual(one.lines);
    expect(two.lines).toEqual(["H2 Head", "BLANK", "THEAD A | B", "TBODY"]);
  });

  it("exposes the row count OUTSIDE the contract, for defect probes only", () => {
    expect(textSkeleton(table).tables[0].dataRows).toBe(2);
  });

  it("catches a renamed column", () => {
    const a = contractOf({ result: { content: [{ type: "text", text: table }] } });
    const b = contractOf({ result: { content: [{ type: "text", text: table.replace("| A |", "| Z |") }] } });
    expect(diffContract(a, b).join(" ")).toContain("THEAD");
  });

  it("catches a table that degenerated into a sentence (the upstream-rename signature)", () => {
    const a = contractOf({ result: { content: [{ type: "text", text: table }] } });
    const b = contractOf({ result: { content: [{ type: "text", text: "## Head\n\nNo results found." }] } });
    expect(diffContract(a, b).length).toBeGreaterThan(0);
  });

  it("catches a section that stopped rendering", () => {
    const a = contractOf({ result: { content: [{ type: "text", text: "## H\n\n### Stocks\n\n### Insiders" }] } });
    const b = contractOf({ result: { content: [{ type: "text", text: "## H\n\n### Stocks" }] } });
    expect(diffContract(a, b).join(" ")).toContain("REMOVED");
  });

  it("pins a zod -32602 body verbatim (schema-derived, so it carries no data)", () => {
    const s = textSkeleton('MCP error -32602: Input validation error: [\n  "maximum": 50\n]');
    expect(s.verbatim).toBe(true);
    expect(s.lines[1]).toContain("50");
  });

  it("is unmoved by a pure data change", () => {
    const a = contractOf({ result: { content: [{ type: "text", text: "## AAPL\n\n| D | C |\n|---|---|\n| 2026-01-01 | $1.00 |" }] } });
    const b = contractOf({ result: { content: [{ type: "text", text: "## AAPL\n\n| D | C |\n|---|---|\n| 2026-09-12 | $999.99 |\n| 2026-09-11 | $3.00 |" }] } });
    expect(diffContract(a, b)).toEqual([]);
  });
});

describe("envelope shape", () => {
  it("catches isError appearing", () => {
    const ok = contractOf({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x" }] } });
    const err = contractOf({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "x" }], isError: true } });
    const d = diffContract(ok, err);
    expect(d.join(" ")).toContain("isError");
  });

  it("catches a content block type flip", () => {
    const a = contractOf({ result: { content: [{ type: "text", text: "x" }] } });
    const b = contractOf({ result: { content: [{ type: "resource", text: "x" }] } });
    expect(diffContract(a, b).join(" ")).toContain("content types");
  });

  it("never compares the rendered text as a value (shapeOf/diffShape sanity)", () => {
    expect(shapeOf({ a: "x" })).toEqual(shapeOf({ a: "totally different" }));
    expect(diffShape(shapeOf({ v: 1 }), shapeOf({ v: "1" }))).toEqual(["(root).v: expected number, got string"]);
  });
});

// ---------------------------------------------------------------------------

describe("fixtures", () => {
  it("one fixture per tool, and exactly the 24 tools the deploy check counts", () => {
    expect(fixtures.map((f) => f.tool).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(TOOLS.sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("fixtures on disk match the manifest, tool for tool and case for case", () => {
    expect(fixtures.length).toBe(CASES.length);
    expect(allCases.length).toBe(CASE_COUNT);
    const manifest = new Map(CASES.map((t) => [t.tool, t.cases.map((c) => c.name)]));
    const drift: string[] = [];
    for (const f of fixtures) {
      const want = manifest.get(f.tool);
      if (!want) { drift.push(`${f.tool}: fixture with no manifest entry`); continue; }
      const have = f.cases.map((c) => c.name);
      if (want.join(",") !== have.join(",")) drift.push(`${f.tool}: [${have}] != manifest [${want}]`);
    }
    expect(drift, `run npm run golden:capture\n${drift.join("\n")}`).toEqual([]);
  });

  it("is not vacuous -- every case carries arguments, a reason and a contract", () => {
    const thin = allCases
      .filter(({ c }) => !c.contract || !c.contract.blocks?.length || !c.why || c.why.length < 20 || !c.arguments)
      .map(({ fixture, c }) => `${fixture.tool}.${c.name}`);
    expect(thin, thin.join("\n")).toEqual([]);
  });

  it("records where each pinned body came from", () => {
    for (const f of fixtures) {
      expect(f.provenance?.source, f.tool).toBeTruthy();
      expect(["recordings", "build"]).toContain(f.provenance?.mode);
      expect(f.provenance?.note?.length ?? 0, f.tool).toBeGreaterThan(40);
    }
  });

  /**
   * The mechanical half of the anti-flake property.
   *
   * ko-api#236 shipped a fixture containing `meta.cached`, a field emitted only
   * on a cache hit, and the gate became a coin flip the same night. Nothing
   * caught it because nothing looked at the committed fixture. This does: every
   * skeleton line of every case, scanned for a token that still carries a
   * digit. A price, a total, a date or a row count in a fixture fails HERE,
   * offline, before it can ever be a 03:41Z failure on a byte-identical build.
   */
  it("no committed skeleton carries a raw value (the meta.cached class, ko-api#236)", () => {
    const leaks: string[] = [];
    for (const { fixture, c } of allCases) {
      for (const b of c.contract.blocks) {
        for (const line of b.lines) {
          const raw = rawValuesIn(line);
          if (raw.length) leaks.push(`${fixture.tool}.${c.name}: ${line}  -> ${raw.join(", ")}`);
        }
      }
    }
    expect(leaks, `these fixtures pin something that moves on its own:\n${leaks.join("\n")}`).toEqual([]);
  });

  it("no fixture pins a 5xx as the contract", () => {
    const bad: string[] = [];
    for (const { fixture, c } of allCases) {
      for (const b of c.contract.blocks) {
        for (const line of b.lines) {
          if (/ko\.io API error \(5\d{2}\)/.test(line)) bad.push(`${fixture.tool}.${c.name}: ${line}`);
        }
      }
    }
    expect(bad, `a 5xx is an outage, never a contract:\n${bad.join("\n")}`).toEqual([]);
  });

  it("every tool pins at least one populated, non-error answer", () => {
    // The failure this whole gate exists for is a tool that renders an empty
    // shell. A tool whose every pinned case is an error or an empty result
    // would pass such a regression, so each one must pin at least one case that
    // has a table or more than a couple of structural lines.
    const hollow = fixtures
      .filter((f) => !f.cases.some((c) =>
        !c.contract.isError && c.contract.blocks.some((b) => b.tables.length > 0 || b.lines.length >= 4)))
      .map((f) => f.tool);
    // The 5 plan-gated tools cannot reach data from the free tier, by design.
    expect(hollow.sort(), `no populated contract pinned for:\n${hollow.join("\n")}`)
      .toEqual([...PLAN_GATED_TOOLS].sort());
  });
});

describe("plan-gated tools are labelled, so nobody mistakes a 403 for coverage", () => {
  it("all five pin the gate and are flagged as such", () => {
    expect(PLAN_GATED_TOOLS.sort()).toEqual(
      ["get_economic_indicators", "get_fed_rates", "get_financial_stress", "get_treasury_yields", "sec_get_filing_document"],
    );
    for (const tool of PLAN_GATED_TOOLS) {
      const f = fixtures.find((x) => x.tool === tool)!;
      expect(f.planGated, `${tool} must be flagged planGated`).toBe(true);
      const normal = f.cases.find((c) => c.name === "normal")!;
      expect(normal.contract.isError, `${tool}.normal should be the 403 gate`).toBe(true);
      const text = normal.contract.blocks[0].lines.join(" ");
      expect(text, `${tool}.normal pins something other than the plan gate`).toContain("ko.io API error (403)");
      expect(normal.why).toContain("PLAN GATE");
    }
  });

  it("a fixture flagged planGated is one of the four, and vice versa", () => {
    expect(fixtures.filter((f) => f.planGated).map((f) => f.tool).sort()).toEqual([...PLAN_GATED_TOOLS].sort());
  });
});

// ---------------------------------------------------------------------------

describe("known defects are annotated, never pinned", () => {
  const annotated = allCases.filter(({ c }) => c.knownDefect);

  it("every annotation names an issue or an audit section and gives a real reason", () => {
    // Was 7 at capture. ko-bastion#126 retired 4 of them -- the three inert-`limit`
    // cases and get_ftd_data's silent-truncation case -- by fixing the bug and
    // re-pinning the corrected rendering, which is the only way an annotation is
    // ever allowed to leave this set. The floor only moves DOWN, and only in the
    // PR that fixes the defect it was describing.
    // 7 -> 3 (#126 retired four) -> 2 (#125 retired its last one). All that is
    // left is the headed-empty-table warning, which has no issue filed.
    // 2 -> 1 (2026-09-26) WITHOUT a fix: get_congress_member.empty (page 9999)
    // became a keyless 403 SIGNIN_REQUIRED under ko-api's soft wall, so the gate
    // can no longer observe that tool's headed empty table. The defect itself is
    // still asserted offline by registry-defects.test.ts.
    expect(annotated.length).toBeGreaterThanOrEqual(1);
    const bad: string[] = [];
    for (const { fixture, c } of annotated) {
      const d = c.knownDefect!;
      if (!/#\d+|section \d/.test(d.issue)) bad.push(`${fixture.tool}.${c.name}: issue '${d.issue}' names nothing`);
      if ((d.summary?.length ?? 0) < 80) bad.push(`${fixture.tool}.${c.name}: summary too thin to be a reason`);
      if (!d.probe?.kind) bad.push(`${fixture.tool}.${c.name}: no probe, so fixing the bug would pass silently`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("the still-open audited defects are represented, and the fixed one is not", () => {
    const issues = new Set(annotated.map(({ c }) => c.knownDefect!.issue));
    expect([...issues].some((i) => i.includes("warning 5"))).toBe(true); // headed empty table
    // ko-bastion#125 is FIXED (search + executive_cik bound by ko-api#260) or
    // DELETED (party/state removed from the schema). Same absence assertion as
    // #126 below: a fixture that starts claiming #125 again is a regression or a
    // stale annotation, and both must fail here rather than read as normal.
    expect([...issues].some((i) => i.includes("#125"))).toBe(false);
    // ko-bastion#126 (inert `limit` / silent days-window truncation) is FIXED, so
    // no fixture may still claim it is live. Asserting its ABSENCE is the same
    // trick the annotations themselves use, pointed the other way: a fixture that
    // starts annotating #126 again is either a regression someone papered over or
    // a stale annotation, and both should fail here rather than read as normal.
    expect([...issues].some((i) => i.includes("#126"))).toBe(false);
    // ko-bastion#127 (no timeout) was never annotated -- it has no signature in
    // a response body, only in latency -- and its case was excluded instead.
    // Now that koFetch is bounded, the case is PINNED rather than excluded, and
    // this asserts the exclusion is gone so it cannot quietly come back.
    expect(Object.keys(EXCLUDED)).not.toContain("sec_get_filing_index.empty");
  });

  it("a probe passes while the defect is present and FAILS once it is fixed", () => {
    const fifty = contractOf({
      result: { content: [{ type: "text", text: `| A |\n|---|\n${"| x |\n".repeat(50)}` }] },
    });
    const five = contractOf({
      result: { content: [{ type: "text", text: `| A |\n|---|\n${"| x |\n".repeat(5)}` }] },
    });
    expect(checkDefect({ kind: "dataRowCount", equals: 50 }, "normal", fifty, {})).toBeNull();
    expect(checkDefect({ kind: "dataRowCount", equals: 50 }, "normal", five, {})).toContain("5 data rows");

    const same = { normal: "feed", empty: "feed" };
    const diff = { normal: "musk only", empty: "feed" };
    expect(checkDefect({ kind: "identicalToCase", case: "empty" }, "normal", fifty, same)).toBeNull();
    expect(checkDefect({ kind: "identicalToCase", case: "empty" }, "normal", fifty, diff))
      .toContain("argument is being honoured");

    const headed = contractOf({ result: { content: [{ type: "text", text: "| A |\n|---|" }] } });
    const soft = contractOf({ result: { content: [{ type: "text", text: "No results found." }] } });
    expect(checkDefect({ kind: "headerWithoutRows" }, "empty", headed, {})).toBeNull();
    expect(checkDefect({ kind: "headerWithoutRows" }, "empty", soft, {})).toContain("no longer a headed empty table");
  });

  it("the #125 pair now DIFFERS, which is what the fix looks like from here", () => {
    // Before ko-api#260 these two cases rendered the same unfiltered feed, and
    // that equality was the defect probe. The probe could not survive its own
    // fix: after the repair both sides are byte-identical AGAIN, because both
    // are now EMPTY -- an equality is invariant under "both sides became
    // nothing". So the assertion is inverted rather than deleted.
    //
    // `normal` is search=Cook (24 rows live) precisely so the two cases cannot
    // collapse back into sameness without someone noticing.
    const f = fixtures.find((x) => x.tool === "list_insider_traders")!;
    const normal = f.cases.find((c) => c.name === "normal")!;
    const empty = f.cases.find((c) => c.name === "empty")!;
    expect(normal.knownDefect).toBeUndefined();
    expect(JSON.stringify(normal.contract.blocks)).not.toBe(JSON.stringify(empty.contract.blocks));
    expect(JSON.stringify(f)).not.toContain("17,744"); // the unfiltered total the audit measured
  });
});

describe("exclusions", () => {
  it("every excluded case names a real tool and gives a substantive reason", () => {
    const toolSet = new Set(TOOLS);
    const bad: string[] = [];
    for (const [id, reason] of Object.entries(EXCLUDED)) {
      const [tool, name] = id.split(".");
      if (!toolSet.has(tool)) bad.push(`${id}: not a tool`);
      if (!name) bad.push(`${id}: not a <tool>.<case> id`);
      if (!reason || reason.trim().length < 120) bad.push(`${id}: reason too thin to be a reason`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("an excluded case is not also pinned", () => {
    const pinned = new Set(allCases.map(({ fixture, c }) => `${fixture.tool}.${c.name}`));
    const both = Object.keys(EXCLUDED).filter((id) => pinned.has(id));
    expect(both, `excluded and pinned at the same time:\n${both.join("\n")}`).toEqual([]);
  });

  it("there are exactly the two structural exclusions left", () => {
    // Was three. `sec_get_filing_index.empty` came back on 2026-09-12 when
    // ko-bastion#127 bounded koFetch: the 404-vs-502 split it was excluded for
    // was an unbounded wait, not a property of the input, and a bounded proxy
    // answers 404 or names its own timeout -- never an inherited 5xx. The two
    // that remain are structural (a tool with no empty input; a result that
    // depends on what SEC published), not flakes waiting on a fix.
    expect(Object.keys(EXCLUDED).sort()).toEqual([
      "get_crypto_exposure.empty",
      "get_ftd_data.normal",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("the gate cannot grade a stale artefact", () => {
  it("refuses any base that is not loopback (ko-api#231 is unreachable, not mitigated)", () => {
    expect(() => assertLoopback("https://mcp.ko.io")).toThrow(/loopback/);
    expect(() => assertLoopback("https://example.com:8787")).toThrow(/loopback/);
    expect(() => assertLoopback("http://127.0.0.1:1234")).not.toThrow();
    expect(() => assertLoopback("http://localhost:1234")).not.toThrow();
  });

  it("runGoldenGate will not even start against a remote base", async () => {
    await expect(runGoldenGate([], { base: "https://mcp.ko.io" })).rejects.toThrow(/loopback/);
  });
});

describe("gate runner (offline, injected fetch)", () => {
  const text = "## H\n\n| A | B |\n|---|---|\n| 1 | 2 |";
  const fx = [{
    tool: "probe", planGated: false, capturedAt: "test",
    provenance: { source: "test", mode: "build", note: "x".repeat(50) },
    cases: [{
      name: "normal", arguments: {}, why: "unit test fixture",
      contract: contractOf({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    }],
  }];

  const reply = (body: unknown) => (async () => ({
    status: 200,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;

  it("passes when only the values moved", async () => {
    const r = await runGoldenGate(fx as never, {
      base: "http://127.0.0.1:1",
      fetchImpl: reply({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "## H\n\n| A | B |\n|---|---|\n| 9 | 9 |\n| 8 | 8 |" }] } }),
    });
    expect(r.failures).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it("fails when a column is renamed", async () => {
    const r = await runGoldenGate(fx as never, {
      base: "http://127.0.0.1:1",
      fetchImpl: reply({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "## H\n\n| A | Z |\n|---|---|\n| 1 | 2 |" }] } }),
    });
    expect(r.failures[0].problems.join(" ")).toContain("THEAD");
  });

  it("fails when a success envelope becomes an error envelope", async () => {
    const r = await runGoldenGate(fx as never, {
      base: "http://127.0.0.1:1",
      fetchImpl: reply({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ko.io API error (500): Upstream error" }], isError: true } }),
    });
    expect(r.failures[0].problems.join(" ")).toContain("isError");
  });

  it("reports an unanswering worker as unreachable and never as intact", async () => {
    const throwing = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r = await runGoldenGate(fx as never, { base: "http://127.0.0.1:1", fetchImpl: throwing });
    expect(r.checked).toBe(0);
    expect(r.unreachable).toHaveLength(1);
  });
});
