import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { resolveInstitution } from "../resolve.js";
import { fmtMoney, fmtShares } from "../format.js";

export function registerInstitutionTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_institution_holdings
  // ---------------------------------------------------------------------------
  server.tool(
    "get_institution_holdings",
    "Get current stock holdings of an institutional investor (hedge fund, mutual fund, pension fund) from their latest SEC 13F filing. Returns top positions with share counts, values, and quarter-over-quarter changes.",
    {
      institution: z
        .string()
        .max(200)
        .describe(
          "Institution CIK number (e.g. '1067983'), slug (e.g. 'berkshire-hathaway'), or name (e.g. 'Berkshire Hathaway') — names are resolved automatically."
        ),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(100).optional().default(50).describe("Results per page"),
    },
    async ({ institution, page, limit }) => {
      // Accept a CIK, a slug, or a free-text name (resolve names -> CIK).
      const resolved = await resolveInstitution(config, institution);
      if (!resolved) {
        return {
          content: [
            {
              type: "text",
              text: `No institution found matching "${institution}". Use list_institutions or the search tool to find the exact CIK or slug.`,
            },
          ],
        };
      }

      // koFetch returns the array directly (unwrapped from { data, meta })
      const holdings = await koFetch<HoldingRow[]>(
        config,
        `/api/v1/holdings/${encodeURIComponent(resolved.target)}`,
        { page, per_page: limit }
      );

      const totalCount = holdings.length;
      const lines: string[] = [];

      if (resolved.note) lines.push(resolved.note);
      const qtr = holdings.length > 0 ? holdings[0].quarter_date : "Unknown";
      lines.push(`## 13F Holdings — Quarter: ${qtr}`);
      lines.push(`**Positions shown:** ${totalCount}\n`);

      if (holdings.length > 0) {
        lines.push("| # | Ticker | Issuer | Value | Shares | Weight | Change | Action |");
        lines.push("|---|--------|--------|-------|--------|--------|--------|--------|");

        for (const [i, h] of holdings.entries()) {
          const num = (page - 1) * limit + i + 1;
          const changeStr = h.share_change
            ? `${h.share_change > 0 ? "+" : ""}${fmtShares(h.share_change)}`
            : "—";
          const option = h.is_option ? " (opt)" : "";
          lines.push(
            `| ${num} | **${h.ticker || "N/A"}**${option} | ${h.name_of_issuer} | ${fmtMoney(h.holding_value)} | ${fmtShares(h.shares_held)} | ${h.portfolio_weight_pct?.toFixed(2) ?? "—"}% | ${changeStr} | ${h.action} |`
          );
        }

        if (holdings.length === limit) {
          lines.push(`\n*Page ${page} — use page=${page + 1} for more.*`);
        }
      } else {
        lines.push("\nNo holdings found.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: list_institutions
  // ---------------------------------------------------------------------------
  server.tool(
    "list_institutions",
    "List top institutional investors (hedge funds, mutual funds, etc.) tracked in the SEC 13F database. Supports search by name and pagination.",
    {
      search: z.string().max(200).optional().describe("Search by institution or founder name"),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Results per page"),
    },
    async ({ search, page, limit }) => {
      // koFetch returns the array directly
      const institutions = await koFetch<InstitutionRow[]>(
        config,
        "/api/v1/institutions",
        { search, page, limit }
      );

      const lines: string[] = [];
      lines.push(`## Institutional Investors (Page ${page})\n`);
      lines.push("| # | Name | CIK | Rank | Category | Portfolio Value | Stocks |");
      lines.push("|---|------|-----|------|----------|----------------|--------|");

      for (const [i, inst] of institutions.entries()) {
        const num = (page - 1) * limit + i + 1;
        lines.push(
          `| ${num} | **${inst.name}** | ${inst.cik} | ${inst.rank ?? "—"} | ${inst.category || "—"} | ${fmtMoney(inst.portfolio_value)} | ${inst.stock_count ?? "—"} |`
        );
      }

      if (institutions.length === limit) {
        lines.push(`\n*More results available — use page=${page + 1}*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface HoldingRow {
  cik: string;
  quarter_date: string;
  ticker: string | null;
  name_of_issuer: string;
  shares_held: number;
  holding_value: number;
  total_portfolio_value: number;
  portfolio_weight_pct: number | null;
  action: string;
  share_change: number;
  prev_shares: number;
  prev_value: number;
  is_option: boolean | null;
}

interface InstitutionRow {
  cik: string;
  name: string;
  slug: string;
  description: string | null;
  founder_name: string | null;
  image_url: string | null;
  website: string | null;
  rank: number | null;
  ticker: string | null;
  category: string | null;
  portfolio_value: number | null;
  stock_count: number | null;
  top_holdings: string | null;
}
