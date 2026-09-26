import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, type KoConfig } from "../ko-fetch.js";
import { pagingOf, pagingLines, windowLine } from "../paging.js";
import { fmtMoney, fmtShares, truncate } from "../format.js";

export function registerForm144Tools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_form144_notices
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_form144_notices",
    "Get SEC Form 144 filings — notices of proposed sale of restricted/controlled securities by insiders. Filed before selling, these signal upcoming insider sales. Complements Form 4 (post-trade) with pre-trade intent.",
    {
      ticker: z.string().max(200).optional().describe("Filter by stock ticker (e.g. 'AAPL')"),
      insider_cik: z.string().max(200).optional().describe("Filter by insider's CIK number"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Max notices to return"),
    },
    async ({ ticker, insider_cik, limit }) => {
      // koFetch returns the array directly
      const env = asEnvelope<Form144Row[]>(
        await koFetch<unknown>(
          config,
          "/api/v1/form144-notices",
          { ticker: ticker?.toUpperCase(), cik: insider_cik, per_page: limit },
          { envelope: true },
        ),
      );
      const notices = Array.isArray(env.data) ? env.data : [];

      const lines: string[] = [
        `## Form 144 Notices${ticker ? ` — ${ticker.toUpperCase()}` : ""}`,
        `*${notices.length} filings returned*\n`,
      ];
      const w = windowLine(env.meta);
      if (w) lines.splice(2, 0, `${w}\n`);

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
        // No `page` input on this tool: the only honest footer is whether rows
        // were withheld (keyless cap) or more exist beyond this one page.
        const p = pagingOf(env.meta, { page: 1, limit, returned: notices.length });
        if (p.truncated_by_plan || (p.continuation && p.has_more !== false)) {
          lines.push(`\n*More notices exist than this answer shows${p.plan_row_cap !== null ? ` (keyless cap: ${p.plan_row_cap} rows)` : ""}; send a free ko.io API key to raise the limit.*`);
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
