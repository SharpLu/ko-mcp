import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";

export function registerCongressTools(server: McpServer, config: KoConfig) {
  server.tool(
    "get_congress_trades",
    "Get stock trades made by U.S. Congress members (House & Senate). Data sourced from mandatory financial disclosures. Filter by chamber, party, state, or specific stock ticker.",
    {
      chamber: z
        .enum(["house", "senate", "all"])
        .optional()
        .default("all")
        .describe("Filter by congressional chamber"),
      party: z
        .enum(["D", "R", "I", "all"])
        .optional()
        .default("all")
        .describe("Filter by party — D=Democrat, R=Republican, I=Independent"),
      ticker: z.string().optional().describe("Filter trades by stock ticker"),
      state: z.string().optional().describe("Filter by U.S. state (2-letter code)"),
      search: z.string().optional().describe("Search by member name"),
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
    async ({ chamber, party, ticker, state, search, page, limit }) => {
      const resp = await koFetch<{
        data: CongressTrade[];
        meta: { total_count: string; page: number; per_page: number };
      }>(config, "/api/v1/congress-trades", {
        chamber: chamber === "all" ? undefined : chamber,
        party: party === "all" ? undefined : party,
        ticker,
        state,
        search,
        page,
        limit,
      });

      const total = Number(resp.meta.total_count);
      const hasMore = page * limit < total;
      const lines: string[] = [];

      lines.push(`## Congress Trades (${total} total)\n`);

      if (resp.data.length > 0) {
        lines.push("| # | Date | Member | Chamber | Ticker | Type | Amount |");
        lines.push("|---|------|--------|---------|--------|------|--------|");

        for (const [i, t] of resp.data.entries()) {
          const num = (page - 1) * limit + i + 1;
          lines.push(
            `| ${num} | ${t.transaction_date} | **${t.member_name}** | ${t.chamber} | ${t.ticker || "—"} | ${t.transaction_type} | ${t.amount_range} |`
          );
        }
      } else {
        lines.push("No trades found matching filters.");
      }

      if (hasMore) {
        lines.push(`\n*Page ${page} — use page=${page + 1} for more.*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "get_congress_member",
    "Get detailed trading history of a specific U.S. Congress member. Shows individual trades with disclosure dates.",
    {
      member: z
        .string()
        .describe(
          "Member name (e.g. 'nancy pelosi', 'dan crenshaw'). Use get_congress_trades to find exact names."
        ),
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(100).optional().default(50),
    },
    async ({ member, page, limit }) => {
      const memberSlug = encodeURIComponent(member.toLowerCase().trim());

      const resp = await koFetch<{
        data: CongressTrade[];
        meta: { total_count: string; page: number; per_page: number };
      }>(config, `/api/v1/congress-trades/${memberSlug}`, {
        page,
        limit,
      });

      const total = Number(resp.meta.total_count);
      const trades = resp.data;
      const hasMore = page * limit < total;

      const lines: string[] = [];

      if (trades.length > 0) {
        const m = trades[0];
        lines.push(`## ${m.member_name}`);
        lines.push(`**${m.chamber === "senate" ? "Senator" : "Representative"}**`);
        lines.push(`Total trades: ${total}\n`);

        lines.push("### Trades\n");
        lines.push("| Date | Ticker | Type | Amount | Disclosure |");
        lines.push("|------|--------|------|--------|------------|");

        for (const t of trades) {
          const disclosure = t.disclosure_date || "—";
          lines.push(
            `| ${t.transaction_date} | **${t.ticker || "N/A"}** | ${t.transaction_type} | ${t.amount_range} | ${disclosure} |`
          );
        }

        if (hasMore) {
          lines.push(`\n*Showing ${trades.length} of ${total} — use page=${page + 1} for more.*`);
        }
      } else {
        lines.push(`No trades found for "${member}".`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

interface CongressTrade {
  member_name: string;
  chamber: string;
  ticker: string | null;
  asset_description: string;
  transaction_type: string;
  transaction_date: string;
  disclosure_date: string | null;
  amount_range: string;
  owner: string;
}
