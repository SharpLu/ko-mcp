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
 * - `rows` — normalized row array: `data` when it is an array, `data.data`
 *   when the endpoint double-nests (e.g. `/stock-holders/:t`), else `[]`.
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
  party?: string;
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

export interface FinancialStressOptions {
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
