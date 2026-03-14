import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";

export function registerCongressTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_congress_trades
  // ---------------------------------------------------------------------------
  server.tool(
    "get_congress_trades",
    "Get stock trades made by U.S. Congress members (House & Senate). Data sourced from mandatory financial disclosures. Filter by chamber, party, state, date range, or specific stock ticker.",
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
      sort: z
        .enum(["volume", "trades", "recent"])
        .optional()
        .default("volume")
        .describe("Sort order — volume (most traded value), trades (most trades), recent (latest first)"),
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
    async ({ chamber, party, ticker, state, search, sort, page, limit }) => {
      // koFetch returns the array directly
      const trades = await koFetch<CongressTrade[]>(
        config,
        "/api/v1/congress-trades",
        { chamber, party, ticker, state, search, sort, page, limit }
      );

      const lines: string[] = [];
      lines.push(`## Congress Trades\n`);

      if (trades.length > 0) {
        lines.push("| # | Member | Chamber | Ticker | Asset | Type | Date | Disclosed | Amount | Owner |");
        lines.push("|---|--------|---------|--------|-------|------|------|-----------|--------|-------|");

        for (const [i, t] of trades.entries()) {
          const num = (page - 1) * limit + i + 1;
          lines.push(
            `| ${num} | **${t.member_name}** | ${t.chamber} | ${t.ticker || "—"} | ${t.asset_description?.slice(0, 40) || "—"} | ${t.transaction_type} | ${t.transaction_date} | ${t.disclosure_date} | ${t.amount_range} | ${t.owner || "—"} |`
          );
        }
      } else {
        lines.push("No congress trades found matching the criteria.");
      }

      if (trades.length === limit) {
        lines.push(`\n*Page ${page} — use page=${page + 1} for more.*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_congress_member
  // ---------------------------------------------------------------------------
  server.tool(
    "get_congress_member",
    "Get detailed trading history of a specific U.S. Congress member. Shows individual trades with transaction types, amounts, and disclosure dates.",
    {
      member: z
        .string()
        .describe(
          "Member slug (e.g. 'nancy-pelosi', 'dan-crenshaw'). Use get_congress_trades or search to find exact slugs."
        ),
      page: z.number().int().min(1).optional().default(1),
      limit: z.number().int().min(1).max(100).optional().default(50),
    },
    async ({ member, page, limit }) => {
      const memberSlug = encodeURIComponent(member.toLowerCase().trim());

      // koFetch returns the array directly
      const trades = await koFetch<CongressTrade[]>(
        config,
        `/api/v1/congress-trades/${memberSlug}`,
        { type: "trades", page, limit }
      );

      const lines: string[] = [
        `## ${member} — Trading History`,
        `*${trades.length} trades returned*\n`,
        "| Date | Ticker | Asset | Type | Amount | Disclosed | Owner |",
        "|------|--------|-------|------|--------|-----------|-------|",
      ];

      for (const t of trades) {
        lines.push(
          `| ${t.transaction_date} | **${t.ticker || "N/A"}** | ${t.asset_description?.slice(0, 40) || "—"} | ${t.transaction_type} | ${t.amount_range} | ${t.disclosure_date} | ${t.owner || "—"} |`
        );
      }

      if (trades.length === limit) {
        lines.push(`\n*Showing ${trades.length} trades — use page=${page + 1} for more.*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CongressTrade {
  member_name: string;
  chamber: string;
  ticker: string | null;
  asset_description: string | null;
  transaction_type: string;
  transaction_date: string;
  disclosure_date: string;
  amount_range: string;
  owner: string | null;
}
