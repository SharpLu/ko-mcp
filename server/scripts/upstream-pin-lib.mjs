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
  'GET /api/v1/executive-trades/:ticker',
  'GET /api/v1/insider-trades',
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
  'src/routes/v1/executive-trades.ts',
  'src/routes/v1/insider-trades.ts',
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
];

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
 * defect ko-bastion#125.
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

/** Query-param names a handler body actually reads. */
export function readParams(body) {
  const found = new Set();
  const patterns = [
    /(?:sp|searchParams|params|query|qs)\s*\.get\(\s*['"]([\w.\-]+)['"]/g,
    /c\.req\.query\(\s*['"]([\w.\-]+)['"]/g,
    /c\.req\.queries\(\s*['"]([\w.\-]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(body)) !== null) found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Shapes this scanner CANNOT see. Hitting one means the generated surface would
 * silently under-report reads, so the generator refuses to write instead.
 */
export function unscannableReads(source) {
  const bad = [];
  if (/c\.req\.query\(\s*\)/.test(source)) bad.push('bare c.req.query() destructuring');
  if (/(?:sp|searchParams)\s*\.get\(\s*[A-Za-z_$][\w$]*\s*\)/.test(source)) bad.push('searchParams.get(<variable>)');
  if (/c\.req\.query\(\s*[A-Za-z_$][\w$]*\s*\)/.test(source)) bad.push('c.req.query(<variable>)');
  return bad;
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

/** Parse PLAN_GATES.free.blockedPrefixes out of a verbatim ko-api api-auth.ts. */
export function parseFreeBlockedPrefixes(source) {
  const m = source.match(/free:\s*\{[\s\S]*?blockedPrefixes:\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('PLAN_GATES.free.blockedPrefixes not found in snapshot');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
