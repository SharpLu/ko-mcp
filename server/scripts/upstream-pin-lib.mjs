/**
 * Shared helpers for the ko-api upstream pin (refresh + drift check).
 *
 * Everything here is plain Node ESM on purpose: it runs OUTSIDE the Worker
 * bundle and outside `tsc`, so it may use child_process/fs, which the Worker
 * (and therefore src/) may not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The two ko-api DECLARATION files the contract is derived from. Their bytes
 * stay in the private repo (ko-mcp is public); only their blob SHAs are pinned.
 */
export const DERIVED_FROM = {
  routes: 'src/registry/routes.ts',
  auth: 'src/lib/api-auth.ts',
  // Since ko-api's entitlements refactor, PLAN_GATES in api-auth.ts is a
  // DERIVED view and the free plan's blockedPrefixes live here.
  catalog: 'src/lib/entitlements/catalog.ts',
};

/**
 * The ko-api routes ko-mcp proxies to -- the only ones that enter the public
 * contract. Must equal the distinct paths declared in src/registry/tools.ts;
 * the generator fails if one of these is not in the ko-api registry, and the
 * gates fail if a tool declares a route that is not pinned here.
 */
export const MCP_UPSTREAM_ROUTES = [
  'GET /api/v1/institutions',
  'GET /api/v1/holdings/:cik',
  'GET /api/v1/stocks/:ticker',
  'GET /api/v1/stocks/:ticker/financials/historical',
  'GET /api/v1/stock-holders/:ticker',
  'GET /api/v1/stock-price/:ticker',
  'GET /api/v1/insider-trades',
  'GET /api/v1/insider/:cik/transactions',
  'GET /api/v1/congress-trades',
  'GET /api/v1/congress-trades/:member',
  'GET /api/v1/search',
  'GET /api/v1/form144-notices',
  'GET /api/v1/filings/:cik',
  'GET /api/v1/filings/:cik/:accession',
  'GET /api/v1/filings/:cik/:accession/share',
  'GET /api/v1/filings/:cik/:accession/file',
  'GET /api/v1/treasury/yields',
  'GET /api/v1/fed/rates',
  'GET /api/v1/economic/indicators',
  'GET /api/v1/sec/ftd',
  'GET /api/v1/stress/ofr',
  'GET /api/v1/crypto/exposure-summary',
  'GET /api/v1/crypto/institutional-holders',
  'GET /api/v1/crypto/holder/:cik',
  'GET /api/v1/eu/markets',
  'GET /api/v1/eu/:country/insider-dealings',
  'GET /api/v1/eu/:country/major-holdings',
  'GET /api/v1/eu/:country/short-positions',
  'GET /api/v1/eu/:country/annual-reports',
  'GET /api/v1/eu/:country/issuers/:issuer',
];

/**
 * ko-api route files whose handlers are scanned for query-param reads.
 * Derived from the `file` field of the registry entries the 24 MCP tools call
 * (plus resolve.ts's /institutions leg) -- keep in sync via
 * `npm run registry:refresh-pin`, which fails if a route in the MCP registry
 * maps to a file that is not listed here.
 */
export const SCANNED_ROUTE_FILES = [
  'src/routes/v1/institutions.ts',
  'src/routes/v1/holdings.ts',
  'src/routes/v1/stock.ts',
  'src/routes/v1/stock-holders.ts',
  'src/routes/v1/stock-price.ts',
  'src/routes/v1/insider-trades.ts',
  'src/routes/v1/insider.ts',
  'src/routes/v1/congress-trades.ts',
  'src/routes/v1/congress-member.ts',
  'src/routes/v1/search.ts',
  'src/routes/v1/form144-notices.ts',
  'src/routes/v1/filings.ts',
  'src/routes/v1/stock-financials-history.ts',
  'src/routes/v1/treasury-yields.ts',
  'src/routes/v1/fed-rates.ts',
  'src/routes/v1/economic-indicators.ts',
  'src/routes/v1/sec-ftd.ts',
  'src/routes/v1/financial-stress.ts',
  'src/routes/v1/crypto.ts',
  'src/routes/v1/eu.ts',
];

/**
 * ko-api helpers that read query params on a handler's behalf. A handler that
 * calls `pageSizeParam(sp)` reads `per_page` AND its alias `limit`, but no
 * `sp.get('limit')` appears in the handler body -- so without this table the
 * scanner under-reports exactly the row-count params gate (d)/(e) care about.
 *
 * Each helper is RESOLVED, not hard-coded: the generator reads the helper's
 * own body from `file` at the pinned rev, scans it with the same readParams()
 * patterns, and pins the file's blob SHA, so a helper that starts reading a
 * different param shows up as drift like any route file.
 *
 * A handler that passes its URLSearchParams to a function NOT listed here is
 * unscannable (unscannableReads) and the generator refuses to pin.
 */
export const PARAM_HELPERS = {
  pageSizeParam: 'src/lib/pagination.ts',
};

/** Locate a ko-api checkout, or return null. Never guesses silently. */
export function findKoApiRepo() {
  const candidates = [
    process.env.KO_API_REPO,
    resolve(process.cwd(), '../../ko-api'),
    resolve(process.cwd(), '../../../ko-api'),
    process.env.GITHUB_WORKSPACE ? resolve(process.env.GITHUB_WORKSPACE, '../ko-api') : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(resolve(c, '.git')) || existsSync(resolve(c, 'src/registry/routes.ts'))) return resolve(c);
  }
  return null;
}

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Blob SHA of `path` at `rev` -- the identity the pin records. */
export function blobSha(repo, rev, path) {
  return git(repo, ['rev-parse', `${rev}:${path}`]).trim();
}

/** File CONTENT at `rev`, never the working tree (local checkouts drift). */
export function fileAt(repo, rev, path) {
  return git(repo, ['show', `${rev}:${path}`]);
}

export function commitSha(repo, rev) {
  return git(repo, ['rev-parse', rev]).trim();
}

/**
 * Split a Hono route file into per-handler bodies by brace-matching the
 * `app.get('<path>', ...)` callback. HANDLER granularity, not file granularity:
 * ko-api's own registry declares `tables` per file, but a param read by a
 * SIBLING handler is not a param this route reads -- `/insider-trades/summary`
 * reads `search`, `/insider-trades` does not, and that difference is exactly
 * defect internal#125.
 */
export function splitHandlers(source) {
  const out = [];
  const re = /app\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const [, method, path] = m;
    // Walk from the end of the match to the matching close-paren of app.get(.
    let depth = 1; // the '(' of app.get(
    let i = m.index + m[0].length - 1; // at the ','
    let inS = null, esc = false, inLine = false, inBlock = false;
    for (; i < source.length; i++) {
      const ch = source[i], prev = source[i - 1];
      if (esc) { esc = false; continue; }
      if (inS) { if (ch === '\\') esc = true; else if (ch === inS) inS = null; continue; }
      if (inLine) { if (ch === '\n') inLine = false; continue; }
      if (inBlock) { if (prev === '*' && ch === '/') inBlock = false; continue; }
      if (ch === '/' && source[i + 1] === '/') { inLine = true; continue; }
      if (ch === '/' && source[i + 1] === '*') { inBlock = true; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inS = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    out.push({ method: method.toUpperCase(), path, body: source.slice(m.index, i + 1) });
  }
  return out;
}

/** The names a handler may bind its URLSearchParams to and still be scanned. */
const SP_NAMES = ['sp', 'searchParams', 'params', 'query', 'qs'];

/**
 * Query-param names a handler body actually reads: direct reads, plus the
 * reads of every PARAM_HELPERS helper it calls (`helperReads`: name -> params,
 * from resolveHelperReads()).
 */
export function readParams(body, helperReads = {}) {
  const found = new Set();
  const patterns = [
    new RegExp(`(?:${SP_NAMES.join('|')})\\s*\\.get\\(\\s*['"]([\\w.\\-]+)['"]`, 'g'),
    /c\.req\.query\(\s*['"]([\w.\-]+)['"]/g,
    /c\.req\.queries\(\s*['"]([\w.\-]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) !== null) found.add(m[1]);
  }
  for (const [name, params] of Object.entries(helperReads)) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(body)) for (const p of params) found.add(p);
  }
  return [...found].sort();
}

/**
 * The body of `export function <name>(...) { ... }` in a ko-api source file
 * (any `function <name>` with `exported: false`), brace-matched. Throws when the declaration is not found -- a helper that
 * moved or was renamed must not silently resolve to "reads nothing".
 *
 * Fails closed on every shape where "the first declaration" might not be the
 * implementation (review of ko-mcp #35, nit h):
 *   - more than one declaration of `name` (TS overload signatures, or a
 *     redeclaration): refuses rather than guessing which one has the body;
 *   - a bodiless signature (`function f(a: string): T;`): refuses rather than
 *     brace-matching whatever block happens to come next.
 * The parameter list is paren-balanced, so a callback-typed parameter
 * (`cb: () => void`) cannot end it early, and a return-type annotation is
 * skipped bracket-balanced up to the real body (bodyOpen()), so an object
 * return type (`function f(a): { x: number } {`) cannot pose as the body
 * (review of ko-mcp #36, nit 2). Generic (`function f<T>(`) and `async`
 * declarations are not matched at all and throw "not found" (fail-closed).
 */
export function functionBody(source, name, { exported = true } = {}) {
  const decl = exported ? `export\\s+function\\s+${name}\\s*\\(` : `(?:^|\\n)(?:export\\s+)?function\\s+${name}\\s*\\(`;
  const hits = [...source.matchAll(new RegExp(decl, 'g'))];
  if (!hits.length) throw new Error(`helper ${name}() not found`);
  if (hits.length > 1) {
    throw new Error(`helper ${name}() is declared ${hits.length} times (overloads?); refusing to guess which body is the implementation`);
  }
  const m = hits[0];
  // The pattern ends at the parameter list's opening paren; balance it.
  let close = -1;
  for (let i = m.index + m[0].length - 1, depth = 0; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) { close = i; break; }
  }
  if (close < 0) throw new Error(`helper ${name}() has an unterminated parameter list`);
  const open = bodyOpen(source, close, name);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(m.index, i + 1);
  }
  throw new Error(`helper ${name}() has no closing brace`);
}

// Words after which a TS type position is still open (`A extends {`, `keyof {`).
const TYPE_CONTINUATION_WORDS = new Set(['extends', 'keyof', 'typeof', 'infer', 'readonly', 'unique', 'asserts', 'is', 'new']);

/**
 * Index of the body's `{` for a declaration whose parameter list closes at
 * `close`. Without a return-type annotation that is the next non-blank char.
 * With one (`): <type> {`), the type is walked bracket-balanced over (), [],
 * {}, <> (skipping strings and comments), and a depth-0 `{` opens the body
 * only where a complete type has just ended -- a `{` where a type is still
 * expected (right after `:`, `|`, `&`, `=>`, `extends` ...) is an object
 * type literal and is skipped like any other bracket. A depth-0 `;`, or
 * anything else before the body, means a bodiless signature.
 */
function bodyOpen(source, close, name) {
  const noBody = () => new Error(`helper ${name}() has no body`);
  let i = close + 1;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] === '{') return i;
  if (source[i] !== ':') throw noBody();
  let depth = 0;
  let expectType = true;
  for (i += 1; i < source.length; i++) {
    const ch = source[i];
    if (/\s/.test(ch)) continue;
    if (ch === '/' && source[i + 1] === '/') { const nl = source.indexOf('\n', i); i = nl < 0 ? source.length : nl; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); if (end < 0) break; i = end + 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === '\\' ? 2 : 1;
      i = j;
      expectType = false;
      continue;
    }
    if (depth === 0 && ch === '{' && !expectType) return i;
    if (depth === 0 && ch === ';') throw noBody();
    if (ch === '>' && source[i - 1] === '=') { expectType = true; continue; } // `=>`, not a closer
    if ('([{<'.includes(ch)) { depth++; expectType = true; continue; }
    if (')]}>'.includes(ch)) {
      if (--depth < 0) throw noBody();
      expectType = false;
      continue;
    }
    if ('|&:?,='.includes(ch)) { expectType = true; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))[0];
      expectType = TYPE_CONTINUATION_WORDS.has(word);
      i += word.length - 1;
      continue;
    }
    expectType = false; // digits, `.`, `-`, ...
  }
  throw noBody();
}

/**
 * Resolve PARAM_HELPERS against helper sources (`sourceOf(file)` -> text):
 * name -> sorted params its body reads. A helper whose body reads nothing the
 * scanner can see is an error, never an empty list.
 */
export function resolveHelperReads(sourceOf) {
  const out = {};
  for (const [name, file] of Object.entries(PARAM_HELPERS)) {
    const body = functionBody(sourceOf(file), name);
    const bad = unscannableReads(body, {});
    if (bad.length) throw new Error(`helper ${name}() in ${file} reads params in an unscannable shape (${bad.join(', ')})`);
    const params = readParams(body);
    if (!params.length) throw new Error(`helper ${name}() in ${file}: no param reads found`);
    out[name] = params;
  }
  return out;
}

/**
 * A handler registered through a same-file FACTORY:
 *
 *   app.get('/api/v1/eu/:country/insider-dealings', listHandler('pdmr_dealings'));
 *
 * The `app.get(...)` body then holds no reads at all -- they live in
 * `function listHandler(...)` -- so without this the scanner would pin the
 * route as reading nothing and gate (d) would call every param inert.
 *
 * Returns the factory's name only for exactly that shape (the handler is one
 * call whose arguments contain no parentheses, and it is the last argument);
 * the caller resolves it with functionBody(source, name, { exported: false })
 * and must refuse to pin when the factory is not declared in the same file.
 */
export function handlerFactory(handlerBody) {
  const m = /^app\.\w+\(\s*'[^']+'\s*,\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\)$/.exec(handlerBody.trim());
  return m ? m[1] : null;
}

/**
 * Shapes this scanner CANNOT see. Hitting one means the generated surface would
 * silently under-report reads, so the generator refuses to write instead.
 */
export function unscannableReads(source, helpers = PARAM_HELPERS) {
  const bad = [];
  if (/c\.req\.query\(\s*\)/.test(source)) bad.push('bare c.req.query() destructuring');
  if (/(?:sp|searchParams)\s*\.get\(\s*[A-Za-z_$][\w$]*\s*\)/.test(source)) bad.push('searchParams.get(<variable>)');
  if (/c\.req\.query\(\s*[A-Za-z_$][\w$]*\s*\)/.test(source)) bad.push('c.req.query(<variable>)');
  // URLSearchParams bound to a name readParams() does not scan (`const q = url.searchParams; q.get('x')`).
  const bound = [];
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.searchParams\s*[;\n]/g)) {
    if (!SP_NAMES.includes(m[1])) bad.push(`URLSearchParams bound to "${m[1]}"`);
    bound.push(m[1]);
  }
  // URLSearchParams handed to a function: its reads are invisible here unless
  // the function is a resolved PARAM_HELPERS entry. Only names actually bound
  // to `.searchParams` count (`params` is also ko-api's ClickHouse bind map),
  // plus the inline `new URL(c.req.url).searchParams` / `<x>.searchParams`.
  const spArg = `(?:${[...bound, 'new\\s+URL\\(c\\.req(?:\\.raw)?\\.url\\)\\.searchParams', '[A-Za-z_$][\\w$]*\\.searchParams'].join('|')})`;
  for (const m of source.matchAll(new RegExp(`([A-Za-z_$][\\w$.]*)\\s*\\(\\s*${spArg}\\s*[,)]`, 'g'))) {
    const fn = m[1];
    if (fn in helpers) continue;
    bad.push(`URLSearchParams passed to ${fn}()`);
  }
  return [...new Set(bad)];
}

/** Parse ROUTE_REGISTRY out of a verbatim ko-api routes.ts. */
export function parseRouteRegistry(source) {
  const start = source.indexOf('export const ROUTE_REGISTRY');
  if (start < 0) throw new Error('ROUTE_REGISTRY not found in snapshot');
  const end = source.indexOf('\n];', start);
  if (end < 0) throw new Error('ROUTE_REGISTRY terminator not found');
  const region = source.slice(start, end);
  const chunks = region.split(/\n  \{\n/).slice(1);
  return chunks.map((chunk) => {
    const one = (re) => { const m = chunk.match(re); return m ? m[1] : null; };
    const pag = chunk.match(/pagination:\s*\{\s*style:\s*'([^']+)',\s*params:\s*\[([^\]]*)\]/);
    return {
      id: one(/\bid:\s*'([^']+)'/),
      method: one(/\bmethod:\s*'([^']+)'/),
      path: one(/\bpath:\s*'([^']+)'/),
      file: one(/\bfile:\s*'([^']+)'/),
      auth: one(/\bauth:\s*'([^']+)'/),
      cache: one(/\bcache:\s*'([^']+)'/),
      pagination: pag
        ? { style: pag[1], params: [...pag[2].matchAll(/'([^']+)'/g)].map((m) => m[1]) }
        : null,
      timeoutMs: Number(one(/timeoutMs:\s*(\d+)/)),
    };
  });
}

/**
 * Parse the free plan's blockedPrefixes.
 *
 * Two layouts, both verbatim ko-api:
 *   - legacy: api-auth.ts `PLAN_GATES = { free: { ..., blockedPrefixes: ['...'] } }`
 *   - current: api-auth.ts derives PLAN_GATES from lib/entitlements/catalog.ts,
 *     where `free: { ... gate: { ..., blockedPrefixes: FREE_BLOCKED } }` names a
 *     `const FREE_BLOCKED = [...] as const` declared in the same file.
 * Pass the catalog source as the second argument; it is tried only when the
 * legacy literal is absent, and a layout neither parser recognises throws
 * rather than pinning an empty list.
 */
export function parseFreeBlockedPrefixes(authSource, catalogSource = null) {
  const legacy = authSource.match(/free:\s*\{[^}]*?blockedPrefixes:\s*\[([\s\S]*?)\]/);
  if (legacy) return [...legacy[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (catalogSource) {
    const free = catalogSource.match(/\bfree:\s*\{[\s\S]*?gate:\s*\{[^}]*?blockedPrefixes:\s*([A-Za-z_$][\w$]*|\[[\s\S]*?\])/);
    if (free) {
      let list = free[1];
      if (!list.startsWith('[')) {
        const decl = catalogSource.match(new RegExp(`const\\s+${list}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
        if (!decl) throw new Error(`catalog.ts: free gate names ${list}, but its declaration was not found`);
        list = `[${decl[1]}]`;
      }
      const out = [...list.matchAll(/'([^']+)'/g)].map((x) => x[1]);
      if (out.length) return out;
    }
  }
  throw new Error('PLAN_GATES.free.blockedPrefixes not found in snapshot (neither api-auth.ts nor entitlements/catalog.ts)');
}
