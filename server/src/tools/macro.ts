import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, type KoConfig } from "../ko-fetch.js";
import { pagingOf, pagingLines, windowLine, planLimitOf, dec, fmtIntExact } from "../paging.js";
import { FTD_OUTPUT, TREASURY_YIELDS_OUTPUT, FED_RATES_OUTPUT, ECONOMIC_OUTPUT, STRESS_OUTPUT } from "../output-schemas.js";
import { str } from "../paging.js";

// ---------------------------------------------------------------------------
// Paging for the `days`-window tools (ko-bastion#126, silent-truncation half)
//
// Three of the five macro routes paginate: /sec/ftd, /economic/indicators and
// /stress/ofr all read `page` + `per_page` and cap a page at their own 50-row
// default when neither is sent. These tools sent neither, so a caller asking for
// `days: 1825` was handed the first 50 settlement dates, rendered as a complete
// table, with nothing in the output saying a page boundary had been crossed and
// no parameter that could reach the rest -- get_ftd_data{GME, days:1825} showed
// 50 rows of a 1,025-row answer. A model reads that as the whole window.
//
// The other two (/treasury/yields, /fed/rates) do NOT paginate: they run
// `LIMIT {days}`, so `days` already governs the row count there and those two
// tools are deliberately left alone.
//
// Page size, not a global cap: `limit` is what the caller asks for, `per_page`
// is what ko-api reads, and a page that comes back full says so and names the
// next page. ko-api clamps per_page at 500, which is why `limit` stops there.
// ---------------------------------------------------------------------------
const PAGE_SCHEMA = {
  page: z.number().int().min(1).optional().default(1).describe("Page number (default 1)"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(100)
    .describe(
      "Rows per page, 1-500 (default 100). A long `days` window can hold more rows than one page; " +
      "the answer says when the page is full and names the next one."
    ),
};

/**
 * Disclosure line for a full page, or null.
 *
 * Deliberately claims only what this Worker can actually know. The honest
 * "showing N of M" needs `meta.total_count`, and koFetch discards `meta` when it
 * unwraps ko-api's `{ data, meta }` envelope; ko-fetch.ts is being changed under
 * ko-bastion#127 in a separate PR, so this one does not touch it. A page that
 * came back exactly full is evidence of a boundary and nothing more -- which is
 * what this says. Upgrade to a true total when koFetch surfaces meta.
 */
function pageNote(rows: number, limit: number, page: number): string | null {
  if (rows !== limit) return null;
  return `\n*Full page of ${limit} rows — more may exist; use page=${page + 1}.*`;
}

export function registerMacroTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_treasury_yields
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_treasury_yields",
    "Get U.S. Treasury yield curve data — daily yields for maturities from 1-month to 30-year. Essential for understanding interest rate environment and yield curve shape.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .default(30)
        .describe("Days of daily history to return, 1-3650 (default 30 = last month)"),
    },
    async ({ days }) => {
      const rows = await koFetch<TreasuryYieldRow[]>(
        config,
        "/api/v1/treasury/yields",
        { days }
      );

      const treasury = {
        unit: "percent" as const,
        rows: (Array.isArray(rows) ? rows : []).map((r) => ({
          date: str(r.date), m1: dec(r.m1), m3: dec(r.m3), m6: dec(r.m6), y1: dec(r.y1), y2: dec(r.y2),
          y5: dec(r.y5), y10: dec(r.y10), y30: dec(r.y30),
        })),
      };
      if (!rows || rows.length === 0) {
        return { content: [{ type: "text", text: "No Treasury yield data available." }], structuredContent: treasury };
      }

      const lines: string[] = [
        "## U.S. Treasury Yield Curve",
        "",
        "| Date | 1M | 3M | 6M | 1Y | 2Y | 5Y | 10Y | 30Y |",
        "|------|-----|-----|-----|-----|-----|-----|------|------|",
      ];

      for (const r of rows) {
        lines.push(
          `| ${r.date} | ${fmtYield(r.m1)} | ${fmtYield(r.m3)} | ${fmtYield(r.m6)} | ${fmtYield(r.y1)} | ${fmtYield(r.y2)} | ${fmtYield(r.y5)} | ${fmtYield(r.y10)} | ${fmtYield(r.y30)} |`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: treasury };
    },
    { outputSchema: TREASURY_YIELDS_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: get_fed_rates
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_fed_rates",
    "Get daily U.S. policy and money-market interest rates as a markdown table: Effective Fed Funds Rate, SOFR, Prime Rate, and benchmark Treasury yields (3M, 2Y, 10Y, 30Y) per date, newest first. Use for monetary-policy questions like 'Where is the Fed funds rate now?' or 'How has SOFR moved this quarter?', or to compare policy rates against long-end yields for inversion analysis. Covers up to 10 years of daily history. For the full Treasury curve across all maturities, use get_treasury_yields instead.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .default(30)
        .describe("Number of days of history (default 30)"),
    },
    async ({ days }) => {
      const rows = await koFetch<FedRateRow[]>(
        config,
        "/api/v1/fed/rates",
        { days }
      );

      const fed = {
        unit: "percent" as const,
        rows: (Array.isArray(rows) ? rows : []).map((r) => ({
          date: str(r.date), fed_funds_rate: dec(r.fed_funds_rate), sofr: dec(r.sofr), prime_rate: dec(r.prime_rate),
          treasury_3m: dec(r.treasury_3m), treasury_2y: dec(r.treasury_2y), treasury_10y: dec(r.treasury_10y),
          treasury_30y: dec(r.treasury_30y),
        })),
      };
      if (!rows || rows.length === 0) {
        return { content: [{ type: "text", text: "No Federal Reserve rate data available." }], structuredContent: fed };
      }

      const lines: string[] = [
        "## Federal Reserve Interest Rates",
        "",
        "| Date | Fed Funds | SOFR | Prime | 3M T-Bill | 2Y | 10Y | 30Y |",
        "|------|-----------|------|-------|-----------|-----|------|------|",
      ];

      for (const r of rows) {
        lines.push(
          `| ${r.date} | ${fmtYield(r.fed_funds_rate)} | ${fmtYield(r.sofr)} | ${fmtYield(r.prime_rate)} | ${fmtYield(r.treasury_3m)} | ${fmtYield(r.treasury_2y)} | ${fmtYield(r.treasury_10y)} | ${fmtYield(r.treasury_30y)} |`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: fed };
    },
    { outputSchema: FED_RATES_OUTPUT },
  );

  // get_short_volume tool removed 2026-06-14: backing FINRA short-volume DAG was
  // retired and market.finra_short_volume dropped, so /api/v1/finra/short-volume
  // 404s. Tool removed rather than serve a dead endpoint. Restore both the DAG
  // and the endpoint if short-volume data is reinstated.

  // ---------------------------------------------------------------------------
  // Tool: get_economic_indicators
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_economic_indicators",
    "Get U.S. economic indicators from BLS — CPI (inflation), PPI (producer prices), Non-farm Payrolls (employment), Unemployment Rate, JOLTS. Filter by category.",
    {
      category: z
        .preprocess((v) => {
          if (v == null) return v;
          const s = String(v).toLowerCase().trim();
          const map: Record<string, string> = {
            cpi: "cpi",
            inflation: "cpi",
            ppi: "ppi",
            "producer prices": "ppi",
            nfp: "nfp",
            payrolls: "nfp",
            "nonfarm payrolls": "nfp",
            "non-farm payrolls": "nfp",
            employment: "nfp",
            jobs: "nfp",
            unemployment: "unemployment",
            "unemployment rate": "unemployment",
            jobless: "unemployment",
            jolts: "jolts",
            "job openings": "jolts",
            all: "all",
            any: "all",
            "": "all",
          };
          return map[s] ?? s;
        }, z.enum(["cpi", "unemployment", "nfp", "ppi", "jolts", "all"]))
        .optional()
        .default("all")
        .describe(
          "Category (case-insensitive): cpi/inflation, ppi, nfp/payrolls, unemployment, jolts, or all"
        ),
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .default(365)
        .describe("Number of days of history (default 365)"),
      ...PAGE_SCHEMA,
    },
    async ({ category, days, page, limit }) => {
      const env = asEnvelope<EconomicRow[]>(
        await koFetch<unknown>(
          config,
          "/api/v1/economic/indicators",
          { category: category === "all" ? undefined : category, days, page, per_page: limit },
          { envelope: true },
        ),
      );
      const rows = Array.isArray(env.data) ? env.data : [];
      const econPaging = pagingOf(env.meta, { page, limit, returned: rows.length });
      const econ = {
        category,
        rows: rows.map((r) => ({
          date: str(r.date), series_id: str(r.series_id), series_name: str(r.series_name), value: dec(r.value), category: str(r.category),
        })),
        paging: econPaging,
      };

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No economic indicator data available." }], structuredContent: econ };
      }

      const lines: string[] = [
        `## U.S. Economic Indicators${category !== "all" ? ` — ${category.toUpperCase()}` : ""}`,
        "",
        "| Date | Series | Value | Category |",
        "|------|--------|-------|----------|",
      ];

      for (const r of rows) {
        lines.push(
          `| ${r.date} | ${r.series_name || r.series_id || "N/A"} | ${r.value ?? "N/A"} | ${r.category || "N/A"} |`
        );
      }

      const more = pageNote(rows.length, limit, page);
      if (more) lines.push(more);

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: econ };
    },
    { outputSchema: ECONOMIC_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: get_ftd_data
  //
  // WHAT THE NUMBER IS (EVAL_CODEX_TECH #7). SEC's fails-to-deliver file
  // reports, per security and settlement date, the aggregate net BALANCE of
  // shares that have failed to deliver and are still outstanding -- not the
  // fails that arose that day. A balance carries over, so summing across dates
  // counts the same unsettled shares again and again. And a fail has many
  // causes (processing delays, long sales, options-market-maker activity); the
  // SEC says outright that FTDs are not necessarily the result of short selling.
  // The old description pointed a model at "naked short selling"; this one
  // states the measure and its limits.
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_ftd_data",
    "Get SEC fails-to-deliver (FTD) data for a stock. Each quantity is the aggregate net BALANCE of shares that had " +
      "failed to deliver and were still outstanding on that settlement date, as published by the SEC -- NOT the " +
      "number of new fails that day. Balances carry over between days, so never sum quantities across dates (that " +
      "counts the same unsettled shares repeatedly); compare levels or take the maximum instead. Fails arise from " +
      "many causes (operational and processing delays, long sales, market-maker activity), and FTD data on its own is " +
      "not evidence of naked short selling. Free/keyless access covers the trailing 92 days. structuredContent " +
      "carries the exact share quantities.",
    {
      ticker: z.string().max(200).describe("Stock ticker symbol (e.g. 'GME', 'TSLA')"),
      days: z
        .number()
        .int()
        .min(1)
        .max(1825)
        .optional()
        .default(90)
        .describe("Days of settlement-date history (default 90; Free/keyless access allows up to 92)"),
      ...PAGE_SCHEMA,
    },
    async ({ ticker, days, page, limit }) => {
      const t = ticker.toUpperCase();
      const env = asEnvelope<FtdRow[]>(
        await koFetch<unknown>(
          config,
          "/api/v1/sec/ftd",
          { ticker: t, days, page, per_page: limit },
          { envelope: true },
        ),
      );
      const rows = Array.isArray(env.data) ? env.data : [];
      const paging = pagingOf(env.meta, { page, limit, returned: rows.length });
      const structured = {
        ticker: t,
        measure: "outstanding_fail_balance" as const,
        rows: rows.map((r) => ({
          settlement_date: r.settlement_date || r.date || null,
          ticker: r.ticker || r.symbol || t,
          quantity: dec(r.quantity),
          price: dec(r.price),
        })),
        paging,
        plan_limit: planLimitOf(env.meta),
      };

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No FTD data found for ${t}.` }],
          structuredContent: structured,
        };
      }

      const lines: string[] = [
        `## SEC Failures-to-Deliver — ${t}`,
        "*Quantity = outstanding fail balance on that settlement date (not new fails that day); do not sum across dates.*",
      ];
      const w = windowLine(env.meta);
      if (w) lines.push(w);
      lines.push(
        "",
        "| Date | Ticker | Quantity | Price |",
        "|------|--------|---------|-------|",
      );

      for (const r of rows) {
        lines.push(
          `| ${r.settlement_date || r.date} | ${r.ticker || r.symbol || t} | ${fmtIntExact(r.quantity)} | $${r.price?.toFixed(2) ?? "N/A"} |`
        );
      }

      if (env.meta.softwall || env.meta.total_count !== undefined) {
        lines.push(...pagingLines(paging));
      } else {
        const more = pageNote(rows.length, limit, page);
        if (more) lines.push(more);
      }

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured };
    },
    { outputSchema: FTD_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: get_financial_stress
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_financial_stress",
    "Get the OFR Financial Stress Index — a daily indicator of stress in global financial markets. Values above 0 indicate above-average stress.",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .default(365)
        .describe("Number of days of history (default 365)"),
      ...PAGE_SCHEMA,
    },
    async ({ days, page, limit }) => {
      const env = asEnvelope<StressRow[]>(
        await koFetch<unknown>(config, "/api/v1/stress/ofr", { days, page, per_page: limit }, { envelope: true }),
      );
      const rows = Array.isArray(env.data) ? env.data : [];
      const stress = {
        rows: rows.map((r) => ({ date: str(r.date), series: str(r.series_name || r.series || "FSI"), value: dec(r.value) })),
        paging: pagingOf(env.meta, { page, limit, returned: rows.length }),
      };

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No financial stress data available." }], structuredContent: stress };
      }

      const lines: string[] = [
        "## OFR Financial Stress Index",
        "",
        "| Date | Series | Value |",
        "|------|--------|-------|",
      ];

      for (const r of rows) {
        lines.push(
          `| ${r.date} | ${r.series_name || r.series || "FSI"} | ${r.value?.toFixed(3) ?? "N/A"} |`
        );
      }

      const more = pageNote(rows.length, limit, page);
      if (more) lines.push(more);

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: stress };
    },
    { outputSchema: STRESS_OUTPUT },
  );
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function fmtYield(value: number | null | undefined): string {
  if (value == null) return "N/A";
  return `${value.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TreasuryYieldRow {
  date: string;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y2: number | null;
  y5: number | null;
  y10: number | null;
  y30: number | null;
}

interface FedRateRow {
  date: string;
  fed_funds_rate: number | null;
  sofr: number | null;
  prime_rate: number | null;
  treasury_3m: number | null;
  treasury_2y: number | null;
  treasury_10y: number | null;
  treasury_30y: number | null;
}

interface EconomicRow {
  date: string;
  series_id?: string;
  series_name?: string;
  value: number | null;
  category?: string;
}

interface FtdRow {
  settlement_date: string;
  date?: string;
  ticker?: string;
  symbol?: string;
  quantity: number | null;
  price: number | null;
}

interface StressRow {
  date: string;
  series_name?: string;
  series?: string;
  value: number | null;
}
