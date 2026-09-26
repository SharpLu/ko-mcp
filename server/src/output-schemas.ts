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
      code_p_or_s: z.boolean().optional().describe("true for SEC codes P (purchase) and S (sale) -- open market OR private; the code does not distinguish"),
      acquired_disposed: z.enum(["A", "D"]).nullable().optional(),
      security_title: Str.optional(),
      is_derivative: z.boolean().optional(),
      shares: Dec.optional(),
      price: Dec.optional(),
      value: Dec.optional(),
      // insider_trade_date grain
      form4_lines: Int.optional(),
      ps_buy_lines: Int.optional().describe("Code P lines that day (open market or private purchases)"),
      ps_sell_lines: Int.optional().describe("Code S lines that day (open market or private sales)"),
      ps_buy_unpriced_lines: Int.optional().describe("Code P lines with no dollar value; > 0 means ps_value_bought is partial"),
      ps_sell_unpriced_lines: Int.optional().describe("Code S lines with no dollar value; > 0 means ps_value_sold is partial"),
      ps_shares_bought: Dec.optional().describe("null = unknown (a line had no share count)"),
      ps_value_bought: Dec.optional().describe("Dollar total of PRICED code P lines only"),
      ps_value_bought_complete: z.boolean().nullable().optional().describe("false = some code P lines unpriced; null = not reported"),
      ps_shares_sold: Dec.optional(),
      ps_value_sold: Dec.optional().describe("Dollar total of PRICED code S lines only"),
      ps_value_sold_complete: z.boolean().nullable().optional(),
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
  view: z
    .enum(["snapshot", "history"])
    .describe("snapshot = one quarter's holdings; history = one position across quarters (family + ticker), one row per quarter, newest first"),
  quarters: z.array(z.string()).describe("Distinct quarter-ends present in rows, newest first"),
  quarter_date: Str.describe("The snapshot's quarter; null for a history (each row carries its own quarter_date)"),
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
  position_basis_note: Str,
  entity_grain: z
    .enum(["filer", "family"])
    .nullable()
    .describe("filer = each row is one 13F filer CIK (not consolidated into manager families); null = ko.io did not state it"),
  requested_cik: Str,
  family: z.object({ slug: Str, name: Str, canonical_cik: Str }).nullable(),
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
      family: z.object({ slug: Str, name: Str, canonical_cik: Str }).nullable().describe("The manager family this holder belongs to, when ko.io attributes it"),
      reported_by_members: Int,
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

// ────────────────────────────────────────────────────────────────────────────
// The other 18 tools (final-eval R1 #7): every tool that returns data returns
// structuredContent, on its empty-success path too. Identifiers / dates /
// labels are strings, quantities and money exact decimal strings, small counts
// integers; null = not reported.
// ────────────────────────────────────────────────────────────────────────────

const Bool = z.boolean().nullable();

export const LIST_INSTITUTIONS_OUTPUT = {
  search: Str,
  rows: z.array(z.object({
    cik: Str, name: Str, slug: Str, rank: Int, category: Str,
    portfolio_value: Dec, stock_count: Int,
  })),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

export const STOCK_PROFILE_OUTPUT = {
  ticker: z.string(),
  stock: z.object({
    sector: Str, industry: Str, market_cap: Dec, current_price: Dec, price_date: Str, previous_close: Dec,
    fifty_two_week_high: Dec, fifty_two_week_low: Dec, pe_ratio: Dec, eps: Dec, beta: Dec,
    dividend_yield_pct: Dec, profit_margins: Dec, avg_volume: Dec,
  }),
  position_basis: Str,
  top_holders: z.array(z.object({
    cik: Str, name: Str, shares_held: Dec, holding_value: Dec, portfolio_weight_pct: Dec,
    equity_shares: Dec, call_shares: Dec, put_shares: Dec, has_option_legs: Bool,
  })),
};

const OHLCV = z.object({ date: Str, open: Dec, high: Dec, low: Dec, close: Dec, volume: Dec });
export const STOCK_PRICE_OUTPUT = {
  ticker: z.string(),
  period: z.string(),
  days_requested: z.number().int(),
  rows_returned: z.number().int(),
  latest: z.object({ date: Str, close: Dec }).nullable(),
  period_start: z.object({ date: Str, close: Dec }).nullable(),
  total_return_pct: Dec.describe("(latest close - period-start close) / period-start close x 100, from the returned rows"),
  period_high_close: Dec,
  period_low_close: Dec,
  rows: z.array(OHLCV).describe("The rows rendered: the full series (series=true, up to limit) or the latest 10"),
  plan_limit: PLAN_LIMIT,
};

export const INSIDER_TRADERS_OUTPUT = {
  search: Str,
  role: z.string(),
  grain: z.literal("insider_trade_date"),
  rows: z.array(z.object({
    ticker: Str, company_name: Str, person_cik: Str, person_name: Str, officer_title: Str, trade_date: Str,
    form4_lines: Int,
    ps_value_bought: Dec.describe("Code P lines (open-market or private purchase), priced lines only"),
    ps_value_sold: Dec.describe("Code S lines (open-market or private sale), priced lines only"),
    all_value_acquired: Dec, all_value_disposed: Dec, shares_owned_after: Dec,
  })),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

const CONGRESS_ROW = z.object({
  member_name: Str, chamber: Str, ticker: Str, asset_description: Str, transaction_type: Str,
  transaction_date: Str, disclosure_date: Str,
  amount_range: Str.describe("The disclosed dollar RANGE (STOCK Act bands), not an exact amount"),
  owner: Str,
});
export const CONGRESS_TRADES_OUTPUT = {
  filters: z.object({ chamber: Str, ticker: Str, search: Str, sort: Str }),
  rows: z.array(CONGRESS_ROW),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};
export const CONGRESS_MEMBER_OUTPUT = {
  member: z.string(),
  rows: z.array(CONGRESS_ROW),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

export const SEARCH_OUTPUT = {
  query: z.string(),
  institutions: z.array(z.object({
    cik: Str, name: Str, slug: Str, category: Str, aum: Dec, rank: Int,
    matched_person: z.object({ name: Str, role: Str }).nullable(),
  })),
  stocks: z.array(z.object({ ticker: Str, name: Str, sector: Str, industry: Str, market_cap: Dec })),
  insiders: z.array(z.object({ name: Str, ticker: Str, type: Str })),
  congress: z.array(z.object({ name: Str, type: Str })),
};

export const FORM144_OUTPUT = {
  filters: z.object({ ticker: Str, insider_cik: Str }),
  rows: z.array(z.object({
    accession_no: Str, filed_date: Str, issuer_ticker: Str, issuer_name: Str, issuer_cik: Str, seller_name: Str,
    relationship: Str, securities_class: Str,
    units_to_sell: Dec.describe("Units the filer NOTIFIED an intent to sell -- not a completed sale"),
    aggregate_market_value: Dec, approx_sale_date: Str, broker_name: Str, has_10b5_1_plan: Bool,
  })),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

export const FILINGS_LIST_OUTPUT = {
  cik: z.string(),
  filters: z.object({ form_type: Str, from: Str, to: Str }),
  rows: z.array(z.object({ filing_date: Str, form: Str, accession: Str, primary_document: Str, description: Str })),
};

export const FILING_INDEX_OUTPUT = {
  cik: Str,
  accession: Str,
  files: z.array(z.object({ name: Str, type: Str, size_bytes: Int, last_modified: Str })),
};

export const FILING_DOCUMENT_OUTPUT = {
  cik: z.string(),
  accession_no: z.string(),
  file: Str,
  link: z.object({
    url: z.string(),
    signed: z.boolean().describe("true = ko.io-signed, expiring link a browser can open; false = needs a paid API key"),
    expires_at: Str,
  }),
  excerpt: z.object({
    status: z.enum(["ok", "unavailable", "not_requested"]),
    text: Str,
    chars_total: Int,
    truncated: z.boolean().nullable(),
  }),
};

export const TREASURY_YIELDS_OUTPUT = {
  unit: z.literal("percent"),
  rows: z.array(z.object({
    date: Str, m1: Dec, m3: Dec, m6: Dec, y1: Dec, y2: Dec, y5: Dec, y10: Dec, y30: Dec,
  })),
};

export const FED_RATES_OUTPUT = {
  unit: z.literal("percent"),
  rows: z.array(z.object({
    date: Str, fed_funds_rate: Dec, sofr: Dec, prime_rate: Dec, treasury_3m: Dec, treasury_2y: Dec,
    treasury_10y: Dec, treasury_30y: Dec,
  })),
};

export const ECONOMIC_OUTPUT = {
  category: z.string(),
  rows: z.array(z.object({ date: Str, series_id: Str, series_name: Str, value: Dec, category: Str })),
  paging: PAGING,
};

export const STRESS_OUTPUT = {
  rows: z.array(z.object({ date: Str, series: Str, value: Dec })),
  paging: PAGING,
};

export const CRYPTO_EXPOSURE_OUTPUT = {
  complex: z.object({ total_usd: Dec, qoq_change: Dec, products: Int }),
  products: z.array(z.object({
    product_ticker: Str, product_name: Str, sponsor: Str, holders: Int, total_usd: Dec, prev_usd: Dec, qoq_change: Dec,
  })),
};

export const CRYPTO_HOLDERS_OUTPUT = {
  product: Str,
  total_holders: Int,
  rows: z.array(z.object({
    rank: Int, cik: Str, name: Str, total_usd: Dec, prev_usd: Dec, qoq_value_change: Dec, product_count: Int,
    products: z.array(z.string()),
  })),
  paging: PAGING,
  plan_limit: PLAN_LIMIT,
};

export const CRYPTO_HOLDER_OUTPUT = {
  requested: z.string(),
  cik: Str,
  institution: z.object({
    name: Str, latest_quarter: Str, total_usd: Dec, qoq_change: Dec, rank: Int, total_holders: Int,
    portfolio_weight_pct: Dec,
  }).nullable(),
  positions: z.array(z.object({
    product_ticker: Str, product_name: Str, shares_held: Dec, usd_value: Dec, qoq_value_change: Dec, action: Str,
  })),
  plan_limit: PLAN_LIMIT,
};
