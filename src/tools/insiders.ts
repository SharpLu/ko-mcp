import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares, truncate } from "../format.js";

export function registerInsiderTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_insider_trades
  // ---------------------------------------------------------------------------
  server.tool(
    "get_insider_trades",
    "Get insider/executive stock trades (SEC Form 4) for a company. Shows CEO, CFO, directors, and other officers buying or selling their own company's stock — a key signal for institutional investors.",
    {
      ticker: z.string().describe("Stock ticker symbol (e.g. 'AAPL')"),
      executive_cik: z
        .string()
        .optional()
        .describe("Filter by specific executive CIK (from list_insider_traders)"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Max trades to return"),
    },
    async ({ ticker, executive_cik, limit }) => {
      // koFetch returns the array directly
      const trades = await koFetch<TradeRow[]>(
        config,
        `/api/v1/executive-trades/${encodeURIComponent(ticker.toUpperCase())}`,
        { limit, executive_cik }
      );

      const lines: string[] = [
        `## Insider Trades — ${ticker.toUpperCase()}`,
        `*${trades.length} trades returned*\n`,
      ];

      if (trades.length > 0) {
        lines.push("| Date | Executive | Title | Action | Shares | Value | Price |");
        lines.push("|------|-----------|-------|--------|--------|-------|-------|");

        for (const t of truncate(trades, 50) as TradeRow[]) {
          const title = t.officer_title || (t.is_director ? "Director" : "—");
          const ceoTag = t.is_ceo ? " (CEO)" : "";
          lines.push(
            `| ${t.trade_date} | ${t.executive_name}${ceoTag} | ${title} | **${t.action}** | ${fmtShares(t.shares)} | ${fmtMoney(t.value)} | $${t.price?.toFixed(2) ?? "N/A"} |`
          );
        }

        if (trades.length > 50) {
          lines.push(
            `\n*Showing 50 of ${trades.length} trades.*`
          );
        }
      } else {
        lines.push("\nNo insider trades found.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: list_insider_traders
  // ---------------------------------------------------------------------------
  server.tool(
    "list_insider_traders",
    "List executives/insiders who have recently traded their company stock. Filter by role (CEO only or all executives). Useful for finding notable insider buying/selling activity across the market.",
    {
      search: z.string().optional().describe("Search by name or ticker"),
      role: z
        .enum(["ceo", "executive", "all"])
        .optional()
        .default("all")
        .describe("Filter by role — 'ceo' for CEOs only, 'executive' for officers, 'all' for everyone"),
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
    async ({ search, role, page, limit }) => {
      // koFetch returns the array directly
      const traders = await koFetch<InsiderTraderRow[]>(
        config,
        "/api/v1/insider-trades",
        { search, role, page, limit }
      );

      const lines: string[] = [
        `## Insider Traders${role !== "all" ? ` (${role.toUpperCase()}s only)` : ""} — Page ${page}\n`,
        "| Ticker | Company | Person | Title | Trade Date | Bought | Sold | Shares Owned |",
        "|--------|---------|--------|-------|------------|--------|------|-------------|",
      ];

      for (const t of traders) {
        const title = t.officer_title || (t.is_director ? "Director" : t.is_ten_percent_owner ? "10%+ Owner" : "—");
        lines.push(
          `| **${t.ticker}** | ${t.company_name} | ${t.person_name} | ${title} | ${t.trade_date} | ${fmtMoney(t.stock_value_bought)} | ${fmtMoney(t.stock_value_sold)} | ${fmtShares(t.shares_owned_after)} |`
        );
      }

      if (traders.length === limit) {
        lines.push(`\n*More results — use page=${page + 1}*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TradeRow {
  ticker: string;
  company_name: string;
  executive_name: string;
  executive_cik: string;
  officer_title: string | null;
  is_ceo: boolean;
  is_director: boolean;
  trade_date: string;
  action: string;
  shares: number;
  value: number;
  price: number | null;
  is_derivative: boolean;
}

interface InsiderTraderRow {
  ticker: string;
  company_name: string;
  person_name: string;
  person_cik: string;
  officer_title: string | null;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  trade_date: string;
  stock_shares_bought: number;
  stock_value_bought: number;
  stock_shares_sold: number;
  stock_value_sold: number;
  total_transactions: number;
  shares_owned_after: number;
}
