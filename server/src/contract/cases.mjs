/**
 * The case manifest: what the golden gate calls, and why.
 *
 * This file is the half the M0 recordings did not have. The 2026-09-12 capture
 * of mcp.ko.io saved 75 verbatim response bodies but not the arguments that
 * produced them, so a response could be read and never re-run. Every argument
 * below was reconstructed from the recorded output (the echoed ticker, CIK,
 * member slug, accession and zod error body pin it almost completely) and then
 * CONFIRMED against a locally built Worker: each reconstructed call reproduced
 * its recording's rendered text, byte length for byte length. See
 * docs/GOLDEN_CONTRACT.md for the confirmation log.
 *
 * Manifest first, fixtures second: `npm run golden:capture` replays THIS file
 * and writes src/contract/golden/*.json. A case that is not here does not
 * exist, and a fixture without a manifest entry fails `npm test`.
 *
 * Case names follow the M0 recordings: `normal` (a populated answer), `empty`
 * (a well-formed call whose result set is empty) and `error` (a rejected call).
 * Two tools carry a fourth, named for what it demonstrates.
 */

/**
 * Tickers and identifiers chosen to be contract-stable, not interesting.
 *
 * ZZZQQ is not a listed symbol and never will be; 320193 is Apple's CIK, whose
 * 10-K accession is immutable EDGAR history; 1067983 is Berkshire's CIK, used
 * rather than the name "Berkshire Hathaway" because a name goes through
 * resolveInstitution and prepends an `*Interpreted ... as ...*` line -- which
 * is what the M0 recording shows was NOT used.
 */
export const NO_SUCH_TICKER = 'ZZZQQ';
export const APPLE_CIK = '320193';
export const APPLE_10K = '0000320193-25-000079';
export const BERKSHIRE_CIK = '1067983';
export const BREVAN_HOWARD_CIK = '1512857';
/**
 * A syntactically valid accession number EDGAR has never issued, so the miss is
 * a property of the identifier and not of what SEC published today.
 */
export const NO_SUCH_ACCESSION = '0000000000-00-000000';

/**
 * Cases deliberately NOT pinned, each with the reason it is not pinned.
 *
 * An exclusion is a claim about the world and has to survive being read back,
 * so `npm test` requires a reason of real length and requires that no excluded
 * case also appears in CASES.
 */
export const EXCLUDED = {
  'get_crypto_exposure.empty':
    'Cannot be constructed. The tool takes no arguments at all (an empty `{}` input schema) and always ' +
    'returns the whole spot-ETF complex, so there is no input that yields an empty result. This is a ' +
    'structural absence, not a coverage gap: the M0 recording set has 75 files rather than 76 for the ' +
    'same reason.',
  'get_ftd_data.normal':
    'The recorded "normal" call ({ticker:GME}, default 90-day window) returned "No FTD data found for GME." ' +
    '-- an EMPTY result, because SEC had published no GME fails-to-deliver inside 90 days that day. Pinning ' +
    'it would pin a data state that flips the moment SEC publishes one, and the gate would go red on a ' +
    'change in the world rather than a change in the contract. The populated-table contract for this tool ' +
    'is carried by the `truncation` case instead, which asks for the full 1825-day window.',
};

/**
 * Known live defects, annotated rather than pinned.
 *
 * Every entry here describes output that is WRONG today. The skeleton never
 * carries the wrongness -- row counts collapse and values are erased -- so the
 * contract this gate enforces is defect-neutral. The `probe` asserts the defect
 * is still present, which means fixing the bug turns the gate RED and forces a
 * deliberate re-pin by whoever fixed it. The alternative, pinning today's wrong
 * answer, would make this gate block its own repair.
 */
// DEFECT_126_LIMIT was here, and it did its job. It annotated four cases whose
// tool sent `limit` to a ko-api route that reads only `per_page`, so the page
// was always the 50-row default however small a limit the caller asked for; its
// `dataRowCount: 50` probe existed so that FIXING the bug would fail this gate
// rather than pass it silently. On the #126 fix it did exactly that, naming all
// four cases ("rendered 5 data rows; the defect renders exactly 50", and 100 for
// get_ftd_data), which is why the annotation and its four call sites are gone
// and the fixtures below now pin the CORRECTED rendering -- including the
// disclosure lines that did not exist before.

const DEFECT_EMPTY_TABLE = {
  issue: 'KO_MCP_TOOL_MATRIX_20260912.md section 3, warning 5 (no issue filed)',
  summary:
    'An empty result is rendered as a table header with no rows, unlike the soft "no results" sentence the ' +
    'other 22 tools use. A model reads a well-formed empty table as a real answer. Annotated, not pinned: ' +
    'when this is changed to a soft-empty sentence the probe stops holding and the case is re-pinned.',
  probe: { kind: 'headerWithoutRows' },
};

/**
 * Every replayed case.
 *
 * `why` is not decoration: it is what a reader needs in order to judge whether
 * a red gate means the contract moved or the world did.
 */
export const CASES = [
  {
    tool: 'get_institution_holdings',
    cases: [
      { name: 'normal', arguments: { institution: BERKSHIRE_CIK, limit: 5 },
        why: 'A CIK (not a name) so no resolveInstitution preamble line; the 13F holdings table.' },
      { name: 'empty', arguments: { institution: BERKSHIRE_CIK, page: 99999 },
        why: 'A page past the end: the soft-empty path, "Quarter: Unknown" and no table at all.' },
      { name: 'error', arguments: {},
        why: 'Required `institution` missing -- zod -32602, pinned verbatim.' },
    ],
  },
  {
    tool: 'list_institutions',
    cases: [
      { name: 'normal', arguments: { limit: 5 },
        why: 'The institutions page. Five rows because five were asked for: the tool sends `per_page` now, ' +
             'and the trailing "More results available" line is the full-page hint finally keying off a ' +
             'page size that reached ko-api (#126).' },
      { name: 'empty', arguments: { search: 'zzzqqqnotarealinstitution' }, knownDefect: DEFECT_EMPTY_TABLE,
        why: 'A search matching nothing renders a headed empty table (audit warning 5).' },
      { name: 'error', arguments: { limit: 999 },
        why: 'Above the schema clamp (max 50) -- zod -32602 carrying the bound itself.' },
    ],
  },
  {
    tool: 'get_stock_profile',
    cases: [
      { name: 'normal', arguments: { ticker: 'AAPL' }, why: 'The metric/value profile table.' },
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER },
        why: 'Unknown ticker -- upstream 404 surfaced as isError with the ko.io error class.' },
      { name: 'error', arguments: {}, why: 'Required `ticker` missing -- zod -32602.' },
    ],
  },
  {
    tool: 'get_stock_holders',
    cases: [
      { name: 'normal', arguments: { ticker: 'AAPL', limit: 5 },
        why: 'The holders page. limit IS honoured here (upstream reads per_page || limit).' },
      { name: 'empty', arguments: { ticker: 'AAPL', page: 99999 },
        why: 'A page past the end: the soft sentence, isError false.' },
      { name: 'error', arguments: { ticker: NO_SUCH_TICKER },
        why: 'Unknown ticker. Note this tool answers softly rather than with isError -- pinning that is ' +
             'the point: an error shape that silently becomes a success envelope is exactly what a model ' +
             'cannot see.' },
    ],
  },
  {
    tool: 'get_stock_activity',
    cases: [
      { name: 'normal', arguments: { ticker: 'AAPL' }, why: 'Summary bullets plus the quarterly-trend table.' },
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER }, why: 'Soft sentence, no table.' },
      { name: 'error', arguments: { ticker: 'AAPL', quarters: 99 }, why: 'Above the quarters clamp (max 40).' },
    ],
  },
  {
    tool: 'get_stock_price',
    cases: [
      { name: 'normal', arguments: { ticker: 'AAPL' },
        why: 'Two tables (summary metrics + recent prices) -- the richest rendering in the surface.' },
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER },
        why: 'Unknown ticker: one soft sentence, so BOTH tables disappear -- the strongest empty-shell signal ' +
             'in the surface.' },
      { name: 'error', arguments: { ticker: 'AAPL', period: '20y' }, why: 'Outside the period enum.' },
    ],
  },
  {
    tool: 'get_insider_trades',
    cases: [
      { name: 'normal', arguments: { ticker: 'AAPL', limit: 5 },
        why: 'Per-ticker insider table, five rows for limit=5 (#126). This tool also carried a SECOND ' +
             'truncation -- a hardcoded truncate(trades, 50) in the rendering -- so limit=200 rendered 50 ' +
             'even once per_page landed; both are gone, and a full page now says so.' },
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER },
        why: 'Unknown ticker: a soft sentence in a SUCCESS envelope, no table, isError absent.' },
      { name: 'error', arguments: {}, why: 'Required `ticker` missing.' },
    ],
  },
  {
    tool: 'list_insider_traders',
    cases: [
      { name: 'normal', arguments: { search: 'Cook', limit: 5 },
        why: 'ko-bastion#125 FIXED (ko-api#260, live 2026-09-12): `search` now reaches ko-api and ' +
             'filters on reporting_person_name. The term was changed from "Musk" to "Cook" on purpose ' +
             '-- it returns rows live, so this case exercises a WORKING filter. Pinning a term that ' +
             'returns nothing would have made the normal case indistinguishable from the empty one, ' +
             'which is exactly how the old defect probe went on passing after the bug was fixed. ' +
             '`limit: 5` is load-bearing: the feed is a rolling "recently traded" window, and the ' +
             'full-page "More results" line only renders when rows == limit. Pinned at the default 20, ' +
             '"Cook" decayed from 24 live rows (09-12) to 18 (09-25) and the line vanished -- a data-window ' +
             'drift that red-lit the deploy gate with no code change. 5 keeps the full page (and the ' +
             'paging line) robust to that decay.' },
      { name: 'empty', arguments: { search: 'zzzqqq' },
        why: 'A search that matches nothing. Before #260 this returned the unfiltered feed byte-for-byte ' +
             'identical to the normal case; now it is genuinely empty.' },
      { name: 'error', arguments: { role: 'chairman' }, why: 'Outside the role enum.' },
    ],
  },
  {
    tool: 'get_congress_trades',
    cases: [
      { name: 'normal', arguments: { limit: 5 }, why: 'Congress trades table; limit honoured upstream.' },
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER }, why: 'Soft sentence under a heading.' },
      { name: 'error', arguments: { chamber: 'lords' }, why: 'Outside the chamber enum.' },
    ],
  },
  {
    tool: 'get_congress_member',
    cases: [
      { name: 'normal', arguments: { member: 'nancy-pelosi', limit: 5 },
        why: 'One member history, five rows for limit=5 (#126). NOTE the sibling collection route ' +
             '/api/v1/congress-trades is the one route in this surface that accepts `limit` ' +
             '(`per_page ?? limit`), which is why get_congress_trades above was never affected.' },
      { name: 'empty', arguments: { member: 'nancy-pelosi', page: 9999 }, knownDefect: DEFECT_EMPTY_TABLE,
        why: 'Page past the end renders a headed empty table (audit warning 5).' },
      { name: 'error', arguments: {}, why: 'Required `member` missing.' },
    ],
  },
  {
    tool: 'search',
    cases: [
      { name: 'normal', arguments: { query: 'Berkshire' },
        why: 'Three sections (Institutions / Stocks / Insiders). A section vanishing is the break this ' +
             'case exists to catch.' },
      { name: 'empty', arguments: { query: 'zzzqqqnotarealentityxyz' }, why: 'Soft sentence, no sections.' },
      { name: 'error', arguments: { query: 'z' }, why: 'Below the 2-character minimum.' },
    ],
  },
  {
    tool: 'get_form144_notices',
    cases: [
      { name: 'normal', arguments: { ticker: 'AAPL', limit: 5 }, why: 'Notices table; limit honoured.' },
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER },
        why: 'Unknown ticker: heading, a zero-count line, then a soft sentence and no table.' },
      { name: 'error', arguments: { ticker: 'AAPL', limit: 999 }, why: 'Above the clamp (max 200).' },
    ],
  },
  {
    tool: 'sec_list_filings',
    cases: [
      { name: 'normal', arguments: { cik: APPLE_CIK, limit: 5 }, why: 'EDGAR filing list; limit honoured.' },
      { name: 'empty', arguments: { cik: APPLE_CIK, form_type: 'ZZZ' },
        why: 'A form type nobody files: headed empty table plus a soft sentence.' },
      { name: 'error', arguments: { cik: '99999999999' },
        why: 'A CIK EDGAR has never issued -- 404. This is also the case that shows koFetch passing the ' +
             'upstream SEC URL through despite its own comment saying it does not (audit warning 6); the ' +
             'URL normalises to <URL>, so the gate pins the error CLASS and not the leak.' },
    ],
  },
  {
    tool: 'sec_get_filing_index',
    cases: [
      { name: 'normal', arguments: { cik: APPLE_CIK, accession_no: APPLE_10K },
        why: 'The file index of an immutable EDGAR filing.' },
      { name: 'empty', arguments: { cik: APPLE_CIK, accession_no: NO_SUCH_ACCESSION },
        why: 'RE-PINNED 2026-09-12 when ko-bastion#127 shipped. This case was excluded because its error ' +
             'CLASS was nondeterministic: the same well-formed but nonexistent accession returned a 404 in ' +
             'one M0 recording and a 502-after-60.2s in another, and on 2026-09-12 it blocked a main deploy ' +
             'by moving 404 -> 502 between the local run and CI (run 34711440107). The cause was that ' +
             'koFetch waited without a bound, so a stalled EDGAR miss surfaced as somebody else\'s 5xx ' +
             'instead of the 404 the input deserves. koFetch is now bounded at 20s, under the 30s the ' +
             'upstream route declares, and a stall raises KoTimeoutError -- named, ours, and never a ' +
             '`ko.io API error (5xx)` line that this file could mistake for a contract.' },
      { name: 'error', arguments: { cik: APPLE_CIK }, why: 'Required `accession_no` missing.' },
    ],
  },
  {
    tool: 'sec_get_filing_document',
    cases: [
      { name: 'normal', arguments: { cik: APPLE_CIK, accession_no: APPLE_10K },
        why: 'The free-tier path: an UNSIGNED link and "(excerpt unavailable: 403)" inside a SUCCESS ' +
             'envelope (audit warning 7). Pinned because the shape is the contract a model sees, and the ' +
             '403 in it is one of only two digits normalisation keeps.' },
      { name: 'empty', arguments: { cik: APPLE_CIK, accession_no: APPLE_10K, file: 'nosuchfile.htm' },
        why: 'A file that is not in the filing -- still a success envelope with a link.' },
      { name: 'error', arguments: { cik: APPLE_CIK }, why: 'Required `accession_no` missing.' },
    ],
  },
  {
    tool: 'get_stock_financials',
    cases: [
      { name: 'normal', arguments: { ticker: 'AAPL' }, why: 'Quarterly financials table.' },
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER }, why: 'Upstream 404 as isError.' },
      { name: 'error', arguments: { ticker: 'AAPL', period_type: 'monthly' },
        why: 'Outside the period_type enum -- zod -32602 listing the two allowed values.' },
    ],
  },
  {
    tool: 'get_treasury_yields',
    planGated: true,
    cases: [
      { name: 'normal', arguments: {}, why: 'PLAN GATE, NOT DATA -- see planGated below.' },
      { name: 'empty', arguments: { days: 1 }, why: 'PLAN GATE, NOT DATA.' },
      { name: 'error', arguments: { days: 9999 }, why: 'Above the days clamp (max 3650) -- zod, never touches the network.' },
    ],
  },
  {
    tool: 'get_fed_rates',
    planGated: true,
    cases: [
      { name: 'normal', arguments: {}, why: 'PLAN GATE, NOT DATA.' },
      { name: 'empty', arguments: { days: 1 }, why: 'PLAN GATE, NOT DATA.' },
      { name: 'error', arguments: { days: 0 }, why: 'Below the days minimum (1).' },
    ],
  },
  {
    tool: 'get_economic_indicators',
    planGated: true,
    cases: [
      { name: 'normal', arguments: {}, why: 'PLAN GATE, NOT DATA.' },
      { name: 'empty', arguments: { days: 1 }, why: 'PLAN GATE, NOT DATA.' },
      { name: 'error', arguments: { category: 'gdp' }, why: 'Outside the category enum.' },
    ],
  },
  {
    tool: 'get_financial_stress',
    planGated: true,
    cases: [
      { name: 'normal', arguments: {}, why: 'PLAN GATE, NOT DATA.' },
      { name: 'empty', arguments: { days: 1 }, why: 'PLAN GATE, NOT DATA.' },
      { name: 'error', arguments: { days: 0 }, why: 'Below the days minimum (1).' },
    ],
  },
  {
    tool: 'get_ftd_data',
    cases: [
      { name: 'empty', arguments: { ticker: NO_SUCH_TICKER }, why: 'Soft sentence, no table.' },
      { name: 'error', arguments: { ticker: 'GME', days: 9999 }, why: 'Above the days clamp (max 1825).' },
      { name: 'truncation', arguments: { ticker: 'GME', days: 1825 },
        why: 'The 1,025-row window. This case used to demonstrate the defect -- the tool sent no ' +
             '`per_page` at all, ko-api capped the answer at its 50-row default, and the rendering said ' +
             'nothing about it -- and it now pins the OPPOSITE: a page the caller controls plus the ' +
             'disclosure line that says the page is full and names the next one (#126). The line is what ' +
             'is pinned; the row count still is not, because row counts are data. Also carries this ' +
             'tool\'s populated-table contract, since the recorded `normal` case is excluded above.' },
    ],
  },
  {
    tool: 'get_crypto_exposure',
    cases: [
      { name: 'normal', arguments: {}, why: 'The whole ETF complex: three bold summary lines plus a table.' },
      { name: 'error', arguments: { unexpected: 'x' },
        why: 'There is no way to make this tool fail. Its input schema is `{}`, so an unexpected argument ' +
             'is dropped and the normal answer comes back -- and THAT is the contract worth pinning: if ' +
             'the SDK ever starts rejecting unknown arguments, every caller passing one starts failing.' },
    ],
  },
  {
    tool: 'get_crypto_holders',
    cases: [
      { name: 'normal', arguments: { product: 'IBIT', limit: 5 }, why: 'Holders of one product; limit honoured.' },
      { name: 'empty', arguments: { product: NO_SUCH_TICKER }, why: 'Heading, totals line, soft sentence.' },
      { name: 'error', arguments: { limit: 999 }, why: 'Above the clamp (max 200).' },
    ],
  },
  {
    tool: 'get_crypto_holder',
    cases: [
      { name: 'normal', arguments: { institution: BREVAN_HOWARD_CIK },
        why: 'A CIK. The recorded body has no "*Interpreted ... as ...*" preamble and names Brevan ' +
             'Howard Capital Management LP, which the name "Brevan Howard" does NOT resolve to (it ' +
             'resolves to Brevan Howard Investment Management Ltd, CIK 2080817, which holds no crypto ' +
             'ETF) -- so the recording used the CIK. The resolveInstitution name path is therefore NOT ' +
             'covered by this tool here; get_institution_holdings does not cover it either.' },
      { name: 'empty', arguments: { institution: '9999999' },
        why: 'A CIK with no crypto-ETF exposure -> 404. A never-issued CIK is used rather than a real ' +
             'institution that happens to hold none today, because the second kind can start holding one.' },
      { name: 'error', arguments: {}, why: 'Required `institution` missing.' },
    ],
  },
];

/**
 * The 4 macro tools free/demo callers cannot reach.
 *
 * Their `normal` and `empty` fixtures pin a 403 PLAN GATE and contain no data
 * whatsoever. That is a real contract and worth pinning -- the day the gate
 * stops returning 403 for an unauthenticated caller, a paid dataset is being
 * given away and this gate says so -- but it is NOT data coverage, and nobody
 * reading these fixtures later should mistake it for any. The data path of
 * these four tools is UNTESTED by this gate.
 *
 * Closing that needs a paid-tier ko.io key: at capture time `.secrets/` was
 * empty, `CLOUDFLARE_API_TOKEN` was unset and `wrangler whoami` reported not
 * logged in, so the QA Pro key (`qa_mcp_test_f7a2b3e7`, in prod D1) could not
 * be read. See docs/GOLDEN_CONTRACT.md, "What this gate does not prove".
 */
export const PLAN_GATED_TOOLS = CASES.filter((t) => t.planGated).map((t) => t.tool);

/** Every tool the gate replays. */
export const TOOLS = CASES.map((t) => t.tool);

/** Total number of replayed cases. */
export const CASE_COUNT = CASES.reduce((n, t) => n + t.cases.length, 0);
