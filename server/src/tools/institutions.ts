import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool } from "../tool-def.js";
import { koFetch, asEnvelope, type KoConfig, type KoMeta } from "../ko-fetch.js";
import { resolveInstitution } from "../resolve.js";
import { fmtMoney, fmtShares, fmtPct2, num } from "../format.js";
import { pagingOf, pagingLines, windowLine, planLimitOf, dec, int, str, fmtIntExact } from "../paging.js";
import { INSTITUTION_HOLDINGS_OUTPUT, LIST_INSTITUTIONS_OUTPUT } from "../output-schemas.js";

interface FamilyRef { slug: string | null; name: string | null; canonical_cik: string | null }

/** meta.family (SPEC C2) when ko-api sends it. */
function familyOf(meta: KoMeta): FamilyRef | null {
  const f = meta.family as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object") return null;
  const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
  return { slug: s(f.slug), name: s(f.name), canonical_cik: s(f.canonical_cik) };
}

function entityLine(
  grain: "filer" | "family" | "unknown",
  requested: string,
  resolvedCik: string | null,
  family: FamilyRef | null,
  ciks: string[],
): string {
  if (grain === "family") {
    const fam = family?.name ? ` ${family.name}${family.slug ? ` (${family.slug})` : ""}` : "";
    const answered = resolvedCik && resolvedCik !== requested ? `, answered for canonical CIK ${resolvedCik}` : "";
    const filers = ciks.length > 1 ? `; rows come from ${ciks.length} filer CIKs` : "";
    return (
      `**Entity grain:** family --${fam} consolidated across its 13F filers (requested ${requested}${answered}${filers}). ` +
      "Pass entity='filer' for only the requested CIK's own 13F."
    );
  }
  if (grain === "filer") return `**Entity grain:** filer -- the 13F of CIK ${resolvedCik ?? requested} only.`;
  return `**Entity grain:** unknown (no rows to attribute; requested ${requested}).`;
}

/** Per-class legs of a row: the new `share_classes[]`, or none. */
function classesOf(h: HoldingRow): Array<{ ticker: string | null; shares_held: unknown; holding_value: unknown }> {
  return Array.isArray(h.share_classes) ? h.share_classes : [];
}

function optionFlag(h: HoldingRow): boolean | null {
  if (h.has_option_legs !== undefined && h.has_option_legs !== null) return Boolean(num(h.has_option_legs));
  if (h.call_shares !== undefined || h.put_shares !== undefined) return num(h.call_shares) + num(h.put_shares) > 0;
  if (h.is_option !== undefined && h.is_option !== null) return Boolean(num(h.is_option));
  return null;
}

function legNote(label: string, h: HoldingRow): string {
  const parts: string[] = [];
  if (dec(h.equity_shares) !== null) parts.push(`${fmtIntExact(h.equity_shares)} common`);
  if (num(h.call_shares)) parts.push(`${fmtIntExact(h.call_shares)} via calls`);
  if (num(h.put_shares)) parts.push(`${fmtIntExact(h.put_shares)} via puts`);
  const legs = parts.length ? parts.join(" + ") : "includes option legs (breakdown not reported)";
  return `(opt) ${label}: ${legs}; 13F reports option lines at the underlying's value.`;
}

function emptyHoldings(requested: string, target: string | null, ticker: string | undefined) {
  return {
    requested,
    requested_cik: target,
    resolved_cik: null,
    entity_grain: "unknown" as const,
    family: null,
    security_grain: "security" as const,
    ticker_filter: ticker ? ticker.toUpperCase() : null,
    position_basis: null,
    view: "snapshot" as const,
    quarters: [],
    quarter_date: null,
    rows: [],
    paging: { page: 1, per_page: 0, returned: 0, total_count: 0, has_more: false, next_page: null,
      continuation: null, plan_row_cap: null, truncated_by_plan: false },
    plan_limit: null,
  };
}

export function registerInstitutionTools(server: McpServer, config: KoConfig) {
  // ---------------------------------------------------------------------------
  // Tool: get_institution_holdings
  //
  // GRAIN (final-eval 2026-09-26, EVAL_CODEX_TECH #1, SPEC R1/R2 C1-C3). Two
  // grains used to be invisible here:
  //   ENTITY   /holdings/:cik folds a filer into its manager family by default
  //            and answers with the family's canonical CIK (asked 1446194,
  //            answered 918950) without saying so.
  //   SECURITY the default portfolio merges an issuer's share classes into one
  //            row labelled with ONE class ticker: Berkshire's "GOOG 105.98M sh
  //            / $37.76B" is GOOGL 78,791,167 + GOOG 27,188,433. The tool
  //            dropped `share_classes`, so an issuer total read as a security.
  // Both are now stated on every answer, per row where they vary. A `ticker`
  // filter asks ko-api for the security grain (raw_share_classes=true: the
  // exact per-class rows), so "how much GOOG" is GOOG and not Alphabet.
  //
  // ko-api is adding explicit grain fields (SPEC C1-C3: meta.entity_grain,
  // requested_cik, family{}, security_grain, tickers[], share_classes[],
  // equity_shares/call_shares/put_shares/has_option_legs, position_basis).
  // They are used when present; until they ship the same facts are derived
  // from what ko-api sends today (meta.is_family, row.cik, row.share_classes,
  // meta.consolidated_share_classes, row.call_shares/put_shares).
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "get_institution_holdings",
    "Get current stock holdings of an institutional investor (hedge fund, mutual fund, pension fund) from their latest SEC 13F filing. Returns top positions with share counts, values, and quarter-over-quarter changes. " +
      "Every answer states its grain: ENTITY (a CIK that belongs to a manager family is answered for the whole family " +
      "by default -- pass entity='filer' for that one filer's own 13F) and SECURITY (the default portfolio merges an " +
      "issuer's share classes into one row, e.g. GOOG+GOOGL, and lists the per-class breakdown; pass `ticker` to get " +
      "only that security). Shares and value are the 13F-reported totals over all legs; option legs are flagged. " +
      "structuredContent carries exact shares/values and the grain fields.",
    {
      institution: z
        .string()
        .max(200)
        .describe(
          "Institution CIK number (e.g. '1067983'), slug (e.g. 'berkshire-hathaway'), or name (e.g. 'Berkshire Hathaway') — names are resolved automatically."
        ),
      ticker: z
        .string()
        .max(20)
        .optional()
        .describe(
          "Only this security (e.g. 'GOOG'). Returns the security grain: GOOG is Class C only, not the Alphabet issuer total."
        ),
      entity: z
        .enum(["family", "filer"])
        .optional()
        .default("family")
        .describe(
          "family (default): consolidate every 13F filer in the manager family; filer: only the requested CIK's own filing."
        ),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(100).optional().default(50).describe("Results per page"),
    },
    async ({ institution, ticker, entity, page, limit }) => {
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
          structuredContent: emptyHoldings(institution, null, ticker),
        };
      }

      const tickerFilter = ticker ? ticker.trim().toUpperCase() : undefined;
      const env = asEnvelope<HoldingRow[]>(
        await koFetch<unknown>(
          config,
          `/api/v1/holdings/${encodeURIComponent(resolved.target)}`,
          {
            ticker: tickerFilter,
            // Security grain for a ticker query: the exact per-class rows.
            raw_share_classes: tickerFilter ? "true" : undefined,
            single_entity: entity === "filer" ? "true" : undefined,
            page,
            per_page: limit,
          },
          { envelope: true },
        ),
      );
      const holdings = Array.isArray(env.data) ? env.data : [];
      const meta = env.meta;
      const paging = pagingOf(meta, { page, limit, returned: holdings.length });

      // ── entity grain ──
      const ciks = [...new Set(holdings.map((h) => String(h.cik ?? "")).filter(Boolean))];
      const family = familyOf(meta);
      const requestedCik = typeof meta.requested_cik === "string" ? meta.requested_cik : resolved.target;
      let entityGrain: "filer" | "family" | "unknown";
      if (meta.entity_grain === "filer" || meta.entity_grain === "family") entityGrain = meta.entity_grain;
      else if (meta.is_family === true) entityGrain = "family";
      else if (entity === "filer") entityGrain = "filer";
      else if (ciks.length > 1 || (ciks.length === 1 && /^\d+$/.test(requestedCik) && Number(ciks[0]) !== Number(requestedCik))) entityGrain = "family";
      else if (ciks.length === 1) entityGrain = "filer";
      else entityGrain = "unknown";
      const resolvedCik = family?.canonical_cik ?? (ciks.length === 1 ? ciks[0] : null);
      // Family rows before ko-api's SPEC C1 build carry call_shares/put_shares
      // of "0" that nobody measured (the family mart holds only the all-legs
      // total). Treat legs as unknown there until has_option_legs is sent.
      const legsKnown = (h: HoldingRow) => entityGrain !== "family" || h.has_option_legs !== undefined;
      const legFlag = (h: HoldingRow) => (legsKnown(h) ? optionFlag(h) : null);

      // ── security grain ──
      const rowGrain = (h: HoldingRow): "security" | "issuer" => {
        if (h.security_grain === "security" || h.security_grain === "issuer") return h.security_grain;
        return classesOf(h).length > 1 ? "issuer" : "security";
      };
      const grains = new Set(holdings.map(rowGrain));
      const securityGrain: "security" | "issuer" | "mixed" =
        typeof meta.security_grain === "string" && ["security", "issuer"].includes(meta.security_grain)
          ? (meta.security_grain as "security" | "issuer")
          : grains.has("issuer") ? (grains.size > 1 ? "mixed" : "issuer") : "security";
      const basis = typeof meta.position_basis === "string" ? meta.position_basis : null;

      const lines: string[] = [];
      if (resolved.note) lines.push(resolved.note);
      // SNAPSHOT vs HISTORY (final-eval R1 #4). ko-api's family + ticker branch
      // returns the family's position in that ticker ONE ROW PER QUARTER (for a
      // paid caller: the whole history; for Free: from the settled quarter on).
      // Titling that "Quarter: <first row>" presented March and June positions
      // as one current portfolio. The view is decided by the REQUEST, not by the
      // rows on this page: family + ticker is ko-api's history branch, so page 2
      // (older quarters only) or a one-row page is still a history. Rows from
      // more than one quarter are a history whatever the request looked like.
      const quarters = [...new Set(holdings.map((h) => String(h.quarter_date ?? "")).filter(Boolean))];
      const historyRequest = Boolean(tickerFilter) && entityGrain === "family";
      const isHistory = historyRequest || quarters.length > 1;
      const qtr = holdings.length > 0 ? holdings[0].quarter_date : "Unknown";
      if (isHistory) {
        const span = quarters.length
          ? ` — ${quarters.length} quarter${quarters.length === 1 ? "" : "s"} on this page (${quarters[quarters.length - 1]} to ${quarters[0]})`
          : "";
        lines.push(`## 13F Position History${tickerFilter ? ` — ${tickerFilter}` : ""}${span}`);
        // No claim about which row is "current": this may be page 2, and the
        // newest row on it is then an older quarter.
        lines.push(
          "*HISTORY, not a current portfolio: one row per quarter-end, newest first. Each row is the position AS OF " +
            "its Quarter.*",
        );
      } else {
        lines.push(`## 13F Holdings — Quarter: ${qtr}`);
      }
      lines.push(`**${isHistory ? "Quarters" : "Positions"} shown:** ${holdings.length}${paging.total_count !== null ? ` of ${paging.total_count.toLocaleString("en-US")}` : ""}`);
      lines.push(entityLine(entityGrain, requestedCik, resolvedCik, family, ciks));
      lines.push(
        tickerFilter
          ? `**Security grain:** security -- only ${tickerFilter}; other share classes of the same issuer are not included.`
          : securityGrain === "security"
            ? "**Security grain:** security (one row per security)."
            : "**Security grain:** rows marked † merge several share classes of one issuer (issuer total); the per-class breakdown is listed under the table.",
      );
      const w = windowLine(meta);
      if (w) lines.push(w);
      lines.push("");

      if (holdings.length > 0) {
        const multiFiler = ciks.length > 1;
        lines.push(`| # |${isHistory ? " Quarter |" : ""}${multiFiler ? " Filer CIK |" : ""} Ticker | Issuer | Value | Shares | Weight | Change | Action |`);
        lines.push(`|---|${isHistory ? "---------|" : ""}${multiFiler ? "-----------|" : ""}--------|--------|-------|--------|--------|--------|--------|`);

        const notes: string[] = [];
        for (const [i, h] of holdings.entries()) {
          const n = (page - 1) * limit + i + 1;
          const change = num(h.share_change);
          const changeStr = change ? `${change > 0 ? "+" : ""}${fmtShares(change)}` : "—";
          const merged = rowGrain(h) === "issuer";
          const legs = legFlag(h) === true;
          const mark = `${merged ? "†" : ""}${legs ? " (opt)" : ""}`;
          if (merged) {
            notes.push(
              `† ${h.ticker || "N/A"} = issuer total of ${classesOf(h).map((c) => `${c.ticker} ${fmtIntExact(c.shares_held)} sh / ${fmtMoney(dec(c.holding_value))}`).join(" + ")}`,
            );
          }
          if (legs) notes.push(legNote(h.ticker || h.name_of_issuer, h));
          lines.push(
            `| ${n} |${isHistory ? ` ${h.quarter_date} |` : ""}${multiFiler ? ` ${h.cik} |` : ""} **${h.ticker || "N/A"}**${mark} | ${h.name_of_issuer} | ${fmtMoney(h.holding_value)} | ${fmtShares(h.shares_held)} | ${fmtPct2(h.portfolio_weight_pct)}% | ${changeStr} | ${h.action} |`
          );
        }
        if (notes.length) lines.push("", ...notes.map((x) => `*${x}*`));
        lines.push(...pagingLines(paging));
      } else {
        lines.push("No holdings found.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          requested: institution,
          requested_cik: requestedCik,
          resolved_cik: resolvedCik,
          entity_grain: entityGrain,
          family,
          security_grain: tickerFilter ? "security" : securityGrain,
          ticker_filter: tickerFilter ?? null,
          position_basis: basis,
          view: isHistory ? "history" : "snapshot",
          quarters,
          quarter_date: isHistory ? null : holdings[0]?.quarter_date ?? null,
          rows: holdings.map((h) => {
            const classes = classesOf(h);
            return {
              cik: h.cik != null ? String(h.cik) : null,
              ticker: h.ticker ?? null,
              issuer: h.name_of_issuer ?? null,
              quarter_date: h.quarter_date ?? null,
              shares_held: dec(h.shares_held),
              holding_value: dec(h.holding_value),
              portfolio_weight_pct: dec(h.portfolio_weight_pct),
              action: h.action ?? null,
              share_change: dec(h.share_change),
              security_grain: rowGrain(h),
              tickers: Array.isArray(h.tickers) && h.tickers.length
                ? h.tickers.map(String)
                : classes.length > 1 ? classes.map((c) => String(c.ticker)) : h.ticker ? [h.ticker] : [],
              share_classes: classes.length > 1
                ? classes.map((c) => ({ ticker: c.ticker ?? null, shares_held: dec(c.shares_held), holding_value: dec(c.holding_value) }))
                : [],
              equity_shares: legsKnown(h) ? dec(h.equity_shares) : null,
              call_shares: legsKnown(h) ? dec(h.call_shares) : null,
              put_shares: legsKnown(h) ? dec(h.put_shares) : null,
              has_option_legs: legFlag(h),
              reported_by_members: int(h.reported_by_members),
            };
          }),
          paging,
          plan_limit: planLimitOf(meta),
        },
      };
    },
    { outputSchema: INSTITUTION_HOLDINGS_OUTPUT },
  );

  // ---------------------------------------------------------------------------
  // Tool: list_institutions
  // ---------------------------------------------------------------------------
  defineTool(server, 
    "list_institutions",
    "List top institutional investors (hedge funds, mutual funds, etc.) tracked in the SEC 13F database. Supports search by name and pagination.",
    {
      search: z.string().max(200).optional().describe("Search by institution name, CIK, or manager name (e.g. 'Klarman' -> Baupost)"),
      page: z.number().int().min(1).optional().default(1).describe("Page number"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Results per page"),
    },
    async ({ search, page, limit }) => {
      // koFetch returns the array directly.
      // PAGE SIZE IS `per_page`, NOT `limit` (ko-bastion#126): /api/v1/institutions
      // reads only `per_page` and silently falls back to its own 50-row default
      // for anything else, so sending `limit` here rendered 50 rows however small
      // a page the caller asked for. get_institution_holdings above is the pattern.
      const env = asEnvelope<InstitutionRow[]>(
        await koFetch<unknown>(config, "/api/v1/institutions", { search, page, per_page: limit }, { envelope: true }),
      );
      const institutions = Array.isArray(env.data) ? env.data : [];

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

      if (env.meta.softwall || env.meta.total_count !== undefined) {
        lines.push(...pagingLines(pagingOf(env.meta, { page, limit, returned: institutions.length })));
      } else if (institutions.length === limit) {
        lines.push(`\n*More results available — use page=${page + 1}*`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          search: str(search),
          rows: institutions.map((inst) => ({
            cik: str(inst.cik), name: str(inst.name), slug: str(inst.slug), rank: int(inst.rank), category: str(inst.category),
            portfolio_value: dec(inst.portfolio_value), stock_count: int(inst.stock_count),
          })),
          paging: pagingOf(env.meta, { page, limit, returned: institutions.length }),
          plan_limit: planLimitOf(env.meta),
        },
      };
    },
    { outputSchema: LIST_INSTITUTIONS_OUTPUT },
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
// Int64/UInt64 columns arrive from ko-api as STRINGS.
interface HoldingRow {
  cik: string;
  quarter_date: string;
  ticker: string | null;
  name_of_issuer: string;
  shares_held: number | string;
  holding_value: number | string;
  total_portfolio_value: number | string;
  portfolio_weight_pct: number | null;
  action: string;
  share_change: number | string;
  prev_shares: number | string;
  prev_value: number | string;
  is_option: number | boolean | null;
  call_shares?: number | string | null;
  put_shares?: number | string | null;
  /** Consolidated (issuer-grain) rows: the classes summed into this row. */
  share_classes?: Array<{ ticker: string | null; shares_held: number | string; holding_value: number | string }>;
  // SPEC C1-C3 fields (ko-api, additive; absent on older builds)
  equity_shares?: number | string | null;
  has_option_legs?: number | boolean | null;
  security_grain?: string;
  tickers?: string[];
  reported_by_members?: number | string | null;
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
