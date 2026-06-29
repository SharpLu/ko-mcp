import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares, fmtPct, truncate } from "../format.js";

export function registerStockTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_stock_profile
  // ---------------------------------------------------------------------------
  server.tool(
    "get_stock_profile",
    "Get a company's profile — sector, market cap, price, P/E ratio, 52-week range, beta, dividend yield, and other key financials.",
    {
      ticker: z.string().describe("Stock ticker symbol (e.g. 'AAPL', 'NVDA', 'MSFT')"),
    },
    async ({ ticker }) => {
      const data = await koFetch<StockProfileResponse>(
        config,
        `/api/v1/stocks/${encodeURIComponent(ticker.toUpperCase())}`
      );

      const s = data.stock;

      const lines: string[] = [
        `## ${s.ticker}`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| **Sector** | ${s.sector || "N/A"} |`,
        `| **Industry** | ${s.industry || "N/A"} |`,
        `| **Market Cap** | ${fmtMoney(s.market_cap)} |`,
        `| **Price** | $${s.current_price?.toFixed(2) ?? "N/A"} |`,
        `| **Previous Close** | $${s.previous_close?.toFixed(2) ?? "N/A"} |`,
        `| **52W High** | $${s.fifty_two_week_high?.toFixed(2) ?? "N/A"} |`,
        `| **52W Low** | $${s.fifty_two_week_low?.toFixed(2) ?? "N/A"} |`,
        `| **P/E** | ${s.pe_ratio?.toFixed(2) ?? "N/A"} |`,
        `| **EPS** | $${s.eps?.toFixed(2) ?? "N/A"} |`,
        `| **Beta** | ${s.beta?.toFixed(2) ?? "N/A"} |`,
        `| **Dividend Yield** | ${s.dividend_yield ? s.dividend_yield.toFixed(2) + "%" : "N/A"} |`,
        `| **Profit Margins** | ${s.profit_margins ? (s.profit_margins * 100).toFixed(2) + "%" : "N/A"} |`,
        `| **Avg Volume** | ${fmtShares(s.avg_volume)} |`,
      ];

      if (data.top_holders?.length) {
        lines.push("", "### Top Institutional Holders\n");
        lines.push("| Institution | Shares | Value | Weight |");
        lines.push("|------------|--------|-------|--------|");
        for (const h of (truncate(data.top_holders, 10) as TopHolder[])) {
          lines.push(
            `| **${h.name}** | ${fmtShares(h.shares_held)} | ${fmtMoney(h.holding_value)} | ${h.portfolio_weight_pct?.toFixed(2) ?? "—"}% |`
          );
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_stock_holders
  // ---------------------------------------------------------------------------
  server.tool(
    "get_stock_holders",
    "Get top institutional holders of a stock from SEC 13F filings. Shows which hedge funds, mutual funds, and pension funds own the most shares, with quarter-over-quarter changes.",
    {
      ticker: z.string().describe("Stock ticker symbol (e.g. 'NVDA')"),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Results per page"),
    },
    async ({ ticker, page, limit }) => {
      const data = await koFetch<HoldersResponse>(
        config,
        `/api/v1/stock-holders/${encodeURIComponent(ticker.toUpperCase())}`,
        { type: "holders", page, limit }
      );

      if (!data || !data.data) {
        return {
          content: [
            {
              type: "text",
              text: `No institutional holders found for ${ticker.toUpperCase()}. Check the ticker symbol.`,
            },
          ],
        };
      }

      const lines: string[] = [
        `## Institutional Holders of ${ticker.toUpperCase()} — Q${data.quarterDate}`,
        `**Total institutions:** ${data.totalCount}\n`,
        "| # | Institution | Value | Shares | Weight | Change | Action |",
        "|---|------------|-------|--------|--------|--------|--------|",
      ];

      for (const [i, h] of data.data.entries()) {
        const num = (page - 1) * limit + i + 1;
        const changeStr = h.share_change
          ? `${h.share_change > 0 ? "+" : ""}${fmtShares(h.share_change)}`
          : "—";
        lines.push(
          `| ${num} | **${h.name}** | ${fmtMoney(h.holding_value)} | ${fmtShares(h.shares_held)} | ${h.portfolio_weight_pct?.toFixed(2) ?? "—"}% | ${changeStr} | ${h.action} |`
        );
      }

      if (data.totalPages && page < data.totalPages) {
        lines.push(`\n*Page ${page}/${data.totalPages} — use page=${page + 1} for more.*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_stock_activity
  // ---------------------------------------------------------------------------
  server.tool(
    "get_stock_activity",
    "Get institutional buying/selling activity trend for a stock over multiple quarters. Shows how many institutions are buying vs selling, net share changes, and value flows — useful for detecting accumulation or distribution patterns.",
    {
      ticker: z.string().describe("Stock ticker symbol"),
      quarters: z
        .number()
        .int()
        .min(1)
        .max(40)
        .optional()
        .default(8)
        .describe("Number of quarters to return (default 8 = 2 years)"),
    },
    async ({ ticker, quarters }) => {
      const data = await koFetch<{
        ticker: string;
        summary: ActivitySummary;
        trend: ActivityTrend[];
      }>(config, `/api/v1/stock-holders/${encodeURIComponent(ticker.toUpperCase())}`, {
        type: "activity",
        quarters,
      });

      if (!data || !data.summary) {
        return {
          content: [
            {
              type: "text",
              text: `No institutional activity data found for ${ticker.toUpperCase()}. Check the ticker symbol (it may be invalid or have no 13F coverage).`,
            },
          ],
        };
      }

      const lines: string[] = [
        `## Institutional Activity — ${data.ticker}`,
        "",
        `**Latest Quarter (${data.summary.quarterDate}):**`,
        `- Institutions increased: ${data.summary.institutionsIncreased} | Decreased: ${data.summary.institutionsDecreased}`,
        `- New positions: ${data.summary.institutionsNew} | Exited: ${data.summary.institutionsExited}`,
        `- Net shares: ${fmtShares(data.summary.netShares)} | Net value: ${fmtMoney(data.summary.netValue)}`,
        "",
        "### Quarterly Trend\n",
        "| Quarter | Increased | Decreased | New | Exited | Net Shares | Net Value |",
        "|---------|-----------|-----------|-----|--------|------------|-----------|",
      ];

      for (const t of data.trend) {
        lines.push(
          `| ${t.quarter} | ${t.institutionsIncreased} | ${t.institutionsDecreased} | ${t.institutionsNew} | ${t.institutionsExited} | ${fmtShares(t.netShares)} | ${fmtMoney(t.netValue)} |`
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_stock_price
  // ---------------------------------------------------------------------------
  server.tool(
    "get_stock_price",
    "Get historical daily stock prices (OHLC). Returns a summary by default; set series=true to get the full daily price series (for backtesting / charting).",
    {
      ticker: z.string().describe("Stock ticker symbol"),
      period: z
        .enum(["1y", "3y", "5y", "10y"])
        .optional()
        .default("1y")
        .describe("Look-back window"),
      series: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, return the full daily OHLC series (up to `limit` rows) instead of just a summary."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(3000)
        .optional()
        .default(500)
        .describe("Max rows of the daily series to return when series=true."),
    },
    async ({ ticker, period, series, limit }) => {
      // REST /stock-price ignores period/aggregation; it scales coverage off `days`.
      // Map the look-back window to days so the summary (and series) actually cover it
      // instead of silently using the latest 50 rows.
      const daysByPeriod: Record<string, number> = { "1y": 365, "3y": 1095, "5y": 1825, "10y": 3650 };
      const days = daysByPeriod[period] ?? 365;
      const prices = await koFetch<PriceRow[]>(
        config,
        `/api/v1/stock-price/${encodeURIComponent(ticker.toUpperCase())}`,
        { days, per_page: Math.min(5000, Math.max(days, series ? limit : 0) || days) }
      );

      if (!prices || prices.length === 0) {
        return { content: [{ type: "text", text: `No price data found for ${ticker}.` }] };
      }

      // The API returns newest-first; sort defensively by date DESC so latest /
      // period-start / recent-prices never depend on the upstream row order.
      const desc = [...prices].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const latest = desc[0];
      const first = desc[desc.length - 1];
      const totalReturn = ((latest.close - first.close) / first.close) * 100;
      const high = Math.max(...desc.map((p) => p.close));
      const low = Math.min(...desc.map((p) => p.close));

      const lines: string[] = [
        `## ${ticker.toUpperCase()} Price — ${period}`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| **Latest** | $${latest.close.toFixed(2)} (${latest.date}) |`,
        `| **Period Start** | $${first.close.toFixed(2)} (${first.date}) |`,
        `| **Total Return** | ${fmtPct(totalReturn)} |`,
        `| **Period High** | $${high.toFixed(2)} |`,
        `| **Period Low** | $${low.toFixed(2)} |`,
        `| **Data Points** | ${prices.length} |`,
      ];

      // Full daily series (newest-first) for backtesting/charting, or the recent 10.
      const rows = series ? desc.slice(0, limit) : desc.slice(0, 10);
      lines.push("", series ? `### Daily Series (${rows.length} rows)\n` : "### Recent Prices\n");
      lines.push("| Date | Open | High | Low | Close | Volume |");
      lines.push("|------|------|------|-----|-------|--------|");
      for (const p of rows) {
        lines.push(`| ${p.date} | $${p.open?.toFixed(2) ?? "—"} | $${p.high?.toFixed(2) ?? "—"} | $${p.low?.toFixed(2) ?? "—"} | $${p.close.toFixed(2)} | ${fmtShares(p.volume)} |`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StockProfileResponse {
  stock: {
    ticker: string;
    sector: string | null;
    industry: string | null;
    market_cap: number | null;
    current_price: number | null;
    previous_close: number | null;
    fifty_two_week_high: number | null;
    fifty_two_week_low: number | null;
    beta: number | null;
    avg_volume: number | null;
    pe_ratio: number | null;
    eps: number | null;
    dividend_yield: number | null;
    profit_margins: number | null;
  };
  top_holders: TopHolder[];
}

interface TopHolder {
  name: string;
  shares_held: number;
  holding_value: number;
  portfolio_weight_pct: number | null;
}

interface HoldersResponse {
  data: HolderRow[];
  totalCount: number;
  page: number;
  per_page: number;
  totalPages: number;
  quarterDate: string;
}

interface HolderRow {
  cik: string;
  name: string;
  slug: string;
  shares_held: number;
  holding_value: number;
  share_change: number;
  action: string;
  portfolio_weight_pct: number | null;
}

interface ActivitySummary {
  quarterDate: string;
  institutionsIncreased: number;
  institutionsDecreased: number;
  institutionsNew: number;
  institutionsExited: number;
  institutionsTotal: number;
  sharesAdded: number;
  sharesRemoved: number;
  netShares: number;
  valueAdded: number;
  valueRemoved: number;
  netValue: number;
}

interface ActivityTrend {
  quarter: string;
  institutionsIncreased: number;
  institutionsDecreased: number;
  institutionsNew: number;
  institutionsExited: number;
  netShares: number;
  netValue: number;
}

interface PriceRow {
  ticker: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}
