import { errorFromResponse, KoError } from "./errors.js";
import type {
  ApiResult,
  CongressTradesOptions,
  CryptoHoldersOptions,
  EconomicIndicatorsOptions,
  FedRatesOptions,
  FilingShareOptions,
  FilingsListOptions,
  FinancialStressOptions,
  Form144ListOptions,
  FtdOptions,
  HoldingsOptions,
  InsiderTradesOptions,
  InsiderTransactionsOptions,
  InstitutionsListOptions,
  KoClientOptions,
  Meta,
  PageOptions,
  QueryParams,
  RegShoOptions,
  SearchOptions,
  StockActivityOptions,
  StockHoldersOptions,
  StockPriceOptions,
  StocksListOptions,
  TreasuryYieldsOptions,
} from "./types.js";
import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.ko.io";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function envVar(name: string): string | undefined {
  // Guard: process is undefined in browsers / edge workers.
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Uppercase + URL-encode a ticker path segment. */
function tick(ticker: string): string {
  return encodeURIComponent(ticker.toUpperCase());
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function normalizeRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === "object") {
    const inner = (data as { data?: unknown }).data;
    if (Array.isArray(inner)) return inner;
  }
  return [];
}

/**
 * Typed client for the ko.io financial data API.
 *
 * Zero runtime dependencies; works in Node 18+, browsers and edge workers.
 *
 * @example
 * ```ts
 * import { KoClient } from "@ko-io/sdk";
 *
 * const ko = new KoClient(); // uses KO_API_KEY env var, else demo mode
 * const { rows } = await ko.institutions.list({ search: "berkshire" });
 * ```
 */
export class KoClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KoClientOptions = {}) {
    this.apiKey = options.apiKey ?? envVar("KO_API_KEY");
    this.baseUrl = (options.baseUrl ?? envVar("KO_API_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    // Bind to globalThis: calling an unbound `fetch` throws "Illegal invocation" in browsers.
    this.fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis);
  }

  /**
   * Escape hatch: GET any ko.io API path with raw query parameters.
   * Handles auth, demo mode, retries, timeout and envelope parsing.
   *
   * @example
   * ```ts
   * const res = await ko.get("/api/v1/institutions", { search: "bridgewater", per_page: 5 });
   * console.log(res.rows.length, res.meta.total_count);
   * ```
   */
  async get<T = unknown>(path: string, params?: QueryParams): Promise<ApiResult<T>> {
    const url = this.buildUrl(path, params);
    const response = await this.requestWithRetry(url);
    if (!response.ok) throw await errorFromResponse(response);

    let body: { data: T; meta?: Meta };
    try {
      body = (await response.json()) as { data: T; meta?: Meta };
    } catch {
      throw new KoError("ko.io API returned a non-JSON success body", {
        status: response.status,
        code: "INVALID_RESPONSE",
      });
    }

    const meta: Meta = body.meta ?? {};
    return {
      data: body.data,
      meta,
      rows: normalizeRows(body.data),
      truncated: meta.truncated === true,
    };
  }

  private buildUrl(path: string, params?: QueryParams): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    if (!this.apiKey) url.searchParams.set("demo", "true");
    return url.toString();
  }

  private async requestWithRetry(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.doFetch(url);
        if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        return response;
      } catch (err) {
        if (err instanceof KoError) throw err;
        if (isAbortError(err)) {
          throw new KoError(`Request timed out after ${this.timeoutMs}ms`, {
            status: 0,
            code: "TIMEOUT",
          });
        }
        if (attempt < this.maxRetries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new KoError(`Network error calling ko.io API: ${message}`, {
          status: 0,
          code: "NETWORK_ERROR",
        });
      }
    }
  }

  private async doFetch(url: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      // User-Agent is forbidden in browsers; a custom header is safe everywhere.
      "X-Ko-Client": `ko-sdk-js/${VERSION}`,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      return await this.fetchImpl(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Full-text search across institutions, stocks, insiders and congress members.
   *
   * @example
   * ```ts
   * const { rows } = await ko.search("nvidia", { limit: 5 });
   * ```
   */
  search<T = unknown>(query: string, options: SearchOptions = {}): Promise<ApiResult<T>> {
    return this.get<T>("/api/v1/search", { q: query, limit: options.limit });
  }

  /** 13F institutional managers. */
  readonly institutions = {
    /**
     * List 13F institutions, filterable by name search and category.
     *
     * @example
     * ```ts
     * const { rows } = await ko.institutions.list({ search: "bridgewater", perPage: 10 });
     * ```
     */
    list: <T = unknown>(options: InstitutionsListOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/institutions", {
        search: options.search,
        category: options.category,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Institution profile by CIK.
     *
     * @example
     * ```ts
     * const { data } = await ko.institutions.get("1067983"); // Berkshire Hathaway
     * ```
     */
    get: <T = unknown>(cik: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/institutions/${seg(cik)}`),

    /**
     * 13F holdings for an institution. Defaults to the latest quarter.
     *
     * @example
     * ```ts
     * const { rows } = await ko.institutions.holdings("1067983", { ticker: "AAPL", scope: "all" });
     * ```
     */
    holdings: <T = unknown>(cik: string, options: HoldingsOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/holdings/${seg(cik)}`, {
        quarter: options.quarter,
        ticker: options.ticker,
        action: options.action,
        scope: options.scope,
        page: options.page,
        per_page: options.perPage,
        include: options.include,
        trades_only: options.tradesOnly,
      }),

    /**
     * Available filing quarters for an institution.
     * Returns an object `{ quarters: [...], latest_quarter }` in `data` (rows is empty).
     *
     * @example
     * ```ts
     * const { data } = await ko.institutions.quarters("1067983");
     * ```
     */
    quarters: <T = unknown>(cik: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/holdings/${seg(cik)}`, { type: "quarters" }),

    /**
     * Quarter-over-quarter buy/sell activity for an institution.
     *
     * @example
     * ```ts
     * const { rows } = await ko.institutions.activity("1067983");
     * ```
     */
    activity: <T = unknown>(cik: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/institution-activity/${seg(cik)}`),

    /**
     * Institutions with a similar strategy profile (label-based).
     *
     * @example
     * ```ts
     * const { rows } = await ko.institutions.similar("1067983");
     * ```
     */
    similar: <T = unknown>(cik: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/institutions/${seg(cik)}/similar`),
  };

  /** Stock profiles, prices, holders and financials. */
  readonly stocks = {
    /**
     * List stocks, filterable by search and sector.
     *
     * @example
     * ```ts
     * const { rows } = await ko.stocks.list({ sector: "Technology", perPage: 25 });
     * ```
     */
    list: <T = unknown>(options: StocksListOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/stocks", {
        search: options.search,
        sector: options.sector,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Stock profile by ticker (case-insensitive).
     *
     * @example
     * ```ts
     * const { data } = await ko.stocks.get("NVDA");
     * ```
     */
    get: <T = unknown>(ticker: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/stocks/${tick(ticker)}`),

    /**
     * Daily price history.
     *
     * @example
     * ```ts
     * const { rows } = await ko.stocks.price("NVDA", { days: 30 });
     * ```
     */
    price: <T = unknown>(ticker: string, options: StockPriceOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/stock-price/${tick(ticker)}`, {
        days: options.days,
        start_date: options.startDate,
        end_date: options.endDate,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Institutional holders of a stock (13F). Rows live at `data.data`;
     * the SDK surfaces them via `result.rows`.
     *
     * @example
     * ```ts
     * const { rows } = await ko.stocks.holders("NVDA", { action: "ADDED" });
     * ```
     */
    holders: <T = unknown>(ticker: string, options: StockHoldersOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/stock-holders/${tick(ticker)}`, {
        quarter: options.quarter,
        action: options.action,
        type: options.type,
        quarters: options.quarters,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Aggregated institutional activity for a stock across recent quarters.
     *
     * @example
     * ```ts
     * const { rows } = await ko.stocks.activity("NVDA", { quarters: 8 });
     * ```
     */
    activity: <T = unknown>(ticker: string, options: StockActivityOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/stock-holders/${tick(ticker)}`, {
        type: "activity",
        quarters: options.quarters,
      }),

    /**
     * Latest quarterly financials.
     *
     * @example
     * ```ts
     * const { rows } = await ko.stocks.financials("NVDA");
     * ```
     */
    financials: <T = unknown>(ticker: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/stocks/${tick(ticker)}/financials`),

    /**
     * Multi-year financial history. Returns an object in `data` (rows is empty).
     *
     * @example
     * ```ts
     * const { data } = await ko.stocks.financialsHistory("NVDA");
     * ```
     */
    financialsHistory: <T = unknown>(ticker: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/stocks/${tick(ticker)}/financials/historical`),
  };

  /** SEC Form 4 insider transactions. */
  readonly insiders = {
    /**
     * Recent insider trades across the market.
     *
     * @example
     * ```ts
     * const { rows } = await ko.insiders.trades({ ticker: "NVDA", role: "CEO" });
     * ```
     */
    trades: <T = unknown>(options: InsiderTradesOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/insider-trades", {
        ticker: options.ticker,
        role: options.role,
        period: options.period,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Insiders who traded a given company.
     *
     * @example
     * ```ts
     * const { rows } = await ko.insiders.byCompany("NVDA");
     * ```
     */
    byCompany: <T = unknown>(ticker: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/insider/by-company/${tick(ticker)}`),

    /**
     * Insider profile by CIK.
     *
     * @example
     * ```ts
     * const { data } = await ko.insiders.get("1548760");
     * ```
     */
    get: <T = unknown>(cik: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/insider/${seg(cik)}`),

    /**
     * Transactions filed by an insider.
     *
     * @example
     * ```ts
     * const { rows } = await ko.insiders.transactions("1548760", { side: "buy" });
     * ```
     */
    transactions: <T = unknown>(cik: string, options: InsiderTransactionsOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/insider/${seg(cik)}/transactions`, {
        ticker: options.ticker,
        signal: options.signal,
        side: options.side,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Executive (C-suite) trades for a company.
     *
     * @example
     * ```ts
     * const { rows } = await ko.insiders.executiveTrades("NVDA");
     * ```
     */
    executiveTrades: <T = unknown>(ticker: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/executive-trades/${tick(ticker)}`),
  };

  /** US congress member stock trading disclosures. */
  readonly congress = {
    /**
     * Congress trades, filterable by ticker, chamber and party.
     *
     * @example
     * ```ts
     * const { rows } = await ko.congress.trades({ ticker: "NVDA", chamber: "senate" });
     * ```
     */
    trades: <T = unknown>(options: CongressTradesOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/congress-trades", {
        ticker: options.ticker,
        chamber: options.chamber,
        party: options.party,
        search: options.search,
        sort: options.sort,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Trades disclosed by a single member (URL slug, e.g. "nancy-pelosi").
     *
     * @example
     * ```ts
     * const { rows } = await ko.congress.member("nancy-pelosi", { perPage: 20 });
     * ```
     */
    member: <T = unknown>(slug: string, options: PageOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/congress-trades/${seg(slug)}`, {
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Congress trades in a single stock.
     *
     * @example
     * ```ts
     * const { rows } = await ko.congress.stock("NVDA");
     * ```
     */
    stock: <T = unknown>(ticker: string, options: PageOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/congress-trades/stock/${tick(ticker)}`, {
        page: options.page,
        per_page: options.perPage,
      }),
  };

  /** Institutional crypto ETF exposure (BTC ETFs et al). */
  readonly crypto = {
    /**
     * Market-wide crypto ETF exposure summary.
     * Returns `{ complex, products: [...] }` in `data`.
     *
     * @example
     * ```ts
     * const { data } = await ko.crypto.exposureSummary();
     * ```
     */
    exposureSummary: <T = unknown>(): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/crypto/exposure-summary"),

    /**
     * Institutions holding crypto ETF products.
     *
     * @example
     * ```ts
     * const { rows } = await ko.crypto.holders({ product: "IBIT" });
     * ```
     */
    holders: <T = unknown>(options: CryptoHoldersOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/crypto/institutional-holders", {
        product: options.product,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Crypto ETF positions of a single institution.
     *
     * @example
     * ```ts
     * const { rows } = await ko.crypto.holder("1067983");
     * ```
     */
    holder: <T = unknown>(cik: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/crypto/holder/${seg(cik)}`),
  };

  /** SEC Form 144 proposed-sale notices. */
  readonly form144 = {
    /**
     * Form 144 notices (planned insider sales).
     *
     * @example
     * ```ts
     * const { rows } = await ko.form144.list({ ticker: "NVDA" });
     * ```
     */
    list: <T = unknown>(options: Form144ListOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/form144-notices", {
        ticker: options.ticker,
        cik: options.cik,
        page: options.page,
        per_page: options.perPage,
      }),
  };

  /** Short-side signals: fails-to-deliver and Reg SHO threshold lists. */
  readonly short = {
    /**
     * SEC fails-to-deliver data.
     *
     * @example
     * ```ts
     * const { rows } = await ko.short.ftd({ ticker: "GME", days: 90 });
     * ```
     */
    ftd: <T = unknown>(options: FtdOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/sec/ftd", {
        ticker: options.ticker,
        days: options.days,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * Reg SHO threshold list appearances.
     *
     * @example
     * ```ts
     * const { rows } = await ko.short.regSho({ symbol: "GME" });
     * ```
     */
    regSho: <T = unknown>(options: RegShoOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/reg-sho-threshold", {
        symbol: options.symbol,
        page: options.page,
        per_page: options.perPage,
      }),
  };

  /** Macro-economic series. All macro endpoints require Pro plan or higher. */
  readonly macro = {
    /**
     * US Treasury yield curve history. Requires Pro plan or higher.
     *
     * @example
     * ```ts
     * const { rows } = await ko.macro.treasuryYields({ days: 90 });
     * ```
     */
    treasuryYields: <T = unknown>(options: TreasuryYieldsOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/treasury/yields", {
        days: options.days,
        from: options.from,
        to: options.to,
      }),

    /**
     * Federal Reserve policy rates. Requires Pro plan or higher.
     *
     * @example
     * ```ts
     * const { rows } = await ko.macro.fedRates({ series: "EFFR" });
     * ```
     */
    fedRates: <T = unknown>(options: FedRatesOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/fed/rates", {
        days: options.days,
        series: options.series,
      }),

    /**
     * Economic indicators (BLS, Census, FRED...). Requires Pro plan or higher.
     *
     * @example
     * ```ts
     * const { rows } = await ko.macro.economicIndicators({ category: "employment" });
     * ```
     */
    economicIndicators: <T = unknown>(options: EconomicIndicatorsOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/economic/indicators", {
        category: options.category,
        series_id: options.seriesId,
        days: options.days,
        page: options.page,
        per_page: options.perPage,
      }),

    /**
     * OFR Financial Stress Index. Requires Pro plan or higher.
     *
     * @example
     * ```ts
     * const { rows } = await ko.macro.financialStress({ days: 365 });
     * ```
     */
    financialStress: <T = unknown>(options: FinancialStressOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>("/api/v1/stress/ofr", {
        days: options.days,
        series_name: options.seriesName,
      }),
  };

  /** SEC EDGAR filing gateway (white-labeled source documents). */
  readonly filings = {
    /**
     * List SEC filings for a CIK.
     *
     * @example
     * ```ts
     * const { rows } = await ko.filings.list("1067983", { form: "13F-HR", limit: 10 });
     * ```
     */
    list: <T = unknown>(cik: string, options: FilingsListOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/filings/${seg(cik)}`, {
        form: options.form,
        from: options.from,
        to: options.to,
        limit: options.limit,
      }),

    /**
     * Document index of a single filing.
     *
     * @example
     * ```ts
     * const { data } = await ko.filings.index("1067983", "0000950123-25-008361");
     * ```
     */
    index: <T = unknown>(cik: string, accession: string): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/filings/${seg(cik)}/${seg(accession)}`),

    /**
     * Signed shareable link for a filing document (24h validity).
     * Requires a paid plan.
     *
     * @example
     * ```ts
     * const { data } = await ko.filings.share("1067983", "0000950123-25-008361", { file: "primary" });
     * ```
     */
    share: <T = unknown>(cik: string, accession: string, options: FilingShareOptions = {}): Promise<ApiResult<T>> =>
      this.get<T>(`/api/v1/filings/${seg(cik)}/${seg(accession)}/share`, {
        file: options.file,
      }),
  };
}
