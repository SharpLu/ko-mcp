import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, type KoConfig } from "../ko-fetch.js";
import { dec, decSub, planLimitOf } from "../paging.js";
import { STOCK_FINANCIALS_OUTPUT } from "../output-schemas.js";
import { fmtMoney } from "../format.js";

export function registerFinancialTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_stock_financials
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_stock_financials",
    "Get quarterly or annual financial statements for a company from SEC 10-K/10-Q filings: revenue, net income, EPS, margins, " +
      "operating cash flow, cash, capex, free cash flow, buybacks, dividends, investing/financing cash flow, " +
      "total assets/liabilities and debt ratios. " +
      "capex, stock_repurchase (buybacks) and dividends_paid are each normally a positive cash payment (USD); negative values are " +
      "passed through as filed or derived; a negative capex makes free_cash_flow null. " +
      "free_cash_flow = operating_cashflow - capex only when both are reported and capex >= 0, otherwise null " +
      "(never computed from a missing or negative value). " +
      "cash_and_equivalents excludes short-term investments; long_term_debt is us-gaap LongTermDebt, which includes the current portion. " +
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

      // Balance sheet and cash-flow uses (internal#374). Separate tables so each stays
      // readable; every value is also exact in structuredContent. fmtMoney(null)
      // is "N/A", never $0 -- and free cash flow is N/A unless BOTH operating
      // cash flow and capex were reported (iron rule 13).
      lines.push(
        "",
        "### Balance Sheet",
        "",
        "| Period | Cash & Equivalents | Total Assets | Total Liabilities |",
        "|--------|--------------------|--------------|-------------------|",
      );
      for (const r of rows) {
        lines.push(
          `| ${r.period_end ?? "N/A"} | ${fmtMoney(r.cash_and_equivalents)} | ${fmtMoney(r.total_assets)} | ${fmtMoney(r.total_liabilities)} |`
        );
      }
      lines.push(
        "",
        "### Cash Flow Uses",
        "",
        "| Period | Op Cash Flow | Capex | Free Cash Flow | Buybacks | Dividends | Investing CF | Financing CF |",
        "|--------|--------------|-------|----------------|----------|-----------|--------------|--------------|",
      );
      for (const r of rows) {
        lines.push(
          `| ${r.period_end ?? "N/A"} | ${fmtMoney(r.operating_cashflow)} | ${fmtMoney(r.capex)} | ${fmtMoney(freeCashFlow(r))} | ${fmtMoney(r.stock_repurchase)} | ${fmtMoney(r.dividends_paid)} | ${fmtMoney(r.investing_cashflow)} | ${fmtMoney(r.financing_cashflow)} |`
        );
      }
      lines.push("", `*${DEFINITIONS}*`);
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
            cash_and_equivalents: dec(r.cash_and_equivalents),
            total_assets: dec(r.total_assets),
            total_liabilities: dec(r.total_liabilities),
            capex: dec(r.capex),
            stock_repurchase: dec(r.stock_repurchase),
            dividends_paid: dec(r.dividends_paid),
            investing_cashflow: dec(r.investing_cashflow),
            financing_cashflow: dec(r.financing_cashflow),
            free_cash_flow: freeCashFlow(r),
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
// Field definitions (internal#374): the same wording as ko-api's OpenAPI field docs.
// ---------------------------------------------------------------------------
const DEFINITIONS =
  "Capex, buybacks and dividends are normally a positive cash payment (USD); negative values are passed through as filed or derived. " +
  "Free cash flow = operating cash flow - capex, N/A when either is unreported or capex is negative. " +
  "Investing and financing cash flow are signed (negative = net cash used). " +
  "Cash & equivalents excludes short-term investments; long-term debt (in D/E) is us-gaap LongTermDebt, which includes the current portion.";

/**
 * operating_cashflow - capex, exact. Null unless BOTH were reported (null is
 * unknown, never 0) AND capex >= 0: capex is normally a positive cash payment,
 * and a negative value (as filed, or from a YTD/Q4 derivation) would make FCF
 * exceed operating cash flow (HIG FY2026 Q2: OCF 1.189B, capex -115M), so FCF is
 * withheld rather than guessed. Sign normalisation belongs to the pipeline.
 */
function freeCashFlow(r: FinancialRow): string | null {
  const capex = dec(r.capex);
  if (capex === null || Number(capex) < 0) return null;
  return decSub(dec(r.operating_cashflow), capex);
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
  cash_and_equivalents?: number | null;
  total_assets?: number | null;
  total_liabilities?: number | null;
  capex?: number | null;
  stock_repurchase?: number | null;
  dividends_paid?: number | null;
  investing_cashflow?: number | null;
  financing_cashflow?: number | null;
}
