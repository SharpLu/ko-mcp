#!/usr/bin/env node
/**
 * Refresh the ko-api upstream pin.
 *
 *   KO_API_REPO=/path/to/ko-api npm run registry:refresh-pin
 *
 * Writes, under src/registry/upstream/:
 *   contract.json  the DERIVED contract for the routes ko-mcp calls: auth mode,
 *                  cache class, pagination, timeout budget and the query params
 *                  each handler actually reads, plus the free-plan blocked
 *                  prefixes
 *   pin.json       the ko-api commit, the git blob SHA of every source file the
 *                  contract was derived from, the pin date, and the SHA-256 of
 *                  contract.json
 *
 * WHY DERIVED AND NOT VERBATIM
 * ----------------------------
 * ko-mcp is a PUBLIC repository; ko-api is PRIVATE. Committing ko-api's
 * routes.ts / api-auth.ts verbatim -- the obvious way to make a pin
 * self-verifying -- would publish private source, so it is not an option here.
 * What is committed instead is only what the MCP server already exposes to the
 * internet on every call: the 24 public /api/v1 paths it proxies to, their
 * query-param names, and the plan gate a free caller can observe by getting a
 * 403. The pin records opaque blob SHAs of the private files, which disclose
 * nothing and are exactly what `check-upstream-pin.mjs` needs to prove the
 * derivation is still current.
 *
 * Reads ko-api at origin/main via `git show`, NEVER the working tree: local
 * checkouts drift from origin (KO CLAUDE.md), and a pin taken from a dirty tree
 * would record a SHA that exists nowhere.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DERIVED_FROM, SCANNED_ROUTE_FILES, MCP_UPSTREAM_ROUTES, findKoApiRepo, blobSha, fileAt,
  commitSha, splitHandlers, readParams, unscannableReads, parseRouteRegistry,
  parseFreeBlockedPrefixes,
} from './upstream-pin-lib.mjs';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/registry/upstream');
const REV = process.env.KO_API_REV || 'origin/main';

const repo = findKoApiRepo();
if (!repo) {
  console.error(
    'FATAL: no ko-api checkout found.\n' +
    'Set KO_API_REPO=/path/to/ko-api (a real git clone -- the pin records blob SHAs\n' +
    'and cannot be produced from a tarball or from the ko-api HTTP API).',
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const files = {};

// ── 1. the two declaration files: auth / cache / pagination / timeout + plans ─
const routesSrc = fileAt(repo, REV, DERIVED_FROM.routes);
const authSrc = fileAt(repo, REV, DERIVED_FROM.auth);
files[DERIVED_FROM.routes] = blobSha(repo, REV, DERIVED_FROM.routes);
files[DERIVED_FROM.auth] = blobSha(repo, REV, DERIVED_FROM.auth);

const allRoutes = parseRouteRegistry(routesSrc);
if (allRoutes.length < 100 || allRoutes.some((r) => !r.id || !r.path || !r.auth)) {
  console.error(`FATAL: routes.ts parser produced ${allRoutes.length} entries / incomplete fields.`);
  process.exit(1);
}
const freeBlockedPrefixes = parseFreeBlockedPrefixes(authSrc);
if (freeBlockedPrefixes.length === 0) {
  console.error('FATAL: api-auth.ts parser found no free blockedPrefixes.');
  process.exit(1);
}

// ── 2. handler-granular param reads for the routes ko-mcp calls ─────────────
const reads = {};
let handlerCount = 0;
for (const src of SCANNED_ROUTE_FILES) {
  const body = fileAt(repo, REV, src);
  const unscannable = unscannableReads(body);
  if (unscannable.length) {
    console.error(
      `FATAL: ${src} reads query params in a shape this scanner cannot see ` +
      `(${unscannable.join(', ')}).\nTeach scripts/upstream-pin-lib.mjs that shape ` +
      `before pinning -- an under-reported read turns the param gate into a rubber stamp.`,
    );
    process.exit(1);
  }
  files[src] = blobSha(repo, REV, src);
  for (const h of splitHandlers(body)) {
    handlerCount++;
    reads[`${h.method} ${h.path}`] = readParams(h.body);
  }
}

// ── 3. the contract: ONLY the routes ko-mcp proxies to ──────────────────────
const routes = {};
const missing = [];
for (const key of MCP_UPSTREAM_ROUTES) {
  const [method, path] = key.split(' ');
  const spec = allRoutes.find((r) => r.method === method && r.path === path);
  if (!spec) { missing.push(`${key}: not in the ko-api route registry`); continue; }
  if (!(key in reads)) { missing.push(`${key}: no handler scanned (add its file to SCANNED_ROUTE_FILES)`); continue; }
  routes[key] = {
    auth: spec.auth,
    cache: spec.cache,
    pagination: spec.pagination,
    timeoutMs: spec.timeoutMs,
    readParams: reads[key],
  };
}
if (missing.length) {
  console.error(`FATAL: cannot pin the contract:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const contract = {
  _comment:
    'DERIVED from ko-api at the commit in pin.json -- do not hand-edit; ' +
    'src/__tests__/registry/upstream-pin.test.ts hashes this file and compares it with ' +
    'pin.json.contractSha256. Regenerate with: npm run registry:refresh-pin.',
  koApiRepo: 'SharpLu/ko-api',
  koApiCommit: commitSha(repo, REV),
  /** Scalar only: the ko-api route inventory itself stays in the private repo. */
  sourceRouteCount: allRoutes.length,
  freeBlockedPrefixes,
  routes,
};
const contractJson = JSON.stringify(contract, null, 2) + '\n';
writeFileSync(resolve(OUT, 'contract.json'), contractJson);

const pin = {
  _comment:
    'Generated by scripts/refresh-upstream-pin.mjs. Do not hand-edit: the registry gates ' +
    'hash contract.json against contractSha256, and check-upstream-pin.mjs compares every ' +
    'blob SHA below with ko-api origin/main.',
  koApiRepo: 'SharpLu/ko-api',
  rev: REV,
  commit: commitSha(repo, REV),
  pinnedAt: new Date().toISOString().slice(0, 10),
  contractSha256: createHash('sha256').update(contractJson).digest('hex'),
  files,
};
writeFileSync(resolve(OUT, 'pin.json'), JSON.stringify(pin, null, 2) + '\n');

console.log(`pinned ko-api ${pin.commit.slice(0, 12)} (${REV})`);
console.log(`  routes in contract : ${Object.keys(routes).length}`);
console.log(`  source route count : ${allRoutes.length}`);
console.log(`  scanned files      : ${SCANNED_ROUTE_FILES.length} (${handlerCount} handlers)`);
console.log(`  free blocked       : ${freeBlockedPrefixes.length} prefixes`);
console.log(`  blob SHAs recorded : ${Object.keys(files).length}`);
