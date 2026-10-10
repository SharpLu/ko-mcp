/**
 * Metadata attached to every successful ko.io API response.
 * Pagination lives here; when a plan row-cap truncates a result the API sets
 * `truncated`, `showing`, `total_available` and `upgrade_hint`.
 */
export interface Meta {
  total_count?: number;
  page?: number;
  per_page?: number;
  query_time_ms?: number;
  truncated?: boolean;
  showing?: number;
  total_available?: number;
  upgrade_hint?: string;
  [key: string]: unknown;
}

/**
 * Normalized result returned by every SDK method.
 *
 * - `data` — the raw `data` field of the API envelope (array or object).
 * - `rows` — normalized row array, derived deterministically from `data`:
 *   (a) `data` is an array -> `data`;
 *   (b) `data.data` is an array -> `data.data` (e.g. `/stock-holders/:t`);
 *   (c) `data` is an object with exactly one array-valued property -> that
 *       array (e.g. `data.holders`, `data.trend`, `data.insiders`, `data.quarters`);
 *   (d) otherwise -> `[data]` (single-element array wrapping the payload).
 * - `truncated` — true when the plan row-cap truncated the result.
 */
export interface ApiResult<T = unknown> {
  data: T;
  meta: Meta;
  rows: unknown[];
  truncated: boolean;
}

/** Values accepted as query parameters; `undefined`/`null` entries are skipped. */
export type QueryValue = string | number | boolean | undefined | null;

/** Query parameter bag passed to {@link KoClient.get}. */
export type QueryParams = Record<string, QueryValue>;

/** Constructor options for {@link KoClient}. */
export interface KoClientOptions {
  /** ko.io API key (`ko_live_...`). Defaults to `process.env.KO_API_KEY`; omit for keyless demo mode. */
  apiKey?: string;
  /** Base URL override. Defaults to `https://api.ko.io` (or `process.env.KO_API_URL`). */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Max retries for network errors and 502/503/504 responses. Default 2. */
  maxRetries?: number;
  /** Custom fetch implementation (testing, polyfills). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface PageOptions {
  page?: number;
  perPage?: number;
}

export interface SearchOptions {
  limit?: number;
}

export interface InstitutionsListOptions extends PageOptions {
  search?: string;
  category?: string;
}

export interface HoldingsOptions extends PageOptions {
  quarter?: string;
  ticker?: string;
  action?: string;
  scope?: string;
  include?: string;
  tradesOnly?: boolean;
}

export interface StocksListOptions extends PageOptions {
  search?: string;
  sector?: string;
}

export interface StockPriceOptions extends PageOptions {
  days?: number;
  startDate?: string;
  endDate?: string;
}

export interface StockHoldersOptions extends PageOptions {
  quarter?: string;
  action?: string;
  type?: string;
  quarters?: number;
}

export interface StockActivityOptions {
  quarters?: number;
}

export interface InsiderTradesOptions extends PageOptions {
  ticker?: string;
  role?: string;
  period?: string;
}

export interface InsiderTransactionsOptions extends PageOptions {
  ticker?: string;
  signal?: string;
  side?: string;
}

export interface CongressTradesOptions extends PageOptions {
  ticker?: string;
  chamber?: string;
  search?: string;
  sort?: string;
}

export interface CryptoHoldersOptions extends PageOptions {
  product?: string;
}

export interface Form144ListOptions extends PageOptions {
  ticker?: string;
  cik?: string;
}

export interface FtdOptions extends PageOptions {
  ticker?: string;
  days?: number;
}

export interface RegShoOptions extends PageOptions {
  symbol?: string;
}

export interface TreasuryYieldsOptions {
  days?: number;
  from?: string;
  to?: string;
}

export interface FedRatesOptions {
  days?: number;
  series?: string;
}

export interface EconomicIndicatorsOptions extends PageOptions {
  category?: string;
  seriesId?: string;
  days?: number;
}

export interface FinancialStressOptions extends PageOptions {
  days?: number;
  seriesName?: string;
}

export interface FilingsListOptions {
  form?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface FilingShareOptions {
  file?: string;
}

/** Exactly the API's signed two-decimal USD string; never convert to Number for arithmetic. */
export type GovMoney = string;
export interface GovWindowOptions {
  period?: '1Q' | '2Q' | '1Y' | 'ALL'; fiscalYear?: number; from?: string; to?: string;
  agency?: string; subAgency?: string;
}
export interface GovTransactionsOptions extends GovWindowOptions, PageOptions {
  awardId?: string; awardType?: string; minAmount?: string; sort?: 'date' | 'amount' | '-amount';
}
export interface GovSearchOptions extends GovWindowOptions, PageOptions {
  ticker?: string; recipient?: string; naics?: string; awardType?: string; minAmount?: string;
  sort?: 'date' | 'amount' | '-amount'; facets?: 'agency';
}
export interface GovCompaniesOptions extends GovWindowOptions, PageOptions {
  ticker?: string; sort?: 'net' | 'gross' | 'actions';
}
export interface GovIdentity { ticker: string; cik: string; company_name: string; issuer_tickers: string[] }
export interface GovTotals { gross_obligated: GovMoney; deobligated: GovMoney; net_obligated: GovMoney; actions: number; awards: number; agencies: number }
export interface GovMonth extends Omit<GovTotals, 'agencies'> { month: string; provisional: boolean; window_clipped: boolean }
export interface GovSummary extends GovIdentity {
  totals: GovTotals; monthly: GovMonth[];
  agencies: { code: string; name: string; gross_obligated: GovMoney; net_obligated: GovMoney; actions: number; gross_share: number | null }[];
  link_tiers: { link_tier: 'A' | 'B'; actions: number }[];
}
export interface GovAction {
  transaction_id: string; award_id: string; piid: string; modification_number: string; action_date: string;
  obligated_amount: GovMoney; award_type: 'A' | 'B' | 'C' | 'D';
  agency: { code: string; name: string; sub_code: string; sub_name: string };
  recipient: { name: string; uei: string; parent_name: string; parent_uei: string };
  naics: { code: string; description: string }; psc: { code: string; description: string };
  place_of_performance: { country: string; state: string; city: string };
  description: string; link_tier: 'A' | 'B'; provisional: boolean; source_url: string;
}
export interface GovFeedAction extends GovAction { ticker: string | null; cik: string; company_name: string | null }
export interface GovCompany extends Omit<GovTotals, 'agencies'> { rank: number; ticker: string | null; cik: string; company_name: string | null }
export interface GovAward {
  award_id: string; piid: string; award_type: string; agency: GovAction['agency']; recipient: GovAction['recipient'];
  award_description: string; latest_action_date: string; attributed_actions: number | null; attributed_net_obligated: GovMoney | null;
  attributed_scope: 'issuer_attributed_since_fy2015'; requires_plan: string | null; source_url: string;
}
export interface GovMeta extends Meta {
  window_start: string; window_end: string; window_clamped: boolean; date_basis: 'action_date'; period: string | null;
  provisional_from: string; refreshed_at: string | null; caveats: string[];
}
export interface GovTransactionsMeta extends GovMeta {
  identity: GovIdentity; scope: 'company' | 'award'; award: GovAward | null;
  match_status: 'has_actions' | 'none_in_window' | 'no_attributed_actions';
}
export interface GovCoverage { month: string; transactions: number; matched_transactions: number; transaction_match_rate: number | null; matched_absolute_share: number | null; tier_a_absolute_share: number | null; tier_b_absolute_share: number | null; provisional: boolean }
