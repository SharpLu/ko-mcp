import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney } from "../format.js";

export function registerSearchTool(server: McpServer, config: KoConfig) {
  server.tool(
    "search",
    "Search across institutions, stocks, and insider traders in the ko.io SEC database. Institutions match by firm name OR manager name ('Seth Klarman' -> Baupost, 'Ackman' -> Pershing Square; person hits carry matched_person). Use this first when you have a name but need the CIK number, ticker, or slug to use with other tools.",
    {
      query: z
        .string()
        .min(2)
        .max(200)
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
      const data = await koFetch<SearchData>(config, "/api/v1/search", { q: query, limit });

      const hasResults =
        (data.institutions?.length || 0) +
        (data.stocks?.length || 0) +
        (data.insiders?.length || 0) +
        (data.congress?.length || 0) > 0;

      if (!hasResults) {
        return {
          content: [{ type: "text", text: `No results found for "${query}".` }],
        };
      }

      const lines: string[] = [`## Search Results for "${query}"\n`];

      if (data.institutions?.length) {
        lines.push("### Institutions\n");
        lines.push("| Name | Matched Person | CIK | Slug | Category |");
        lines.push("|------|----------------|-----|------|----------|");
        for (const r of data.institutions) {
          const person = r.matched_person?.name
            ? `${r.matched_person.name}${r.matched_person.role ? ` (${r.matched_person.role})` : ""}`
            : "—";
          lines.push(
            `| **${r.name}** | ${person} | ${r.cik} | ${r.slug || "—"} | ${r.category || "—"} |`
          );
        }
        lines.push("");
      }

      if (data.stocks?.length) {
        lines.push("### Stocks\n");
        lines.push("| Ticker | Company | Sector | Industry | Market Cap |");
        lines.push("|--------|---------|--------|----------|------------|");
        for (const r of data.stocks) {
          lines.push(
            `| **${r.ticker}** | ${r.name} | ${r.sector || "—"} | ${r.industry || "—"} | ${fmtMoney(r.market_cap)} |`
          );
        }
        lines.push("");
      }

      if (data.insiders?.length) {
        lines.push("### Insiders\n");
        lines.push("| Name | Ticker | Type |");
        lines.push("|------|--------|------|");
        for (const r of data.insiders) {
          lines.push(
            `| **${r.name}** | ${r.ticker || "—"} | ${r.type || "—"} |`
          );
        }
        lines.push("");
      }

      if (data.congress?.length) {
        lines.push("### Congress Members\n");
        lines.push("| Name | Type |");
        lines.push("|------|------|");
        for (const r of data.congress) {
          lines.push(`| **${r.name}** | ${r.type || "—"} |`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

interface SearchData {
  institutions: SearchInstitution[];
  stocks: SearchStock[];
  insiders: SearchInsider[];
  congress: SearchCongress[];
  query: string;
  generated_at: string;
}

interface SearchInstitution {
  type: string;
  cik: string;
  name: string;
  slug: string;
  aum: number | null;
  rank: number | null;
  category: string | null;
  matched_person?: { name: string; role: string } | null;
}

interface SearchStock {
  type: string;
  ticker: string;
  name: string;
  sector: string | null;
  industry: string | null;
  market_cap: number | null;
}

interface SearchInsider {
  type: string;
  name: string;
  ticker: string | null;
}

interface SearchCongress {
  type: string;
  name: string;
}
