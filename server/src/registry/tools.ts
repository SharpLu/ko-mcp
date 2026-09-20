/**
 * ko-mcp TOOL REGISTRY -- the single declaration of what every MCP tool calls.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Until 2026-09-12 there was no machine-checkable answer to "which ko-api route
 * does this tool call, with which params, on which plan?". The whole upstream
 * contract lived in handler literals; the only gate all 24 tools passed asserted
 * that koFetch had been called with a path matching /^\/api\//, and never looked
 * at the third argument. So a tool could send a param no upstream handler reads
 * and nothing failed -- which is exactly what four of them do today, one of them
 * (`list_insider_traders.search`, ko-bastion#125) in a way that makes the model
 * state something false: the unfiltered site-wide feed rendered under a heading
 * that claims it was searched.
 *
 * This file is the ko-mcp analogue of ko-api's src/registry/routes.ts, and the
 * gates in src/__tests__/registry/ are the analogue of its blocking gates:
 *
 *   (a) completeness  every registered tool is declared here, and vice versa
 *   (b) behaviour     every declared leg is OBSERVED when the tool actually runs
 *                     (handlers are invoked against a mocked transport), and no
 *                     unobserved/undeclared leg or param escapes
 *   (c) existence     every declared upstream path exists in the ko-api route
 *                     registry, pinned by blob SHA (src/registry/upstream/)
 *   (d) params        every param a tool sends is read by that route's handler
 *                     upstream -- else it must be an annotated INERT_PARAMS
 *                     entry, and that entry FAILS once upstream starts reading it
 *   (e) truncation    a tool calling a paginated route must send a row-count
 *                     param the route reads -- else an annotated exception
 *   (f) plan          the declared plan matches what ko-api would enforce:
 *                     route auth mode + PLAN_GATES.free.blockedPrefixes
 *   (g) defects       each known non-param defect is asserted to STILL EXIST,
 *                     so fixing one forces a deliberate registry update
 *
 * HOW TO ADD A TOOL: write it, then add its entry here and a probe in
 * src/__tests__/registry/probes.ts. The gates tell you exactly what is missing.
 * Never widen an exception table to make a gate green without writing down why;
 * per house rule these tables only shrink.
 */

/** How a leg reaches ko-api. `fetch` = bare fetch(), bypassing ko-fetch.ts. */
export type UpstreamTransport = 'koFetch' | 'fetch';

/** What a leg is for. Purely descriptive; the gates key on path + params. */
export type LegRole = 'primary' | 'name-resolution' | 'share-link' | 'excerpt';

export interface UpstreamLeg {
  /**
   * The ko-api route TEMPLATE, byte-identical to the `path` field of that
   * route's entry in ko-api src/registry/routes.ts. Gate (c) compares them.
   */
  path: string;
  method: 'GET';
  /**
   * Query params this leg puts on the wire. NOT the MCP input names -- the
   * names ko-api sees. Gate (b) checks these against the real call, gate (d)
   * against the upstream handler's reads.
   */
  params: readonly string[];
  transport: UpstreamTransport;
  role: LegRole;
  /** Set when the leg is not taken on every invocation; text says when. */
  conditional?: string;
}

/** Lowest ko.io plan that gets DATA from this tool (not a 403 gate). */
export type ToolPlan = 'free' | 'paid';

export interface ToolSpec {
  tool: string;
  /** Repo-relative module that registers it. */
  file: string;
  /** Every key of the tool's zod input schema. Gate (b) checks it. */
  inputs: readonly string[];
  /** Input names that control paging / row counts. */
  paginationInputs: readonly string[];
  plan: ToolPlan;
  /** Why that plan -- derived by gate (f) from the pinned ko-api registry. */
  planReason: string;
  upstreamRoutes: readonly UpstreamLeg[];
  notes?: string;
}

/**
 * Params ko-api's AUTH layer reads, not any route handler. They never appear in
 * a handler's `sp.get(...)` calls, so gate (d) must not demand a handler read
 * them. `demo` is set by ko-fetch.ts whenever the caller sent no key.
 */
export const TRANSPORT_PARAMS: readonly string[] = ['demo', 'api_key', 'key'];

export const TOOL_REGISTRY: readonly ToolSpec[] = [
  // ── institutions ────────────────────────────────────────────────────────
  {
    tool: 'get_institution_holdings',
    file: 'src/tools/institutions.ts',
    inputs: ['institution', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; /api/v1/holdings is on no free blockedPrefix',
    upstreamRoutes: [
      {
        path: '/api/v1/institutions', method: 'GET', params: ['search', 'limit'],
        transport: 'koFetch', role: 'name-resolution',
        conditional: 'only when `institution` is free text, not a CIK or slug (resolve.ts isIdentifier)',
      },
      { path: '/api/v1/holdings/:cik', method: 'GET', params: ['page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'list_institutions',
    file: 'src/tools/institutions.ts',
    inputs: ['search', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/institutions', method: 'GET', params: ['search', 'page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },

  // ── stocks ──────────────────────────────────────────────────────────────
  {
    tool: 'get_stock_profile',
    file: 'src/tools/stocks.ts',
    inputs: ['ticker'],
    paginationInputs: [],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/stocks/:ticker', method: 'GET', params: [], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_stock_holders',
    file: 'src/tools/stocks.ts',
    inputs: ['ticker', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/stock-holders/:ticker', method: 'GET', params: ['type', 'page', 'limit'], transport: 'koFetch', role: 'primary' },
    ],
    notes: 'the one route that reads `per_page || limit`, so `limit` is live here',
  },
  {
    tool: 'get_stock_activity',
    file: 'src/tools/stocks.ts',
    inputs: ['ticker', 'quarters'],
    paginationInputs: ['quarters'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/stock-holders/:ticker', method: 'GET', params: ['type', 'quarters'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_stock_price',
    file: 'src/tools/stocks.ts',
    inputs: ['ticker', 'period', 'series', 'limit'],
    paginationInputs: ['limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/stock-price/:ticker', method: 'GET', params: ['days', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
    notes: 'the only tool whose wire params were asserted by a test before this registry existed',
  },
  {
    tool: 'get_stock_financials',
    file: 'src/tools/financials.ts',
    inputs: ['ticker', 'period_type', 'limit'],
    paginationInputs: ['limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/stocks/:ticker/financials/historical', method: 'GET', params: ['period_type'], transport: 'koFetch', role: 'primary' },
    ],
    notes: '`limit` is a client-side slice of the returned series, never sent upstream',
  },

  // ── insiders ────────────────────────────────────────────────────────────
  {
    tool: 'get_insider_trades',
    file: 'src/tools/insiders.ts',
    inputs: ['ticker', 'executive_cik', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/executive-trades/:ticker', method: 'GET', params: ['page', 'per_page', 'executive_cik'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'list_insider_traders',
    file: 'src/tools/insiders.ts',
    inputs: ['search', 'role', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/insider-trades', method: 'GET', params: ['search', 'role', 'page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },

  // ── congress ────────────────────────────────────────────────────────────
  {
    tool: 'get_congress_trades',
    file: 'src/tools/congress.ts',
    inputs: ['chamber', 'ticker', 'search', 'sort', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      {
        path: '/api/v1/congress-trades', method: 'GET',
        params: ['chamber', 'ticker', 'search', 'sort', 'page', 'limit'],
        transport: 'koFetch', role: 'primary',
      },
    ],
  },
  {
    tool: 'get_congress_member',
    file: 'src/tools/congress.ts',
    inputs: ['member', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/congress-trades/:member', method: 'GET', params: ['type', 'page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },

  // ── search / form144 ────────────────────────────────────────────────────
  {
    tool: 'search',
    file: 'src/tools/search.ts',
    inputs: ['query', 'limit'],
    paginationInputs: ['limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/search', method: 'GET', params: ['q', 'limit'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_form144_notices',
    file: 'src/tools/form144.ts',
    inputs: ['ticker', 'insider_cik', 'limit'],
    paginationInputs: ['limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/form144-notices', method: 'GET', params: ['ticker', 'cik', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
    notes: 'upstream `page` exists but the tool does not expose it',
  },

  // ── EDGAR filings ───────────────────────────────────────────────────────
  {
    tool: 'sec_list_filings',
    file: 'src/tools/filings.ts',
    inputs: ['cik', 'form_type', 'from', 'to', 'limit'],
    paginationInputs: ['limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/filings/:cik', method: 'GET', params: ['form', 'from', 'to', 'limit'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'sec_get_filing_index',
    file: 'src/tools/filings.ts',
    inputs: ['cik', 'accession_no'],
    paginationInputs: [],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/filings/:cik/:accession', method: 'GET', params: [], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'sec_get_filing_document',
    file: 'src/tools/filings.ts',
    inputs: ['cik', 'accession_no', 'file', 'include_excerpt'],
    paginationInputs: [],
    plan: 'paid',
    planReason: 'both legs are paid upstream: /share = apiKeyPaid, /file = signedTokenOrApiKeyPaid',
    upstreamRoutes: [
      {
        path: '/api/v1/filings/:cik/:accession/share', method: 'GET', params: ['file'],
        transport: 'koFetch', role: 'share-link',
        conditional: '`file` is sent only when the caller named a file inside the filing',
      },
      {
        path: '/api/v1/filings/:cik/:accession/file', method: 'GET', params: ['file', 'format'],
        transport: 'fetch', role: 'excerpt',
        conditional: 'only when include_excerpt (default true); bare fetch(), so ko-fetch.ts error handling does not apply',
      },
    ],
  },

  // ── macro (4 of these 5 are gated off free/demo) ─────────────────────────
  {
    tool: 'get_treasury_yields',
    file: 'src/tools/macro.ts',
    inputs: ['days'],
    paginationInputs: [],
    plan: 'paid',
    planReason: 'PLAN_GATES.free.blockedPrefixes contains /api/v1/treasury',
    upstreamRoutes: [
      { path: '/api/v1/treasury/yields', method: 'GET', params: ['days'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_fed_rates',
    file: 'src/tools/macro.ts',
    inputs: ['days'],
    paginationInputs: [],
    plan: 'paid',
    planReason: 'PLAN_GATES.free.blockedPrefixes contains /api/v1/fed',
    upstreamRoutes: [
      { path: '/api/v1/fed/rates', method: 'GET', params: ['days'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_economic_indicators',
    file: 'src/tools/macro.ts',
    inputs: ['category', 'days', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'paid',
    planReason: 'PLAN_GATES.free.blockedPrefixes contains /api/v1/economic',
    upstreamRoutes: [
      { path: '/api/v1/economic/indicators', method: 'GET', params: ['category', 'days', 'page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_ftd_data',
    file: 'src/tools/macro.ts',
    inputs: ['ticker', 'days', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; /api/v1/sec is NOT a free blockedPrefix (only /sec/13dg, /sec/form-d, /sec/buybacks are)',
    upstreamRoutes: [
      { path: '/api/v1/sec/ftd', method: 'GET', params: ['ticker', 'days', 'page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_financial_stress',
    file: 'src/tools/macro.ts',
    inputs: ['days', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'paid',
    planReason: 'PLAN_GATES.free.blockedPrefixes contains /api/v1/stress',
    upstreamRoutes: [
      { path: '/api/v1/stress/ofr', method: 'GET', params: ['days', 'page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },

  // ── crypto ──────────────────────────────────────────────────────────────
  {
    tool: 'get_crypto_exposure',
    file: 'src/tools/crypto.ts',
    inputs: [],
    paginationInputs: [],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/crypto/exposure-summary', method: 'GET', params: [], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_crypto_holders',
    file: 'src/tools/crypto.ts',
    inputs: ['product', 'page', 'limit'],
    paginationInputs: ['page', 'limit'],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      { path: '/api/v1/crypto/institutional-holders', method: 'GET', params: ['product', 'page', 'per_page'], transport: 'koFetch', role: 'primary' },
    ],
  },
  {
    tool: 'get_crypto_holder',
    file: 'src/tools/crypto.ts',
    inputs: ['institution'],
    paginationInputs: [],
    plan: 'free',
    planReason: 'apiKey; no free blockedPrefix',
    upstreamRoutes: [
      {
        path: '/api/v1/institutions', method: 'GET', params: ['search', 'limit'],
        transport: 'koFetch', role: 'name-resolution',
        conditional: 'only when `institution` is free text, not a CIK or slug (resolve.ts isIdentifier)',
      },
      { path: '/api/v1/crypto/holder/:cik', method: 'GET', params: [], transport: 'koFetch', role: 'primary' },
    ],
  },
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOL_REGISTRY.map((t) => [t.tool, t]));

// ────────────────────────────────────────────────────────────────────────────
// EXCEPTIONS. Each one is a LIVE DEFECT this PR does not fix. Gate (d)/(e)/(g)
// assert the defect is still there: fix it upstream or here and the exception
// turns red, which is the point -- a fix must retire its exception deliberately
// instead of leaving a lie in the registry.
// ────────────────────────────────────────────────────────────────────────────

export interface InertParam {
  tool: string;
  /** The upstream route template the param is sent to. */
  path: string;
  param: string;
  /** ko-bastion issue tracking it. */
  issue: string;
  /** What the model / caller loses or is told wrongly. */
  why: string;
  /** Where the gate first saw it, when that was not the M0 audit. */
  firstSeen?: string;
}

/**
 * Params a tool puts on the wire that NO upstream handler reads. Two severities:
 *   - FALSE FILTER: the tool advertises a filter, the response is unfiltered,
 *     and the rendering claims the filter was applied  -> the model states
 *     something false. ko-bastion#125 is the archetype.
 *   - INERT ROW COUNT: `limit` where the route reads only `per_page` -> the
 *     caller always gets the upstream default of 50 rows. ko-bastion#126.
 */
export const INERT_PARAMS: readonly InertParam[] = [
  // -- inert row counts (ko-bastion#126) -----------------------------------
  //
  // The four PRIMARY legs that used to be here -- list_institutions,
  // get_insider_trades, list_insider_traders, get_congress_member -- now send
  // `per_page`, which is the name their routes read, so their entries are gone.
  // What is left is the one leg that is NOT a rendered truncation: resolve.ts's
  // internal candidate lookup, shared by the two tools that accept a free-text
  // institution name.
  {
    tool: 'get_institution_holdings', path: '/api/v1/institutions', param: 'limit', issue: 'ko-bastion#126',
    why: 'resolve.ts asks for 5 candidates and gets 50; it then uses matches[0], so the cost is bandwidth, not correctness. NOT fixed with the rest: /api/v1/institutions orders by portfolio_value DESC, so honouring the 5 would SHRINK the candidate set and could change which institution a free-text name resolves to. That is a behaviour change needing its own evidence, and no fixture covers the name path today',
  },
  {
    tool: 'get_crypto_holder', path: '/api/v1/institutions', param: 'limit', issue: 'ko-bastion#126',
    why: 'same resolve.ts leg as get_institution_holdings',
  },

  // -- false filters (ko-bastion#125 class) --------------------------------
  //
  // ALL FOUR RETIRED 2026-09-12. Two were fixed upstream, two were deleted:
  //
  //   search         -> ko-api#260 binds it on reporting_person_name.
  //                     Live: search=Cook -> total_count 24 ("Cook Steven L."),
  //                     search=zzzqqq -> 0, no search -> 17,744.
  //   executive_cik  -> ko-api#260 binds it (digits only).
  //                     Live: 1214128 -> 79 ("LEVINSON ARTHUR D"), 9999999 -> 0,
  //                     no filter -> 1,348.
  //   party, state   -> REMOVED from the tool schema instead of implemented.
  //                     marts.dim_congress_members has 215 of 350 members with
  //                     BOTH columns blank (38.6% fill; 41.8% trade-weighted).
  //                     The join is perfect -- 350 vs 350, zero unmatched -- the
  //                     dimension is empty. A filter covering at most 41.8%
  //                     without saying so is ko-bastion#126 in a new place.
  //
  // A note for whoever adds the next entry here: the #125 defect PROBE
  // (`identicalToCase: 'empty'`) went on passing after the bug was fixed,
  // because two EMPTY answers are byte-identical just as two unfiltered ones
  // were. A probe asserting "these two are the same" cannot tell which sameness
  // it is looking at. Prefer a probe that asserts the defect's CONSEQUENCE
  // (a row count, a specific value) over one that asserts an equality.

  // -- inert but harmless (no wrong claim reaches the model) ---------------
  {
    tool: 'get_congress_member', path: '/api/v1/congress-trades/:member', param: 'type', issue: 'ko-bastion#125',
    why: 'hardcoded type="trades" is read by nobody; the route only ever returns trades, so the result happens to match the intent',
    firstSeen: 'M2 registry gate, 2026-09-12 -- not named in the #125 text',
  },
  {
    tool: 'get_stock_financials', path: '/api/v1/stocks/:ticker/financials/historical', param: 'period_type', issue: 'ko-bastion#125',
    why: 'the route reads no query params at all and returns { quarterly, annual } together; the tool picks the series client-side, so the inert param costs nothing today but hides the fact that the selection is not server-side',
    firstSeen: 'M2 registry gate, 2026-09-12 -- not named in the #125 text',
  },
];

export interface SilentTruncation {
  tool: string;
  path: string;
  issue: string;
  why: string;
}

/**
 * Tools that call a PAGINATED upstream route while sending no row-count param
 * at all, so they silently receive the upstream default of 50 rows with no
 * truncation notice and no way to page. Tools that send an INERT row param are
 * covered by INERT_PARAMS instead, so a defect appears in exactly one table.
 */
export const SILENT_TRUNCATIONS: readonly SilentTruncation[] = [
  // EMPTY, and that is the assertion. The three entries that lived here --
  // get_ftd_data, get_economic_indicators, get_financial_stress -- each called a
  // paginated route with no row-count param at all and were handed the upstream
  // 50-row default (measured: {GME, days:1825} rendered 50 rows of a
  // total_count of 1,025, with no notice and no page input). All three now take
  // `page` + `limit` and send `page` + `per_page`, and each says so when a page
  // comes back full. Gate (e) keeps this table empty: a tool that starts calling
  // a paginated route without a row count fails there rather than landing a new
  // entry here.
];

export interface BehaviouralDefect {
  id: string;
  issue: string | null;
  what: string;
  /** What the gate asserts is STILL TRUE. When it stops being true, fix here. */
  stillTrue: string;
}

/** Known non-param defects, each asserted to still exist by gate (g). */
export const BEHAVIOURAL_DEFECTS: readonly BehaviouralDefect[] = [
  // RETIRED 2026-09-12 -- 'no-timeout' (ko-bastion#127). koFetch now bounds every
  // call with AbortSignal.timeout(KO_FETCH_TIMEOUT_MS = 20s), under the 30s the
  // upstream route declares, and raises KoTimeoutError instead of inheriting a
  // 5xx. The measured 60,222 ms worst case is no longer reachable. Retry and
  // breaker are still absent and deliberately so: a retry on a 20s budget doubles
  // the client's wait, and there is nothing here to trip a breaker on yet.
  {
    id: 'error-passthrough-contradicts-comment',
    issue: null,
    what: 'ko-fetch.ts:36-38 says it does NOT pass ko-api error bodies through; line 42 appends error.message verbatim (observed leaking an upstream data.sec.gov URL). Today the leak is public data -- the risk is that the comment tells the next reader the opposite of what the code does.',
    stillTrue: 'src/ko-fetch.ts both claims "do NOT pass through" and assigns detail from j.error.message',
  },
  {
    id: 'filing-document-plan-undeclared',
    issue: null,
    what: 'sec_get_filing_document is the one paid-only tool, and neither its description nor its success envelope says so: on free it returns isError=false, an unsigned link and "(excerpt unavailable: 403)", which a model will report as "I fetched the document".',
    stillTrue: 'the tool description mentions no plan/paid/subscription requirement',
  },
  {
    id: 'headed-empty-table',
    issue: null,
    // NARROWED 2026-09-20. get_congress_member is fixed: it guards its table on
    // a non-empty response and says "No machine-readable trades returned for
    // this member.", carrying ko-api's `meta.coverage.note` when there is one
    // (CONGRESS_10_DOD D1 -- ~72 members file only on paper, so an empty `data`
    // there means "unreadable", not "did not trade"). list_institutions is
    // unchanged and still renders the bare header; it needs its own evidence,
    // and folding it in here would have made this entry un-assertable.
    what: 'list_institutions renders an empty result as a table header with no rows, unlike the soft "no results" sentence the other 23 tools use. A headed empty table reads to a model as a valid, complete, empty answer.',
    stillTrue: 'list_institutions emits a markdown table header for an empty upstream response',
  },
];
