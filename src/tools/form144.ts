import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares, truncate } from "../format.js";

export function registerForm144Tools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_form144_notices
  // ---------------------------------------------------------------------------
  server.tool(
    "get_form144_notices",
    "Get SEC Form 144 filings — notices of proposed sale of restricted/controlled securities by insiders. Filed before selling, these signal upcoming insider sales. Complements Form 4 (post-trade) with pre-trade intent.",
    {
      ticker: z.string().optional().describe("Filter by stock ticker (e.g. 'AAPL')"),
      insider_cik: z.string().optional().describe("Filter by insider's CIK number"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Max notices to return"),
    },
    async ({ ticker, insider_cik, limit }) => {
      // koFetch returns the array directly
      const notices = await koFetch<Form144Row[]>(config, "/api/v1/form144-notices", {
        ticker: ticker?.toUpperCase(),
        cik: insider_cik,
        per_page: limit,
      });

      const lines: string[] = [
        `## Form 144 Notices${ticker ? ` — ${ticker.toUpperCase()}` : ""}`,
        `*${notices.length} filings returned*\n`,
      ];

      if (notices.length > 0) {
        lines.push("| Filed | Ticker | Seller | Relationship | Units to Sell | Market Value | 10b5-1 |");
        lines.push("|-------|--------|--------|-------------|---------------|-------------|--------|");

        for (const n of truncate(notices, 50) as Form144Row[]) {
          const plan = n.has_10b5_1_plan ? "Yes" : "—";
          lines.push(
            `| ${n.filed_date} | **${n.issuer_ticker || "—"}** | ${n.seller_name} | ${n.relationship || "—"} | ${fmtShares(n.num_units_to_sell)} | ${fmtMoney(n.aggregate_market_value)} | ${plan} |`
          );
        }

        if (notices.length > 50) {
          lines.push(
            `\n*Showing 50 of ${notices.length} total notices.*`
          );
        }
      } else {
        lines.push("\nNo Form 144 notices found.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Form144Row {
  accession_no: string;
  filed_date: string;
  issuer_ticker: string;
  issuer_name: string;
  issuer_cik: string;
  seller_name: string;
  relationship: string;
  securities_class: string;
  num_units_to_sell: number;
  aggregate_market_value: number;
  approx_sale_date: string;
  broker_name: string;
  has_10b5_1_plan: number;
}
