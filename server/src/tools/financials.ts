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
      ticker: z.string().max(200).describe("Stock ticker symbol (e.g. 'AAPL', 'MSFT')"),
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
      // The endpoint returns { quarterly: [...], annual: [...] } (oldest->newest),
      // NOT a flat array. Pick the requested series and take the most recent `limit`.
      const result = await koFetch<{ quarterly?: FinancialRow[]; annual?: FinancialRow[] }>(
        config,
        `/api/v1/stocks/${encodeURIComponent(ticker.toUpperCase())}/financials/historical`,
        { period_type }
      );
      const series = (period_type === "annual" ? result?.annual : result?.quarterly) ?? [];
      const rows = series.slice(-limit).reverse(); // newest first

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No financial data found for ${ticker.toUpperCase()}.` }],
        };
      }

      const lines: string[] = [
        `## ${ticker.toUpperCase()} Financials — ${period_type === "annual" ? "Annual" : "Quarterly"}`,
        "",
        "| Period | Revenue | Net Income | EPS | Gross Margin | Op Margin | Op Cash Flow | D/E |",
        "|--------|---------|------------|-----|-------------|-----------|--------------|-----|",
      ];

      for (const r of rows) {
        const gm = r.revenue && r.gross_profit != null ? r.gross_profit / r.revenue : null;
        const om = r.revenue && r.operating_income != null ? r.operating_income / r.revenue : null;
        const eq = r.stockholders_equity;
        const de = eq ? ((r.long_term_debt ?? 0) + (r.short_term_debt ?? 0)) / eq : null;
        lines.push(
          `| ${r.period_end ?? "N/A"} | ${fmtMoney(r.revenue)} | ${fmtMoney(r.net_income)} | ${fmtEps(r.eps_diluted ?? r.eps_basic)} | ${fmtPctVal(gm)} | ${fmtPctVal(om)} | ${fmtMoney(r.operating_cashflow)} | ${fmtRatio(de)} |`
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
  revenue: number | null;
  net_income: number | null;
  eps_basic: number | null;
  eps_diluted: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  operating_cashflow: number | null;
  long_term_debt: number | null;
  short_term_debt: number | null;
  stockholders_equity: number | null;
}
