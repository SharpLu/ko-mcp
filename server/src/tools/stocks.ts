import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, KoApiError, type KoConfig, type KoEnvelope } from "../ko-fetch.js";
import { fmtMoney, fmtShares, fmtPct, truncate, num } from "../format.js";
import { pagingOf, pagingLines, windowLine, planLimitOf, dec, int, fmtIntExact } from "../paging.js";
import { STOCK_HOLDERS_OUTPUT, STOCK_ACTIVITY_OUTPUT } from "../output-schemas.js";

/** Pro default for get_stock_activity when the caller did not choose. */
const DEFAULT_ACTIVITY_QUARTERS = 8;

/**
 * Option legs of a 13F position (SPEC C1 fields: equity_shares / call_shares /
 * put_shares / has_option_legs). ko-api is adding them to every holder row; the
 * holders route already sends call_shares / put_shares on some rows. Absent =
 * unknown (null), never "no options".
 */
interface LegFields {
  equity_shares?: number | string | null;
  call_shares?: number | string | null;
  put_shares?: number | string | null;
  has_option_legs?: number | boolean | null;
  is_option?: number | boolean | null;
}

function optionFlag(h: LegFields): boolean | null {
  if (h.has_option_legs !== undefined && h.has_option_legs !== null) return Boolean(num(h.has_option_legs));
  if (h.call_shares !== undefined || h.put_shares !== undefined) return num(h.call_shares) + num(h.put_shares) > 0;
  if (h.is_option !== undefined && h.is_option !== null) return Boolean(num(h.is_option));
  return null;
}

function hasOptionLegs(h: LegFields): boolean {
  return optionFlag(h) === true;
}

/** "Name: 6,426,000 common + 43,119,100 via calls + 27,144,600 via puts (options at underlying value)". */
function legNote(name: string, h: LegFields): string {
  const parts: string[] = [];
  if (dec(h.equity_shares) !== null) parts.push(`${fmtIntExact(h.equity_shares)} common`);
  if (num(h.call_shares)) parts.push(`${fmtIntExact(h.call_shares)} via calls`);
  if (num(h.put_shares)) parts.push(`${fmtIntExact(h.put_shares)} via puts`);
  const legs = parts.length ? parts.join(" + ") : "includes option legs (breakdown not reported)";
  return `(opt) ${name}: ${legs}; 13F reports option lines at the underlying's value.`;
}

export function registerStockTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_stock_profile
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_stock_profile",
    "Get a company's profile — sector, market cap, price, P/E ratio, 52-week range, beta, dividend yield, and other key financials.",
    {
      ticker: z.string().max(200).describe("Stock ticker symbol (e.g. 'AAPL', 'NVDA', 'MSFT')"),
    },
    async ({ ticker }) => {
      const data = await koFetch<StockProfileResponse>(
        config,
        `/api/v1/stocks/${encodeURIComponent(ticker.toUpperCase())}`
      );

      const s = data.stock;

      const lines: string[] = [
        `## ${s.ticker}`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| **Sector** | ${s.sector || "N/A"} |`,
        `| **Industry** | ${s.industry || "N/A"} |`,
        `| **Market Cap** | ${fmtMoney(s.market_cap)} |`,
        `| **Price** | $${s.current_price?.toFixed(2) ?? "N/A"} |`,
        `| **Previous Close** | $${s.previous_close?.toFixed(2) ?? "N/A"} |`,
        `| **52W High** | $${s.fifty_two_week_high?.toFixed(2) ?? "N/A"} |`,
        `| **52W Low** | $${s.fifty_two_week_low?.toFixed(2) ?? "N/A"} |`,
        `| **P/E** | ${s.pe_ratio?.toFixed(2) ?? "N/A"} |`,
        `| **EPS** | $${s.eps?.toFixed(2) ?? "N/A"} |`,
        `| **Beta** | ${s.beta?.toFixed(2) ?? "N/A"} |`,
        `| **Dividend Yield** | ${s.dividend_yield ? s.dividend_yield.toFixed(2) + "%" : "N/A"} |`,
        `| **Profit Margins** | ${s.profit_margins ? (s.profit_margins * 100).toFixed(2) + "%" : "N/A"} |`,
        `| **Avg Volume** | ${fmtShares(s.avg_volume)} |`,
      ];

      if (data.top_holders?.length) {
        lines.push("", "### Top Institutional Holders\n");
        lines.push("| Institution | Shares | Value | Weight |");
        lines.push("|------------|--------|-------|--------|");
        const legNotes: string[] = [];
        for (const h of (truncate(data.top_holders, 10) as TopHolder[])) {
          const opt = hasOptionLegs(h) ? " (opt)" : "";
          if (hasOptionLegs(h)) legNotes.push(legNote(h.name, h));
          lines.push(
            `| **${h.name}**${opt} | ${fmtShares(h.shares_held)} | ${fmtMoney(h.holding_value)} | ${h.portfolio_weight_pct?.toFixed(2) ?? "—"}% |`
          );
        }
        if (legNotes.length) lines.push("", ...legNotes.map((n) => `*${n}*`));
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ---------------------------------------------------------------------------
  // Tool: get_stock_holders
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_stock_holders",
    "Get top institutional holders of a stock from SEC 13F filings. Shows which hedge funds, mutual funds, and pension funds own the most shares, with quarter-over-quarter changes.",
    {
      ticker: z.string().max(200).describe("Stock ticker symbol (e.g. 'NVDA')"),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Results per page"),
    },
    async ({ ticker, page, limit }) => {
      const t = ticker.toUpperCase();
      const env = asEnvelope<HoldersResponse | HolderRow[]>(
        await koFetch<unknown>(
          config,
          `/api/v1/stock-holders/${encodeURIComponent(t)}`,
          { type: "holders", page, limit },
          { envelope: true },
        ),
      );
      const data = env.data;

      // ko-fetch strips the top-level { data } envelope. Today ko-api's
      // stock-holders route double-nests ({ data: { data:[...], totalCount,
      // quarterDate, ... }, meta }) so ko-fetch hands back an OBJECT. If it ever
      // returns the standard { data:[...], meta } shape, ko-fetch hands back a
      // bare ARRAY. Support both so a shape change doesn't silently 0-out the tool.
      const isArray = Array.isArray(data);
      const rows: HolderRow[] = isArray ? data : (data?.data ?? []);
      const totalCount = isArray ? num(env.meta.total_count) || data.length : data?.totalCount;
      const quarterDate = isArray ? undefined : data?.quarterDate;
      const totalPages = isArray ? undefined : data?.totalPages;
      const basis = typeof env.meta.position_basis === "string" ? env.meta.position_basis : null;

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No institutional holders found for ${t}. Check the ticker symbol.`,
            },
          ],
          structuredContent: {
            ticker: t, quarter_date: quarterDate ?? null, position_basis: basis,
            total_institutions: int(totalCount), rows: [],
            paging: pagingOf({ ...env.meta, total_count: totalCount ?? undefined }, { page, limit, returned: 0 }),
            plan_limit: planLimitOf(env.meta),
          },
        };
      }

      const lines: string[] = [
        `## Institutional Holders of ${t}${quarterDate ? ` — Q${quarterDate}` : ""}`,
        `**Total institutions:** ${totalCount ?? rows.length}`,
        // 13F option lines are reported at the UNDERLYING's value, so a holder's
        // shares/value can be mostly calls and puts (SPEC R1: Susquehanna AAPL
        // 76.7M sh = 6.4M common + 43.1M calls + 27.1M puts). Say what is counted.
        "*Shares and Value are the 13F-reported totals over all legs (common + shares underlying calls + puts); " +
          "rows marked (opt) include option legs.*",
      ];
      const w = windowLine(env.meta);
      if (w) lines.push(w);
      lines.push(
        "",
        "| # | Institution | Value | Shares | Weight | Change | Action |",
        "|---|------------|-------|--------|--------|--------|--------|",
      );

      const legNotes: string[] = [];
      for (const [i, h] of rows.entries()) {
        const rank = (page - 1) * limit + i + 1;
        const change = num(h.share_change);
        const changeStr = change ? `${change > 0 ? "+" : ""}${fmtShares(change)}` : "—";
        const opt = hasOptionLegs(h) ? " (opt)" : "";
        if (hasOptionLegs(h)) legNotes.push(legNote(h.name, h));
        lines.push(
          `| ${rank} | **${h.name}**${opt} | ${fmtMoney(h.holding_value)} | ${fmtShares(h.shares_held)} | ${h.portfolio_weight_pct?.toFixed(2) ?? "—"}% | ${changeStr} | ${h.action} |`
        );
      }
      if (legNotes.length) lines.push("", ...legNotes.map((n) => `*${n}*`));

      const paging = pagingOf(
        { ...env.meta, total_count: totalCount ?? env.meta.total_count },
        { page, limit, returned: rows.length },
      );
      if (env.meta.softwall) {
        lines.push(...pagingLines(paging));
      } else if (totalPages && page < totalPages) {
        lines.push(`\n*Page ${page}/${totalPages} — use page=${page + 1} for more.*`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          ticker: t,
          quarter_date: quarterDate ?? null,
          position_basis: basis,
          total_institutions: int(totalCount),
          rows: rows.map((h, i) => ({
            rank: (page - 1) * limit + i + 1,
            cik: h.cik ?? null,
            name: h.name ?? null,
            shares_held: dec(h.shares_held),
            holding_value: dec(h.holding_value),
            portfolio_weight_pct: dec(h.portfolio_weight_pct),
            share_change: dec(h.share_change),
            action: h.action ?? null,
            equity_shares: dec(h.equity_shares),
            call_shares: dec(h.call_shares),
            put_shares: dec(h.put_shares),
            has_option_legs: optionFlag(h),
          })),
          paging,
          plan_limit: planLimitOf(env.meta),
        },
      };
    },
    { outputSchema: STOCK_HOLDERS_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: get_stock_activity
  //
  // DEFAULT WITHIN THE CALLER'S PLAN (EVAL_CODEX_TECH #6). The old default of
  // quarters=8 is history on the Free plan: ko-api's soft wall allows exactly
  // one quarter there (policy counts: quarters max 1, injected when omitted),
  // so a model that called this tool with its advertised defaults got a 403.
  // Now:
  //   - keyless: always Free, so `quarters` is NOT sent and ko-api injects the
  //     plan maximum (1);
  //   - with a key: 8 is asked for, and if ko-api answers PLAN_REQUIRED on
  //     `quarters` (a Free key) the call is retried once without it;
  //   - an EXPLICIT `quarters` is never silently reduced: over the plan it
  //     returns the plan-limit error.
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_stock_activity",
    "Get institutional buying/selling activity trend for a stock over multiple quarters. Shows how many institutions are buying vs selling, net share changes, and value flows — useful for detecting accumulation or distribution patterns. " +
      "Plan limits: Free/keyless access covers the latest 13F quarter only; the multi-quarter trend requires Pro. " +
      "Omit `quarters` to get the most your plan allows. structuredContent carries the exact net shares/values.",
    {
      ticker: z.string().max(200).describe("Stock ticker symbol"),
      quarters: z
        .number()
        .int()
        .min(1)
        .max(40)
        .optional()
        .describe(
          "Number of quarters to return. Omit for the plan default (Pro: 8 = 2 years; Free/keyless: the latest " +
          "quarter only). An explicit value above what your plan allows returns a plan-limit error."
        ),
    },
    async ({ ticker, quarters }) => {
      const t = ticker.toUpperCase();
      const path = `/api/v1/stock-holders/${encodeURIComponent(t)}`;
      const explicit = quarters !== undefined;
      const asked = explicit ? quarters : config.apiKey ? DEFAULT_ACTIVITY_QUARTERS : undefined;

      let env: KoEnvelope<ActivityResponse>;
      let planNote: string | null = null;
      try {
        env = asEnvelope<ActivityResponse>(
          await koFetch<unknown>(config, path, { type: "activity", quarters: asked }, { envelope: true }),
        );
      } catch (e) {
        if (!explicit && e instanceof KoApiError && e.isPlanLimit && e.details?.param === "quarters") {
          env = asEnvelope<ActivityResponse>(
            await koFetch<unknown>(config, path, { type: "activity" }, { envelope: true }),
          );
          planNote = `Your ko.io plan allows fewer than the default ${DEFAULT_ACTIVITY_QUARTERS} quarters; returned the plan maximum.`;
        } else {
          throw e;
        }
      }
      const data = env.data;

      if (!data || !data.summary) {
        return {
          content: [
            {
              type: "text",
              text: `No institutional activity data found for ${t}. Check the ticker symbol (it may be invalid or have no 13F coverage).`,
            },
          ],
          structuredContent: {
            ticker: t, quarters_requested: asked ?? null, quarters_returned: 0, latest: null, trend: [],
            plan_note: null, plan_limit: planLimitOf(env.meta),
          },
        };
      }

      const trend = Array.isArray(data.trend) ? data.trend : [];
      if (!planNote && env.meta.softwall && asked === undefined) {
        planNote = "Free plan / keyless access: latest 13F quarter only; the multi-quarter trend requires Pro.";
      }

      const lines: string[] = [
        `## Institutional Activity — ${data.ticker}`,
        "",
        `**Latest Quarter (${data.summary.quarterDate}):**`,
        `- Institutions increased: ${data.summary.institutionsIncreased} | Decreased: ${data.summary.institutionsDecreased}`,
        `- New positions: ${data.summary.institutionsNew} | Exited: ${data.summary.institutionsExited}`,
        `- Net shares: ${fmtShares(num(data.summary.netShares))} | Net value: ${fmtMoney(num(data.summary.netValue))}`,
        "",
        "### Quarterly Trend\n",
        "| Quarter | Increased | Decreased | New | Exited | Net Shares | Net Value |",
        "|---------|-----------|-----------|-----|--------|------------|-----------|",
      ];

      for (const r of trend) {
        lines.push(
          `| ${r.quarter} | ${r.institutionsIncreased} | ${r.institutionsDecreased} | ${r.institutionsNew} | ${r.institutionsExited} | ${fmtShares(num(r.netShares))} | ${fmtMoney(num(r.netValue))} |`
        );
      }
      if (planNote) lines.push("", `*${planNote}*`);

      const row = (r: ActivityTrend) => ({
        quarter: r.quarter ?? null,
        institutions_increased: int(r.institutionsIncreased),
        institutions_decreased: int(r.institutionsDecreased),
        institutions_new: int(r.institutionsNew),
        institutions_exited: int(r.institutionsExited),
        net_shares: dec(r.netShares),
        net_value: dec(r.netValue),
      });
      const sm = data.summary;
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          ticker: data.ticker ?? t,
          quarters_requested: asked ?? null,
          quarters_returned: trend.length,
          latest: {
            ...row({ ...sm, quarter: sm.quarterDate }),
            institutions_total: int(sm.institutionsTotal),
            shares_added: dec(sm.sharesAdded),
            shares_removed: dec(sm.sharesRemoved),
            value_added: dec(sm.valueAdded),
            value_removed: dec(sm.valueRemoved),
          },
          trend: trend.map(row),
          plan_note: planNote,
          plan_limit: planLimitOf(env.meta),
        },
      };
    },
    { outputSchema: STOCK_ACTIVITY_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: get_stock_price
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_stock_price",
    "Get historical daily stock prices (OHLC). Returns a summary by default; set series=true to get the full daily price series (for backtesting / charting).",
    {
      ticker: z.string().max(200).describe("Stock ticker symbol"),
      period: z
        .enum(["1y", "3y", "5y", "10y"])
        .optional()
        .default("1y")
        .describe("Look-back window"),
      series: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, return the full daily OHLC series (up to `limit` rows) instead of just a summary."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(3000)
        .optional()
        .default(500)
        .describe("Max rows of the daily series to return when series=true."),
    },
    async ({ ticker, period, series, limit }) => {
      // REST /stock-price ignores period/aggregation; it scales coverage off `days`.
      // Map the look-back window to days so the summary (and series) actually cover it
      // instead of silently using the latest 50 rows.
      const daysByPeriod: Record<string, number> = { "1y": 365, "3y": 1095, "5y": 1825, "10y": 3650 };
      const days = daysByPeriod[period] ?? 365;
      const prices = await koFetch<PriceRow[]>(
        config,
        `/api/v1/stock-price/${encodeURIComponent(ticker.toUpperCase())}`,
        { days, per_page: Math.min(5000, Math.max(days, series ? limit : 0) || days) }
      );

      if (!prices || prices.length === 0) {
        return { content: [{ type: "text", text: `No price data found for ${ticker}.` }] };
      }

      // The API returns newest-first; sort defensively by date DESC so latest /
      // period-start / recent-prices never depend on the upstream row order.
      const desc = [...prices].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const latest = desc[0];
      const first = desc[desc.length - 1];
      const totalReturn = ((latest.close - first.close) / first.close) * 100;
      const high = Math.max(...desc.map((p) => p.close));
      const low = Math.min(...desc.map((p) => p.close));

      const lines: string[] = [
        `## ${ticker.toUpperCase()} Price — ${period}`,
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| **Latest** | $${latest.close.toFixed(2)} (${latest.date}) |`,
        `| **Period Start** | $${first.close.toFixed(2)} (${first.date}) |`,
        `| **Total Return** | ${fmtPct(totalReturn)} |`,
        `| **Period High** | $${high.toFixed(2)} |`,
        `| **Period Low** | $${low.toFixed(2)} |`,
        `| **Data Points** | ${prices.length} |`,
      ];

      // Full daily series (newest-first) for backtesting/charting, or the recent 10.
      const rows = series ? desc.slice(0, limit) : desc.slice(0, 10);
      lines.push("", series ? `### Daily Series (${rows.length} rows)\n` : "### Recent Prices\n");
      lines.push("| Date | Open | High | Low | Close | Volume |");
      lines.push("|------|------|------|-----|-------|--------|");
      for (const p of rows) {
        lines.push(`| ${p.date} | $${p.open?.toFixed(2) ?? "—"} | $${p.high?.toFixed(2) ?? "—"} | $${p.low?.toFixed(2) ?? "—"} | $${p.close.toFixed(2)} | ${fmtShares(p.volume)} |`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StockProfileResponse {
  stock: {
    ticker: string;
    sector: string | null;
    industry: string | null;
    market_cap: number | null;
    current_price: number | null;
    previous_close: number | null;
    fifty_two_week_high: number | null;
    fifty_two_week_low: number | null;
    beta: number | null;
    avg_volume: number | null;
    pe_ratio: number | null;
    eps: number | null;
    dividend_yield: number | null;
    profit_margins: number | null;
  };
  top_holders: TopHolder[];
}

interface TopHolder extends LegFields {
  name: string;
  shares_held: number;
  holding_value: number;
  portfolio_weight_pct: number | null;
}

interface HoldersResponse {
  data: HolderRow[];
  totalCount: number;
  page: number;
  per_page: number;
  totalPages: number;
  quarterDate: string;
}

// Int64/UInt64 columns arrive from ko-api as STRINGS (coerce with num()).
interface HolderRow extends LegFields {
  cik: string;
  name: string;
  slug: string;
  shares_held: number | string;
  holding_value: number | string;
  share_change: number | string;
  action: string;
  portfolio_weight_pct: number | null;
}

interface ActivityResponse {
  ticker: string;
  summary: ActivitySummary;
  trend: ActivityTrend[];
}

interface ActivitySummary {
  quarterDate: string;
  institutionsIncreased: number;
  institutionsDecreased: number;
  institutionsNew: number;
  institutionsExited: number;
  institutionsTotal: number;
  sharesAdded: number | string;
  sharesRemoved: number | string;
  netShares: number | string;
  valueAdded: number | string;
  valueRemoved: number | string;
  netValue: number | string;
}

interface ActivityTrend {
  quarter: string;
  institutionsIncreased: number;
  institutionsDecreased: number;
  institutionsNew: number;
  institutionsExited: number;
  netShares: number | string;
  netValue: number | string;
}

interface PriceRow {
  ticker: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}
