import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { koFetch, type KoConfig } from "../ko-fetch.js";
import { fmtMoney, fmtShares } from "../format.js";

// Institutional exposure to US spot crypto ETFs (BTC complex: IBIT, FBTC, GBTC,
// ...), derived from 13F filings. Proxies ko-api /api/v1/crypto/*. USD-exact,
// equity shares only (no BTC-equivalent / price / on-chain).
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const qoq = (v: unknown): string => {
  const n = num(v);
  return `${n >= 0 ? "+" : ""}${fmtMoney(n)}`;
};

export function registerCryptoTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_crypto_exposure — complex-wide + per-product summary
  // ---------------------------------------------------------------------------
  server.tool(
    "get_crypto_exposure",
    "Get a market-wide summary of institutional exposure to US spot crypto ETFs (Bitcoin ETF complex: IBIT, FBTC, GBTC, etc.) from the latest quarter of SEC 13F filings. Returns total institutional USD held, quarter-over-quarter change, and a per-ETF breakdown (holders, USD, QoQ).",
    {},
    async () => {
      const data = await koFetch<ExposureSummary>(config, "/api/v1/crypto/exposure-summary");
      const lines: string[] = [];
      lines.push("## Institutional Crypto-ETF Exposure (latest quarter)\n");
      lines.push(`**Total institutional USD:** ${fmtMoney(num(data.complex?.total_usd))}`);
      lines.push(`**QoQ change:** ${qoq(data.complex?.qoq_change)}`);
      lines.push(`**Products tracked:** ${data.complex?.products ?? "—"}\n`);

      const products = data.products ?? [];
      if (products.length > 0) {
        lines.push("| ETF | Name | Sponsor | Holders | USD Held | QoQ |");
        lines.push("|-----|------|---------|---------|----------|-----|");
        for (const p of products) {
          lines.push(
            `| **${p.product_ticker}** | ${p.product_name || "—"} | ${p.sponsor || "—"} | ${num(p.holders) || "—"} | ${fmtMoney(num(p.total_usd))} | ${qoq(p.qoq_change)} |`
          );
        }
      } else {
        lines.push("No crypto-ETF exposure data available.");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_crypto_holders — institutions holding spot crypto ETFs
  // ---------------------------------------------------------------------------
  server.tool(
    "get_crypto_holders",
    "List institutional investors holding US spot crypto ETFs (Bitcoin ETF complex), ranked by total USD held, from the latest quarter of SEC 13F filings. Optionally filter to holders of a specific ETF via the `product` parameter (e.g. 'IBIT').",
    {
      product: z.string().optional().describe("Filter to holders of a specific spot crypto ETF ticker, e.g. 'IBIT', 'FBTC', 'GBTC'."),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Results per page"),
    },
    async ({ product, page, limit }) => {
      const data = await koFetch<HoldersResponse>(config, "/api/v1/crypto/institutional-holders", {
        product: product ? product.toUpperCase() : undefined,
        page,
        per_page: limit,
      });
      const holders = data.holders ?? [];
      const lines: string[] = [];
      lines.push(`## Institutional Holders of Spot Crypto ETFs${product ? ` — ${product.toUpperCase()}` : ""}`);
      lines.push(`**Total holders:** ${data.total_count ?? holders.length} · Page ${data.page ?? page}\n`);

      if (holders.length > 0) {
        lines.push("| Rank | Institution | CIK | USD Held | QoQ | # ETFs | Products |");
        lines.push("|------|-------------|-----|----------|-----|--------|----------|");
        for (const h of holders) {
          const products = Array.isArray(h.products) ? h.products.join(", ") : "—";
          lines.push(
            `| ${h.rank ?? "—"} | **${h.name || `CIK ${h.cik}`}** | ${h.cik} | ${fmtMoney(num(h.total_usd))} | ${qoq(h.qoq_value_change)} | ${num(h.product_count) || "—"} | ${products} |`
          );
        }
        if (holders.length === limit) lines.push(`\n*Page ${page} — use page=${page + 1} for more.*`);
      } else {
        lines.push("No institutional holders found.");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_crypto_holder — one institution's crypto-ETF positions
  // ---------------------------------------------------------------------------
  server.tool(
    "get_crypto_holder",
    "Get one institution's spot crypto-ETF holdings (Bitcoin ETF complex): its per-ETF positions in the latest filed quarter (shares, USD, QoQ change, action) plus its rank among all crypto-ETF holders. Use a CIK number (find it with get_crypto_holders or the search tool).",
    {
      institution: z.string().describe("Institution CIK number, e.g. '1512857' (Brevan Howard)."),
    },
    async ({ institution }) => {
      const cik = institution.replace(/\D/g, "");
      if (!cik) {
        return { content: [{ type: "text", text: "Please provide a numeric CIK (e.g. '1512857')." }] };
      }
      const data = await koFetch<HolderDetail>(config, `/api/v1/crypto/holder/${encodeURIComponent(cik)}`);
      const inst = data.institution;
      const positions = data.positions ?? [];
      const lines: string[] = [];
      lines.push(`## ${inst?.name || `CIK ${cik}`} — Spot Crypto-ETF Holdings`);
      lines.push(`**Latest quarter:** ${inst?.latest_quarter ?? "—"}`);
      lines.push(`**Total crypto-ETF USD:** ${fmtMoney(num(inst?.total_usd))} (QoQ ${qoq(inst?.qoq_change)})`);
      lines.push(`**Rank:** ${inst?.rank ?? "—"} of ${inst?.total_holders ?? "—"} holders · **Portfolio weight:** ${inst?.portfolio_weight_pct?.toFixed(2) ?? "—"}%\n`);

      if (positions.length > 0) {
        lines.push("| ETF | Name | Shares | USD Held | QoQ | Action |");
        lines.push("|-----|------|--------|----------|-----|--------|");
        for (const p of positions) {
          lines.push(
            `| **${p.product_ticker}** | ${p.product_name || "—"} | ${fmtShares(num(p.shares_held))} | ${fmtMoney(num(p.usd_value))} | ${qoq(p.qoq_value_change)} | ${p.action || "—"} |`
          );
        }
      } else {
        lines.push("No spot crypto-ETF positions for this institution.");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types (numeric fields arrive as strings from ko-api — coerce with num())
// ---------------------------------------------------------------------------
interface ExposureSummary {
  complex?: { total_usd: number | string; qoq_change: number | string; products: number };
  products?: Array<{
    product_ticker: string; product_name: string; sponsor: string;
    holders: number | string; total_usd: number | string; prev_usd: number | string; qoq_change: number | string;
  }>;
}
interface HoldersResponse {
  product?: string; page?: number; per_page?: number; total_count?: number;
  holders?: Array<{
    cik: string; name: string; slug: string;
    total_usd: string | number; prev_usd: string | number; qoq_value_change: string | number;
    product_count: string | number; products: string[]; rank?: number;
  }>;
}
interface HolderDetail {
  institution?: {
    cik: string; name: string; slug: string; latest_quarter: string | null;
    total_usd: number | string; qoq_change: number | string; products: number;
    portfolio_weight_pct: number | null; rank: number; total_holders: number;
  };
  positions?: Array<{
    product_ticker: string; product_name: string; sponsor: string;
    shares_held: string | number; usd_value: string | number; prev_usd_value: string | number;
    qoq_value_change: string | number; share_change: string | number; action: string; portfolio_weight_pct: number;
  }>;
  history?: unknown[];
}
