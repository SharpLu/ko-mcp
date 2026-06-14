import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtShares } from "../format.js";

export function registerMacroTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_treasury_yields
  // ---------------------------------------------------------------------------
  server.tool(
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
        .describe("Number of days of history (default 30)"),
    },
    async ({ days }) => {
      const rows = await koFetch<TreasuryYieldRow[]>(
        config,
        "/api/v1/treasury/yields",
        { days }
      );

      if (!rows || rows.length === 0) {
        return { content: [{ type: "text", text: "No Treasury yield data available." }] };
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

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_fed_rates
  // ---------------------------------------------------------------------------
  server.tool(
    "get_fed_rates",
    "Get Federal Reserve interest rates — Fed Funds Rate, SOFR, Prime Rate, Discount Rate, and Treasury yields. Key indicators for monetary policy.",
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

      if (!rows || rows.length === 0) {
        return { content: [{ type: "text", text: "No Federal Reserve rate data available." }] };
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

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // get_short_volume tool removed 2026-06-14: backing FINRA short-volume DAG was
  // retired and market.finra_short_volume dropped, so /api/v1/finra/short-volume
  // 404s. Tool removed rather than serve a dead endpoint. Restore both the DAG
  // and the endpoint if short-volume data is reinstated.

  // ---------------------------------------------------------------------------
  // Tool: get_economic_indicators
  // ---------------------------------------------------------------------------
  server.tool(
    "get_economic_indicators",
    "Get U.S. economic indicators from BLS — CPI (inflation), PPI (producer prices), Non-farm Payrolls (employment), Unemployment Rate, JOLTS. Filter by category.",
    {
      category: z
        .enum(["cpi", "unemployment", "nfp", "ppi", "jolts", "all"])
        .optional()
        .default("all")
        .describe("Filter by indicator category (default 'all')"),
      days: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .default(365)
        .describe("Number of days of history (default 365)"),
    },
    async ({ category, days }) => {
      const rows = await koFetch<EconomicRow[]>(
        config,
        "/api/v1/economic/indicators",
        { category: category === "all" ? undefined : category, days }
      );

      if (!rows || rows.length === 0) {
        return { content: [{ type: "text", text: "No economic indicator data available." }] };
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

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_ftd_data
  // ---------------------------------------------------------------------------
  server.tool(
    "get_ftd_data",
    "Get SEC Failures-to-Deliver (FTD) data for a stock. High FTD quantities may indicate naked short selling or settlement issues.",
    {
      ticker: z.string().describe("Stock ticker symbol (e.g. 'GME', 'TSLA')"),
      days: z
        .number()
        .int()
        .min(1)
        .max(1825)
        .optional()
        .default(90)
        .describe("Number of days of history (default 90)"),
    },
    async ({ ticker, days }) => {
      const rows = await koFetch<FtdRow[]>(
        config,
        "/api/v1/sec/ftd",
        { ticker: ticker.toUpperCase(), days }
      );

      if (!rows || rows.length === 0) {
        return {
          content: [{ type: "text", text: `No FTD data found for ${ticker.toUpperCase()}.` }],
        };
      }

      const lines: string[] = [
        `## SEC Failures-to-Deliver — ${ticker.toUpperCase()}`,
        "",
        "| Date | Ticker | Quantity | Price |",
        "|------|--------|---------|-------|",
      ];

      for (const r of rows) {
        lines.push(
          `| ${r.settlement_date || r.date} | ${r.ticker || r.symbol || ticker.toUpperCase()} | ${fmtShares(r.quantity)} | $${r.price?.toFixed(2) ?? "N/A"} |`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_financial_stress
  // ---------------------------------------------------------------------------
  server.tool(
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
    },
    async ({ days }) => {
      const rows = await koFetch<StressRow[]>(
        config,
        "/api/v1/stress/ofr",
        { days }
      );

      if (!rows || rows.length === 0) {
        return { content: [{ type: "text", text: "No financial stress data available." }] };
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

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
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

interface ShortVolumeRow {
  date: string;
  ticker?: string;
  short_volume: number | null;
  total_volume: number | null;
  short_ratio: number | null;
  market: string | null;
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
