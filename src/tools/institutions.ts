import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares } from "../format.js";

export function registerInstitutionTools(server: McpServer, config: KoConfig) {
  server.tool(
    "get_institution_holdings",
    "Get current stock holdings of an institutional investor (hedge fund, mutual fund, pension fund) from their latest SEC 13F filing. Returns top positions with share counts, values, and quarter-over-quarter changes.",
    {
      institution: z
        .string()
        .describe(
          "Institution CIK number (e.g. '1067983' for Berkshire Hathaway) or slug (e.g. 'berkshire-hathaway-inc-1067983'). Use the search tool first if you only have a name."
        ),
      show_options: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include option positions in the results"),
      show_cleared: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include positions that were completely sold/cleared this quarter"),
    },
    async ({ institution, show_options, show_cleared }) => {
      const resp = await koFetch<{
        data: HoldingRow[];
        meta: { total_count: string; page: number; per_page: number };
      }>(config, `/api/v1/holdings/${encodeURIComponent(institution)}`);

      const all = resp.data;
      if (all.length === 0) {
        return { content: [{ type: "text", text: "No holdings found." }] };
      }

      const equities = all.filter((h) => !h.is_option && h.action !== "SOLD_ALL");
      const options = all.filter((h) => h.is_option);
      const cleared = all.filter((h) => h.action === "SOLD_ALL");
      const totalValue = all[0]?.total_portfolio_value ?? 0;
      const qtr = all[0]?.quarter_date ?? "Unknown";

      const lines: string[] = [];
      lines.push(`## 13F Holdings — Quarter: ${qtr}`);
      lines.push(`**Total Portfolio Value:** ${fmtMoney(Number(totalValue))}`);
      lines.push(`**Positions:** ${equities.length} equity | ${options.length} options | ${cleared.length} cleared\n`);

      if (equities.length > 0) {
        lines.push("### Top Equity Holdings\n");
        lines.push("| # | Ticker | Issuer | Value | Shares | Weight | Change | Action |");
        lines.push("|---|--------|--------|-------|--------|--------|--------|--------|");

        for (const [i, h] of equities.slice(0, 30).entries()) {
          const sc = Number(h.share_change);
          const changeStr = sc ? `${sc > 0 ? "+" : ""}${fmtShares(sc)}` : "—";
          lines.push(
            `| ${i + 1} | **${h.ticker || "N/A"}** | ${h.name_of_issuer} | ${fmtMoney(Number(h.holding_value))} | ${fmtShares(Number(h.shares_held))} | ${h.portfolio_weight_pct?.toFixed(2) ?? "—"}% | ${changeStr} | ${h.action} |`
          );
        }
        if (equities.length > 30) {
          lines.push(`\n*Showing top 30 of ${equities.length} positions.*`);
        }
      }

      if (show_options && options.length > 0) {
        lines.push("\n### Option Positions\n");
        lines.push("| Ticker | Issuer | Value | Shares | Action |");
        lines.push("|--------|--------|-------|--------|--------|");
        for (const h of options.slice(0, 20)) {
          lines.push(
            `| **${h.ticker || "N/A"}** | ${h.name_of_issuer} | ${fmtMoney(Number(h.holding_value))} | ${fmtShares(Number(h.shares_held))} | ${h.action} |`
          );
        }
      }

      if (show_cleared && cleared.length > 0) {
        lines.push("\n### Cleared Positions (Sold Entirely)\n");
        lines.push("| Ticker | Issuer | Prev Shares | Prev Value |");
        lines.push("|--------|--------|-------------|------------|");
        for (const h of cleared.slice(0, 20)) {
          lines.push(
            `| **${h.ticker || "N/A"}** | ${h.name_of_issuer} | ${fmtShares(Number(h.prev_shares))} | ${fmtMoney(Number(h.prev_value))} |`
          );
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "list_institutions",
    "List top institutional investors (hedge funds, mutual funds, etc.) tracked in the SEC 13F database. Supports search by name and pagination.",
    {
      search: z.string().optional().describe("Search by institution or founder name"),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Results per page"),
    },
    async ({ search, page, limit }) => {
      const resp = await koFetch<{
        data: InstitutionRow[];
        meta: { total_count: string; page: number; per_page: number };
      }>(config, "/api/v1/institutions", { search, page, limit });

      const total = Number(resp.meta.total_count);
      const hasMore = page * limit < total;
      const lines: string[] = [];
      lines.push(`## Institutional Investors (Page ${page}, ${total} total)\n`);
      lines.push("| # | Name | Founder | CIK |");
      lines.push("|---|------|---------|-----|");

      for (const [i, inst] of resp.data.entries()) {
        const num = (page - 1) * limit + i + 1;
        lines.push(
          `| ${num} | **${inst.name}** | ${inst.founder_name || "—"} | ${inst.cik} |`
        );
      }

      if (hasMore) {
        lines.push(`\n*More results available — use page=${page + 1}*`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

interface HoldingRow {
  cik: string;
  quarter_date: string;
  ticker: string | null;
  name_of_issuer: string;
  shares_held: string | number;
  holding_value: string | number;
  total_portfolio_value: string | number;
  portfolio_weight_pct: number | null;
  action: string;
  share_change: string | number;
  prev_shares: string | number;
  prev_value: string | number;
  is_option: number;
}

interface InstitutionRow {
  cik: string;
  name: string;
  slug: string;
  founder_name: string | null;
  image_url: string | null;
  rank: number;
  category: string | null;
  portfolio_value: string | number | null;
}
