import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney } from "../format.js";
import { dec, int, str } from "../paging.js";
import { SEARCH_OUTPUT } from "../output-schemas.js";

export function registerSearchTool(server: McpServer, config: KoConfig) {
  defineTool(server, 
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
      const data = (await koFetch<SearchData>(config, "/api/v1/search", { q: query, limit })) ?? ({} as SearchData);
      const arr = <T,>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
      const structured = {
        query,
        institutions: arr(data.institutions).map((r) => ({
          cik: str(r.cik), name: str(r.name), slug: str(r.slug), category: str(r.category), aum: dec(r.aum), rank: int(r.rank),
          matched_person: r.matched_person?.name ? { name: str(r.matched_person.name), role: str(r.matched_person.role) } : null,
        })),
        stocks: arr(data.stocks).map((r) => ({
          ticker: str(r.ticker), name: str(r.name), sector: str(r.sector), industry: str(r.industry), market_cap: dec(r.market_cap),
        })),
        insiders: arr(data.insiders).map((r) => ({ name: str(r.name), ticker: str(r.ticker), type: str(r.type) })),
        congress: arr(data.congress).map((r) => ({ name: str(r.name), type: str(r.type) })),
      };

      const hasResults =
        (data.institutions?.length || 0) +
        (data.stocks?.length || 0) +
        (data.insiders?.length || 0) +
        (data.congress?.length || 0) > 0;

      if (!hasResults) {
        return {
          content: [{ type: "text", text: `No results found for "${query}".` }],
          structuredContent: structured,
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

      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: structured };
    },
    { outputSchema: SEARCH_OUTPUT },
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
