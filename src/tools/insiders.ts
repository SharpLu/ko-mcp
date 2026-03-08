import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares } from "../format.js";

export function registerInsiderTools(server: McpServer, config: KoConfig) {
  server.tool(
    "get_insider_trades",
    "Get insider/executive stock trades (SEC Form 4) for a company. Shows CEO, CFO, directors, and other officers buying or selling their own company's stock — a key signal for institutional investors.",
    {
      ticker: z.string().describe("Stock ticker symbol (e.g. 'AAPL')"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Max trades to return"),
    },
    async ({ ticker, limit }) => {
      const resp = await koFetch<{
        data: TradeRow[];
        meta: { total_count: string; page: number; per_page: number };
      }>(config, `/api/v1/executive-trades/${encodeURIComponent(ticker.toUpperCase())}`, {
        limit,
      });

      const trades = resp.data;
      const total = Number(resp.meta.total_count);

      const lines: string[] = [
        `## Insider Trades — ${ticker.toUpperCase()}`,
      ];

      // Build executive summary from trades
      const execMap = new Map<string, { name: string; title: string; bought: number; sold: number; latest: string }>();
      for (const t of trades) {
        const key = t.executive_cik;
        const existing = execMap.get(key);
        const title = t.officer_title || (t.is_director ? "Director" : "Officer");
        if (!existing) {
          execMap.set(key, {
            name: t.executive_name,
            title: t.is_ceo ? `${title} (CEO)` : title,
            bought: t.action === "Buy" ? t.value : 0,
            sold: t.action === "Sell" ? t.value : 0,
            latest: t.trade_date,
          });
        } else {
          if (t.action === "Buy") existing.bought += t.value;
          else if (t.action === "Sell") existing.sold += t.value;
          if (t.trade_date > existing.latest) existing.latest = t.trade_date;
        }
      }

      if (execMap.size > 0) {
        lines.push("", "### Key Insiders\n");
        lines.push("| Name | Title | Bought | Sold | Latest Trade |");
        lines.push("|------|-------|--------|------|-------------|");
        const execs = [...execMap.values()].sort((a, b) => (b.bought + b.sold) - (a.bought + a.sold));
        for (const e of execs.slice(0, 15)) {
          lines.push(
            `| **${e.name}** | ${e.title} | ${fmtMoney(e.bought)} | ${fmtMoney(e.sold)} | ${e.latest} |`
          );
        }
      }

      if (trades.length > 0) {
        lines.push("", "### Recent Trades\n");
        lines.push("| Date | Executive | Action | Shares | Value | Price |");
        lines.push("|------|-----------|--------|--------|-------|-------|");

        for (const t of trades.slice(0, 40)) {
          lines.push(
            `| ${t.trade_date} | ${t.executive_name} | **${t.action}** | ${fmtShares(t.shares)} | ${fmtMoney(t.value)} | $${t.price?.toFixed(2) ?? "N/A"} |`
          );
        }

        if (total > trades.length) {
          lines.push(`\n*Showing ${trades.length} of ${total} total trades.*`);
        }
      } else {
        lines.push("\nNo insider trades found.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

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
      const resp = await koFetch<{
        data: InsiderTraderRow[];
        meta: { total_count: string; page: number; per_page: number };
      }>(config, "/api/v1/insider-trades", { search, role, page, limit });

      const total = Number(resp.meta.total_count);
      const hasMore = page * limit < total;

      const lines: string[] = [
        `## Insider Traders${role !== "all" ? ` (${role.toUpperCase()}s only)` : ""} — Page ${page}\n`,
        "| Ticker | Executive | Title | Bought | Sold | Latest |",
        "|--------|-----------|-------|--------|------|--------|",
      ];

      for (const t of resp.data) {
        lines.push(
          `| **${t.ticker}** | ${t.person_name} | ${t.officer_title || "—"} | ${fmtMoney(t.stock_value_bought)} | ${fmtMoney(t.stock_value_sold)} | ${t.trade_date} |`
        );
      }

      if (hasMore) {
        lines.push(`\n*More results — use page=${page + 1}*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

interface TradeRow {
  ticker: string;
  company_name: string;
  executive_name: string;
  executive_cik: string;
  officer_title: string | null;
  is_ceo: number;
  is_director: number;
  trade_date: string;
  action: string;
  shares: number;
  value: number;
  price: number | null;
  is_derivative: number;
}

interface InsiderTraderRow {
  ticker: string;
  company_name: string;
  person_name: string;
  person_cik: string;
  officer_title: string | null;
  is_director: number;
  is_officer: number;
  trade_date: string;
  stock_shares_bought: number;
  stock_value_bought: number;
  stock_shares_sold: number;
  stock_value_sold: number;
  total_transactions: number;
}
