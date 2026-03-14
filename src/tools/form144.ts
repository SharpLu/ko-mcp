import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares } from "../format.js";

function truncate(arr: unknown[], max: number): unknown[] {
  return arr.slice(0, max);
}

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
      const data = await koFetch<{
        data: Form144Row[];
        meta: { total_count: number; page: number; per_page: number };
      }>(config, "/api/v1/form144-notices", {
        ticker: ticker?.toUpperCase(),
        cik: insider_cik,
        per_page: limit,
      });

      const lines: string[] = [
        `## Form 144 Notices${ticker ? ` — ${ticker.toUpperCase()}` : ""}`,
        `*${data.meta.total_count} total filings*\n`,
      ];

      if (data.data.length > 0) {
        lines.push("| Filed | Ticker | Seller | Relationship | Units to Sell | Market Value | 10b5-1 |");
        lines.push("|-------|--------|--------|-------------|---------------|-------------|--------|");

        for (const n of truncate(data.data, 50) as Form144Row[]) {
          const plan = n.has_10b5_1_plan ? "Yes" : "—";
          lines.push(
            `| ${n.filed_date} | **${n.issuer_ticker || "—"}** | ${n.seller_name} | ${n.relationship || "—"} | ${fmtShares(n.num_units_to_sell)} | ${fmtMoney(n.aggregate_market_value)} | ${plan} |`
          );
        }

        if (data.meta.total_count > data.data.length) {
          lines.push(
            `\n*Showing ${data.data.length} of ${data.meta.total_count} total notices.*`
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
