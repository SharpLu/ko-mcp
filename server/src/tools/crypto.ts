import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, type KoConfig } from "../ko-fetch.js";
import { pagingOf, pagingLines, planLimitOf, dec, int, str } from "../paging.js";
import { CRYPTO_EXPOSURE_OUTPUT, CRYPTO_HOLDERS_OUTPUT, CRYPTO_HOLDER_OUTPUT } from "../output-schemas.js";
import { resolveInstitution } from "../resolve.js";
import { fmtMoney, fmtShares, fmtPct2, num } from "../format.js";

// Institutional exposure to US spot crypto ETFs (BTC complex: IBIT, FBTC, GBTC,
// ...), derived from 13F filings. Proxies ko-api /api/v1/crypto/*. USD-exact,
// equity shares only (no BTC-equivalent / price / on-chain).
const qoq = (v: unknown): string => {
  const n = num(v);
  return `${n >= 0 ? "+" : ""}${fmtMoney(n)}`;
};

export function registerCryptoTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_crypto_exposure — complex-wide + per-product summary
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_crypto_exposure",
    "Get a market-wide summary of institutional exposure to US spot crypto ETFs (Bitcoin ETF complex: IBIT, FBTC, GBTC, etc.) from the latest quarter of SEC 13F filings. Returns total institutional USD held, quarter-over-quarter change, and a per-ETF breakdown (holders, USD, QoQ).",
    {},
    async () => {
      const data = (await koFetch<ExposureSummary>(config, "/api/v1/crypto/exposure-summary")) ?? {};
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
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          complex: {
            total_usd: dec(data.complex?.total_usd), qoq_change: dec(data.complex?.qoq_change), products: int(data.complex?.products),
          },
          products: products.map((p) => ({
            product_ticker: str(p.product_ticker), product_name: str(p.product_name), sponsor: str(p.sponsor),
            holders: int(p.holders), total_usd: dec(p.total_usd), prev_usd: dec(p.prev_usd), qoq_change: dec(p.qoq_change),
          })),
        },
      };
    },
    { outputSchema: CRYPTO_EXPOSURE_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: get_crypto_holders — institutions holding spot crypto ETFs
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_crypto_holders",
    "List institutional investors holding US spot crypto ETFs (Bitcoin ETF complex), ranked by total USD held, from the latest quarter of SEC 13F filings. Optionally filter to holders of a specific ETF via the `product` parameter (e.g. 'IBIT').",
    {
      product: z.string().max(200).optional().describe("Filter to holders of a specific spot crypto ETF ticker, e.g. 'IBIT', 'FBTC', 'GBTC'."),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Results per page"),
    },
    async ({ product, page, limit }) => {
      const env = asEnvelope<HoldersResponse>(
        await koFetch<unknown>(
          config,
          "/api/v1/crypto/institutional-holders",
          { product: product ? product.toUpperCase() : undefined, page, per_page: limit },
          { envelope: true },
        ),
      );
      const data = env.data ?? ({} as HoldersResponse);
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
        if (env.meta.softwall) {
          lines.push(...pagingLines(pagingOf({ ...env.meta, total_count: data.total_count ?? env.meta.total_count }, { page, limit, returned: holders.length })));
        } else if (holders.length === limit) lines.push(`\n*Page ${page} — use page=${page + 1} for more.*`);
      } else {
        lines.push("No institutional holders found.");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          product: product ? product.toUpperCase() : null,
          total_holders: int(data.total_count),
          rows: holders.map((h) => ({
            rank: int(h.rank), cik: str(h.cik), name: str(h.name), total_usd: dec(h.total_usd), prev_usd: dec(h.prev_usd),
            qoq_value_change: dec(h.qoq_value_change), product_count: int(h.product_count),
            products: Array.isArray(h.products) ? h.products.map(String) : [],
          })),
          paging: pagingOf({ ...env.meta, total_count: data.total_count ?? env.meta.total_count }, { page, limit, returned: holders.length }),
          plan_limit: planLimitOf(env.meta),
        },
      };
    },
    { outputSchema: CRYPTO_HOLDERS_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: get_crypto_holder — one institution's crypto-ETF positions
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_crypto_holder",
    "Get one institution's spot crypto-ETF holdings (Bitcoin ETF complex): its per-ETF positions in the latest filed quarter (shares, USD, QoQ change, action) plus its rank among all crypto-ETF holders. Use a CIK number (find it with get_crypto_holders or the search tool).",
    {
      institution: z
        .string()
        .max(200)
        .describe("Institution CIK number (e.g. '1512857' for Brevan Howard) or name (e.g. 'BlackRock')."),
    },
    async ({ institution }) => {
      // Prefer embedded digits (CIK / "CIK 1512857"); fall back to name resolution.
      let cik = institution.replace(/\D/g, "");
      let note = "";
      if (!cik) {
        const resolved = await resolveInstitution(config, institution);
        cik = (resolved?.target ?? "").replace(/\D/g, "");
        note = resolved?.note ?? "";
      }
      if (!cik) {
        return {
          content: [
            {
              type: "text",
              text: `No institution found matching "${institution}". Provide a numeric CIK (e.g. '1512857') or use get_crypto_holders / search to find one.`,
            },
          ],
          structuredContent: { requested: institution, cik: null, institution: null, positions: [], plan_limit: null },
        };
      }
      const env = asEnvelope<HolderDetail>(
        await koFetch<unknown>(config, `/api/v1/crypto/holder/${encodeURIComponent(cik)}`, {}, { envelope: true }),
      );
      const data = env.data ?? ({} as HolderDetail);
      const inst = data.institution;
      const positions = data.positions ?? [];
      const lines: string[] = [];
      if (note) lines.push(note);
      lines.push(`## ${inst?.name || `CIK ${cik}`} — Spot Crypto-ETF Holdings`);
      lines.push(`**Latest quarter:** ${inst?.latest_quarter ?? "—"}`);
      lines.push(`**Total crypto-ETF USD:** ${fmtMoney(num(inst?.total_usd))} (QoQ ${qoq(inst?.qoq_change)})`);
      lines.push(`**Rank:** ${inst?.rank ?? "—"} of ${inst?.total_holders ?? "—"} holders · **Portfolio weight:** ${fmtPct2(inst?.portfolio_weight_pct)}%\n`);

      if (positions.length > 0) {
        lines.push("| ETF | Name | Shares | USD Held | QoQ | Action |");
        lines.push("|-----|------|--------|----------|-----|--------|");
        for (const p of positions) {
          lines.push(
            `| **${p.product_ticker}** | ${p.product_name || "—"} | ${fmtShares(num(p.shares_held))} | ${fmtMoney(num(p.usd_value))} | ${qoq(p.qoq_value_change)} | ${p.action || "—"} |`
          );
        }
        if (env.meta.softwall?.truncated) {
          lines.push(`\n*Keyless access: positions capped at ${env.meta.softwall.row_cap} rows by the ko.io Free plan; more exist. Send a free ko.io API key for all of them.*`);
        }
      } else {
        lines.push("No spot crypto-ETF positions for this institution.");
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          requested: institution,
          cik,
          institution: inst
            ? {
                name: str(inst.name), latest_quarter: str(inst.latest_quarter), total_usd: dec(inst.total_usd),
                qoq_change: dec(inst.qoq_change), rank: int(inst.rank), total_holders: int(inst.total_holders),
                portfolio_weight_pct: dec(inst.portfolio_weight_pct),
              }
            : null,
          positions: positions.map((p) => ({
            product_ticker: str(p.product_ticker), product_name: str(p.product_name), shares_held: dec(p.shares_held),
            usd_value: dec(p.usd_value), qoq_value_change: dec(p.qoq_value_change), action: str(p.action),
          })),
          plan_limit: planLimitOf(env.meta),
        },
      };
    },
    { outputSchema: CRYPTO_HOLDER_OUTPUT },
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
