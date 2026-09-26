import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, type KoConfig } from "../ko-fetch.js";
import { dec, planLimitOf } from "../paging.js";
import { STOCK_FINANCIALS_OUTPUT } from "../output-schemas.js";
import { fmtMoney } from "../format.js";

export function registerFinancialTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_stock_financials
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_stock_financials",
    "Get quarterly or annual financial statements for a company (revenue, net income, EPS, margins, cash flow, debt ratios) from SEC 10-K/10-Q filings. " +
      "Plan limits: the Free plan and keyless access return only the latest quarterly statement; annual statements and " +
      "earlier quarters require Pro (a request for them returns an explicit plan-limit error, never 'no data'). " +
      "structuredContent carries the exact reported values.",
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
      const t = ticker.toUpperCase();
      // The endpoint returns { quarterly: [...], annual: [...] } (oldest->newest),
      // NOT a flat array. Pick the requested series and take the most recent `limit`.
      //
      // ENVELOPE, because `meta.softwall` is the only evidence of WHY a series is
      // short. For a Free/keyless caller ko-api's soft wall (softwall policy
      // 'v1.stocks.ticker.financials.historical') EMPTIES `annual` and keeps only
      // the latest quarterly statement -- a 200 with annual: []. This tool used
      // to render that as "No financial data found for AAPL.", a false statement
      // of fact about Apple (EVAL_CODEX_TECH #4). A plan limit is now an error
      // that names the plan.
      const env = asEnvelope<{ quarterly?: FinancialRow[]; annual?: FinancialRow[] }>(
        await koFetch<unknown>(
          config,
          `/api/v1/stocks/${encodeURIComponent(t)}/financials/historical`,
          { period_type },
          { envelope: true },
        ),
      );
      const result = env.data;
      const walled = Boolean(env.meta.softwall);
      const series = (period_type === "annual" ? result?.annual : result?.quarterly) ?? [];
      const rows = series.slice(-limit).reverse(); // newest first

      if (walled && period_type === "annual") {
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              `ko.io plan limit (PLAN_REQUIRED): annual financial statements for ${t} require Pro. ` +
              "The Free plan and keyless access return only the latest quarterly statement, so the annual series " +
              "was withheld -- this is a limit of the caller's plan, not an absence of data. " +
              "Use period_type='quarterly' for the latest quarter, or a Pro API key (https://ko.io/pricing).",
          }],
        };
      }

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No ${period_type} financial data found for ${t}.` }],
          structuredContent: { ticker: t, period_type, periods: [], plan_note: null, plan_limit: planLimitOf(env.meta) },
        };
      }

      const planNote = walled
        ? "Free plan / keyless access: only the latest quarterly statement is returned; earlier quarters and all annual statements require Pro (they exist -- they are withheld, not missing)."
        : null;

      const lines: string[] = [
        `## ${t} Financials — ${period_type === "annual" ? "Annual" : "Quarterly"}`,
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
      if (planNote) lines.push("", `*${planNote}*`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          ticker: t,
          period_type,
          periods: rows.map((r) => ({
            period_end: r.period_end ?? null,
            revenue: dec(r.revenue),
            net_income: dec(r.net_income),
            eps_basic: dec(r.eps_basic),
            eps_diluted: dec(r.eps_diluted),
            gross_profit: dec(r.gross_profit),
            operating_income: dec(r.operating_income),
            operating_cashflow: dec(r.operating_cashflow),
            long_term_debt: dec(r.long_term_debt),
            short_term_debt: dec(r.short_term_debt),
            stockholders_equity: dec(r.stockholders_equity),
          })),
          plan_note: planNote,
          plan_limit: planLimitOf(env.meta),
        },
      };
    },
    { outputSchema: STOCK_FINANCIALS_OUTPUT },
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
