import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney } from "../format.js";

export function registerSearchTool(server: McpServer, config: KoConfig) {
  server.tool(
    "search",
    "Search across institutions, stocks, and insider traders in the ko.io SEC database. Use this first when you have a name but need the CIK number, ticker, or slug to use with other tools.",
    {
      query: z
        .string()
        .min(2)
        .describe("Search query — company name, ticker, person name, or institution name (min 2 characters)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe("Max results per category"),
    },
    async ({ query, limit }) => {
      const data = await koFetch<{
        data: {
          institutions: SearchResult[];
          stocks: SearchResult[];
          insiders: SearchResult[];
          query: string;
        };
      }>(config, "/api/v1/search", { q: query, limit });

      const { institutions, stocks, insiders } = data.data;

      if (institutions.length === 0 && stocks.length === 0 && insiders.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${query}".` }],
        };
      }

      const lines: string[] = [`## Search Results for "${query}"\n`];

      if (institutions.length > 0) {
        lines.push("### Institutions\n");
        lines.push("| Name | Category | CIK | Slug |");
        lines.push("|------|----------|-----|------|");
        for (const r of institutions) {
          lines.push(
            `| **${r.name}** | ${r.category || "—"} | ${r.cik} | ${r.slug || "—"} |`
          );
        }
        lines.push("");
      }

      if (stocks.length > 0) {
        lines.push("### Stocks\n");
        lines.push("| Ticker | Company | Sector | Market Cap |");
        lines.push("|--------|---------|--------|------------|");
        for (const r of stocks) {
          lines.push(
            `| **${r.ticker}** | ${r.company_name || r.name} | ${r.sector || "—"} | ${fmtMoney(r.market_cap)} |`
          );
        }
        lines.push("");
      }

      if (insiders.length > 0) {
        lines.push("### Insiders\n");
        lines.push("| Name | Ticker | Company | Title |");
        lines.push("|------|--------|---------|-------|");
        for (const r of insiders) {
          lines.push(
            `| **${r.name}** | ${r.ticker || "—"} | ${r.company_name || "—"} | ${r.title || "—"} |`
          );
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

interface SearchResult {
  type: "institution" | "stock" | "insider";
  cik?: string;
  name: string;
  slug?: string;
  category?: string;
  founder_name?: string;
  ticker?: string;
  company_name?: string;
  sector?: string;
  industry?: string;
  market_cap?: number;
  title?: string;
}
