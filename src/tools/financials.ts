import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney } from "../format.js";

export function registerFinancialTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_stock_financials
  // ---------------------------------------------------------------------------
  server.tool(
    "get_stock_financials",
    "Get quarterly or annual financial statements for a company (revenue, net income, EPS, margins, cash flow, debt ratios) from SEC 10-K/10-Q filings.",
    {
      ticker: z.string().describe("Stock ticker symbol (e.g. 'AAPL', 'MSFT')"),
      period_type: z
        .enum(["quarterly", "annual"])
        .optional()
        .default("quarterly")
        .describe("Period type — quarterly (10-Q) or annual (10-K)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(8)
        .describe("Number of periods to return (default 8)"),
    },
    async ({ ticker, period_type, limit }) => {
      const rows = await koFetch<FinancialRow[]>(
        config,
        `/api/v1/stocks/${encodeURIComponent(ticker.toUpperCase())}/financials/historical`,
        { period_type, per_page: limit }
      );

      if (!rows || rows.length === 0) {
        return {
          content: [{ type: "text", text: `No financial data found for ${ticker.toUpperCase()}.` }],
        };
      }

      const lines: string[] = [
        `## ${ticker.toUpperCase()} Financials — ${period_type === "annual" ? "Annual" : "Quarterly"}`,
        "",
        "| Period | Revenue | Net Income | EPS | Gross Margin | Op Margin | FCF | D/E |",
        "|--------|---------|------------|-----|-------------|-----------|-----|-----|",
      ];

      for (const r of rows) {
        lines.push(
          `| ${r.period_end || r.quarter_date || "N/A"} | ${fmtMoney(r.total_revenue)} | ${fmtMoney(r.net_income)} | ${fmtEps(r.eps_diluted ?? r.eps_basic)} | ${fmtPctVal(r.gross_margin)} | ${fmtPctVal(r.operating_margin)} | ${fmtMoney(r.free_cash_flow)} | ${fmtRatio(r.debt_to_equity)} |`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function fmtPctVal(value: number | null | undefined): string {
  if (value == null) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtEps(value: number | null | undefined): string {
  if (value == null) return "N/A";
  return `$${value.toFixed(2)}`;
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null) return "N/A";
  return value.toFixed(2);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FinancialRow {
  ticker?: string;
  period_end?: string;
  quarter_date?: string;
  total_revenue: number | null;
  net_income: number | null;
  eps_basic: number | null;
  eps_diluted: number | null;
  gross_margin: number | null;
  operating_margin: number | null;
  free_cash_flow: number | null;
  debt_to_equity: number | null;
}
