#!/usr/bin/env node
/**
 * Drift check: is the pinned ko-api snapshot still what ko-api origin/main has?
 *
 *   KO_API_REPO=/path/to/ko-api npm run registry:check-upstream
 *
 * Exit codes
 *   0  every pinned blob SHA matches ko-api origin/main
 *   1  drift -- the message names each file's NEW SHA and the refresh command
 *   2  could not check (no ko-api checkout). NOT a pass: it says so and exits
 *      non-zero, because "checked nothing" must never read like "found nothing".
 *      Pass --allow-missing-repo to downgrade that to a loud warning for
 *      environments that genuinely cannot see ko-api (public CI has no
 *      credential for a private repo); the offline pin-age gate in `npm test`
 *      is what keeps staleness visible there.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findKoApiRepo, blobSha, commitSha } from './upstream-pin-lib.mjs';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/registry/upstream');
const pin = JSON.parse(readFileSync(resolve(OUT, 'pin.json'), 'utf8'));
const REV = process.env.KO_API_REV || pin.rev || 'origin/main';
const allowMissing = process.argv.includes('--allow-missing-repo');

const repo = findKoApiRepo();
if (!repo) {
  const msg =
    'UPSTREAM PIN NOT VERIFIED: no ko-api checkout found, so drift against ' +
    `${pin.koApiRepo} ${REV} was NOT checked.\n` +
    `  pinned commit : ${pin.commit}\n` +
    `  pinned on     : ${pin.pinnedAt}\n` +
    '  set KO_API_REPO=/path/to/ko-api to check for real.';
  if (allowMissing) { console.warn(`WARNING: ${msg}`); process.exit(0); }
  console.error(`FATAL: ${msg}`);
  process.exit(2);
}

const head = commitSha(repo, REV);
const drifted = [];
for (const [path, pinnedSha] of Object.entries(pin.files)) {
  let actual;
  try {
    actual = blobSha(repo, REV, path);
  } catch {
    drifted.push(`${path}: GONE from ko-api ${REV} (pinned ${pinnedSha})`);
    continue;
  }
  if (actual !== pinnedSha) drifted.push(`${path}\n    pinned ${pinnedSha}\n    now    ${actual}`);
}

if (drifted.length) {
  console.error(
    `UPSTREAM PIN IS STALE -- ${drifted.length} of ${Object.keys(pin.files).length} pinned ` +
    `ko-api file(s) changed.\n` +
    `  pinned commit : ${pin.commit}\n  ${REV} now    : ${head}\n\n` +
    `${drifted.join('\n')}\n\n` +
    'The cross-repo gates are asserting against bytes ko-api no longer serves. Refresh and read\n' +
    'the diff -- a changed route file can mean a param the tools send is now read, or no longer:\n' +
    `  KO_API_REPO=${repo} npm run registry:refresh-pin`,
  );
  process.exit(1);
}

console.log(
  `upstream pin OK: ${Object.keys(pin.files).length} ko-api files unchanged since ` +
  `${pin.commit.slice(0, 12)} (${REV} is now ${head.slice(0, 12)}).`,
);
