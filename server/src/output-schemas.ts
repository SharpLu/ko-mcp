/**
 * outputSchema declarations for the tools that return structuredContent.
 *
 * The rule these encode (MCP 2025-06-18 "structured content"): the Markdown in
 * `content` is for a reader, `structuredContent` is for a program. Quantities
 * and money are EXACT decimal strings -- the value ko-api sent, unrounded -- so
 * an agent can recompute a total without inheriting "58K" or "$5.85M". Small
 * counts (lines, pages) are JSON integers. Unknown is null, never 0.
 *
 * The SDK validates every successful result against these at runtime and turns
 * a mismatch into an error, so a schema here is a promise the handler keeps on
 * every non-error path (src/__tests__/structured.test.ts checks it offline).
 */
import { z } from "zod";

/** Exact decimal string ("474813.22", "105979600"), or null when unknown. */
const Dec = z
  .string()
  .regex(/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/)
  .nullable()
  .describe("Exact decimal string as served by ko.io (not rounded); null = unknown");

const Str = z.string().nullable();
const Int = z.number().int().nullable();

export const PAGING = z
  .object({
    page: z.number().int(),
    per_page: z.number().int(),
    returned: z.number().int(),
    total_count: Int.describe("Total rows matching the request, when ko.io reported it"),
    has_more: z.boolean().nullable().describe("null = a full page came back and more MAY exist"),
    next_page: Int.describe("Next page THIS caller can open; null when there is none (or sign-in is required)"),
    continuation: Str.describe("SIGNIN_REQUIRED = page>1 needs a (free) ko.io API key"),
    plan_row_cap: Int.describe("Row cap the caller's plan applied to this page, if any"),
    truncated_by_plan: z.boolean().describe("True when the plan's row cap withheld rows from this page"),
  })
  .describe("Paging state reconciled from ko.io meta.total_count and meta.softwall");

export const PLAN_LIMIT = z
  .object({
    policy_version: Str,
    window_start: Str,
    window_end: Str,
    effective_period: Str,
    date_basis: Str,
    row_cap: Int,
    truncated: z.boolean().nullable(),
    continuation: Str,
  })
  .nullable()
  .describe("The Free/keyless plan limits ko.io applied to this answer (null for paid callers)");

// ── get_insider_trades ──────────────────────────────────────────────────────
export const INSIDER_TRADES_OUTPUT = {
  ticker: z.string(),
  grain: z
    .enum(["insider_trade_date", "form4_transaction_line"])
    .describe("insider_trade_date = one row per insider per day, aggregating that day's Form 4 lines; form4_transaction_line = one row per line"),
  executive_cik: Str,
  period: Str,
  rows: z.array(
    z.object({
      trade_date: Str,
      person_cik: Str,
      person_name: Str,
      officer_title: Str.optional(),
      // form4_transaction_line grain
      transaction_code: Str.optional(),
      code_meaning: Str.optional(),
      open_market: z.boolean().optional().describe("true only for SEC codes P and S"),
      acquired_disposed: z.enum(["A", "D"]).nullable().optional(),
      security_title: Str.optional(),
      is_derivative: z.boolean().optional(),
      shares: Dec.optional(),
      price: Dec.optional(),
      value: Dec.optional(),
      // insider_trade_date grain
      form4_lines: Int.optional(),
      open_market_buy_lines: Int.optional(),
      open_market_sell_lines: Int.optional(),
      open_market_shares_bought: Dec.optional(),
      open_market_value_bought: Dec.optional(),
      open_market_shares_sold: Dec.optional(),
      open_market_value_sold: Dec.optional(),
      all_shares_acquired: Dec.optional(),
      all_value_acquired: Dec.optional(),
      all_shares_disposed: Dec.optional(),
      all_value_disposed: Dec.optional(),
      first_filed_date: Str.optional(),
      last_filed_date: Str.optional(),
      transaction_codes: z
        .array(z.string())
        .nullable()
        .optional()
        .describe("Distinct SEC Form 4 codes aggregated into this day (e.g. [\"F\",\"M\",\"S\"]); null = not reported by ko.io"),
      transaction_code_breakdown: z
        .array(
          z.object({
            code: Str,
            code_meaning: z.string(),
            acquired_disposed: z.enum(["A", "D"]),
            is_derivative: z.boolean(),
            lines: Int,
            shares: Dec,
            value: Dec,
          }),
        )
        .nullable()
        .optional()
        .describe("Per code x acquired/disposed x table: line count, shares, value (null = unknown, not partial)"),
      shares_owned_after: Dec,
    }),
  ),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

// ── get_institution_holdings ────────────────────────────────────────────────
export const INSTITUTION_HOLDINGS_OUTPUT = {
  requested: z.string().describe("The institution identifier the caller passed"),
  requested_cik: Str.describe("The CIK/slug the request was made for"),
  resolved_cik: Str.describe("The CIK ko.io answered for (the family's canonical CIK at family grain)"),
  entity_grain: z
    .enum(["filer", "family", "unknown"])
    .describe("filer = one 13F filer's own filing; family = consolidated across a manager family's filers"),
  family: z
    .object({ slug: Str, name: Str, canonical_cik: Str })
    .nullable()
    .describe("The manager family, when the answer is at family grain and ko.io named it"),
  security_grain: z
    .enum(["security", "issuer", "mixed"])
    .describe("security = one row per security/share class; issuer = share classes of one issuer merged; mixed = portfolio with some merged rows"),
  ticker_filter: Str,
  position_basis: Str.describe("What shares_held/holding_value count, when ko.io stated it (e.g. 13f_reported_all_legs)"),
  quarter_date: Str,
  rows: z.array(
    z.object({
      cik: Str,
      ticker: Str,
      issuer: Str,
      quarter_date: Str,
      shares_held: Dec,
      holding_value: Dec,
      portfolio_weight_pct: Dec,
      action: Str,
      share_change: Dec,
      security_grain: z.enum(["security", "issuer"]),
      tickers: z.array(z.string()).describe("Share-class tickers summed into this row (one entry at security grain)"),
      share_classes: z
        .array(z.object({ ticker: Str, shares_held: Dec, holding_value: Dec }))
        .describe("Per-class breakdown of an issuer-grain row; empty at security grain"),
      equity_shares: Dec,
      call_shares: Dec,
      put_shares: Dec,
      has_option_legs: z.boolean().nullable(),
      reported_by_members: Int,
    }),
  ),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

// ── get_stock_holders ───────────────────────────────────────────────────────
export const STOCK_HOLDERS_OUTPUT = {
  ticker: z.string(),
  quarter_date: Str,
  position_basis: Str,
  total_institutions: Int,
  rows: z.array(
    z.object({
      rank: z.number().int(),
      cik: Str,
      name: Str,
      shares_held: Dec,
      holding_value: Dec,
      portfolio_weight_pct: Dec,
      share_change: Dec,
      action: Str,
      equity_shares: Dec,
      call_shares: Dec,
      put_shares: Dec,
      has_option_legs: z.boolean().nullable(),
    }),
  ),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

// ── get_stock_activity ──────────────────────────────────────────────────────
const ACTIVITY_ROW = z.object({
  quarter: Str,
  institutions_increased: Int,
  institutions_decreased: Int,
  institutions_new: Int,
  institutions_exited: Int,
  net_shares: Dec,
  net_value: Dec,
});

export const STOCK_ACTIVITY_OUTPUT = {
  ticker: z.string(),
  quarters_requested: Int.describe("null = the plan default was used"),
  quarters_returned: z.number().int(),
  latest: ACTIVITY_ROW.extend({
    institutions_total: Int,
    shares_added: Dec,
    shares_removed: Dec,
    value_added: Dec,
    value_removed: Dec,
  }).nullable(),
  trend: z.array(ACTIVITY_ROW),
  plan_note: Str.describe("Set when the plan limited how many quarters were returned"),
  plan_limit: PLAN_LIMIT,
};

// ── get_stock_financials ────────────────────────────────────────────────────
export const STOCK_FINANCIALS_OUTPUT = {
  ticker: z.string(),
  period_type: z.enum(["quarterly", "annual"]),
  periods: z.array(
    z.object({
      period_end: Str,
      revenue: Dec,
      net_income: Dec,
      eps_basic: Dec,
      eps_diluted: Dec,
      gross_profit: Dec,
      operating_income: Dec,
      operating_cashflow: Dec,
      long_term_debt: Dec,
      short_term_debt: Dec,
      stockholders_equity: Dec,
    }),
  ),
  plan_note: Str.describe("Set when the caller's plan limited which periods were returned"),
  plan_limit: PLAN_LIMIT,
};

// ── get_ftd_data ────────────────────────────────────────────────────────────
export const FTD_OUTPUT = {
  ticker: z.string(),
  measure: z
    .literal("outstanding_fail_balance")
    .describe("Each quantity is the balance of fails outstanding on that settlement date -- not new fails that day; never sum across dates"),
  rows: z.array(
    z.object({
      settlement_date: Str,
      ticker: Str,
      quantity: Dec.describe("Outstanding fails-to-deliver balance (shares) on that settlement date"),
      price: Dec,
    }),
  ),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};
