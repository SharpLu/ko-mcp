#!/usr/bin/env node
/**
 * BLOCKING golden contract gate -- runs BEFORE the deploy.
 *
 *   node scripts/golden-gate.mjs
 *
 * Boots the Worker built from this working tree on loopback, replays every
 * pinned case, and exits non-zero if the CONTRACT of any tools/call response
 * moved: the envelope shape, isError, the content-block type, a heading, a bold
 * label, a table's column list, a section order, or the class of an error.
 *
 * It is the gate the old verify step could not be. `tools/list >= 24` counts
 * names; it is satisfied by a Worker that renders every table with a header and
 * no body, which is precisely what happens when ko-api renames a field
 * upstream.
 *
 * WHY THIS GATE CANNOT GRADE A STALE ARTEFACT
 * -------------------------------------------
 * ko-api#231: its golden gate probed a public URL, Cloudflare served
 * `cf-cache-status: HIT, age: 15290`, and the gate graded the PREVIOUS deploy
 * while reporting on the new one. The fix there was to purge the edge first --
 * a mitigation that depends on remembering to do it.
 *
 * Here staleness is not mitigated, it is unreachable:
 *
 *   1. The thing under test is a process this script starts, from a bundle
 *      built out of the working tree, on an ephemeral loopback port, and kills
 *      on the way out. There is no published version of it anywhere.
 *   2. `assertLoopback` in src/contract/skeleton.mjs REFUSES any base that is
 *      not 127.0.0.1/localhost/[::1]. Pointing this gate at mcp.ko.io is not a
 *      configuration option.
 *   3. It runs before `wrangler versions upload`, so red means nothing shipped,
 *      and there is no deployed build for it to confuse with this one.
 *
 * There is still a network call underneath -- the Worker calls api.ko.io, which
 * is the dependency it exists to proxy -- and api.ko.io's own edge cache may
 * well answer it. That cannot make this gate stale: a cached ko-api response is
 * a response from the same contract, and the gate compares contract, never
 * values. See "the second property" in docs/GOLDEN_CONTRACT.md.
 *
 * Exit codes: 0 intact, 1 contract moved / defect fixed / worker unreachable.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures, runGoldenGate } from '../src/contract/skeleton.mjs';
import { CASES, CASE_COUNT, EXCLUDED, PLAN_GATED_TOOLS } from '../src/contract/cases.mjs';
import { startLocalWorker } from './lib/local-worker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..');
const DIR = join(SERVER, 'src', 'contract', 'golden');

const fixtures = await loadFixtures(DIR);
const pinnedCases = fixtures.reduce((n, f) => n + f.cases.length, 0);

// A gate that examined nothing is not a pass. Both halves are asserted against
// the manifest so a fixture directory that silently emptied out, or a manifest
// entry that never got captured, fails here instead of passing vacuously.
if (fixtures.length !== CASES.length || pinnedCases !== CASE_COUNT) {
  console.error(
    `golden gate: fixtures (${fixtures.length} tools / ${pinnedCases} cases) do not match the manifest ` +
    `(${CASES.length} tools / ${CASE_COUNT} cases). Run: npm run golden:capture`,
  );
  process.exit(1);
}

console.log(`golden gate: ${fixtures.length} tools, ${pinnedCases} cases pinned, ${Object.keys(EXCLUDED).length} excluded`);
console.log(`             ${PLAN_GATED_TOOLS.length} plan-gated tools pin a 403 GATE, not data: ${PLAN_GATED_TOOLS.join(', ')}`);

const worker = await startLocalWorker({ cwd: SERVER });
console.log(`             worker under test: ${worker.base} (built from this working tree, this job)`);

let result;
try {
  result = await runGoldenGate(fixtures, { base: worker.base });
} finally {
  worker.stop();
}

const { checked, failures, unreachable, defectsFixed, defectsPresent } = result;

console.log(`\nchecked ${checked}/${pinnedCases} cases`);

if (defectsPresent.length) {
  console.log(`\n${defectsPresent.length} annotated known defects still present (expected):`);
  for (const d of defectsPresent) console.log(`  - ${d.tool} [${d.case}] ${d.issue}`);
}

let bad = false;

if (unreachable.length) {
  bad = true;
  console.error(`\n${unreachable.length} case(s) the local worker did not answer:`);
  for (const u of unreachable) console.error(`  - ${u.tool} [${u.case}]: ${u.err}`);
  console.error('  The build under test did not serve these. That is a failure, not an excuse.');
}

if (failures.length) {
  bad = true;
  console.error(`\nCONTRACT MOVED in ${failures.length} case(s):`);
  for (const f of failures) {
    console.error(`  ${f.tool} [${f.case}]`);
    for (const p of f.problems) console.error(`      ${p}`);
  }
  console.error(
    '\n  Values are never compared, so this is not a data change. Either a tool rendering was edited on ' +
    'purpose -- re-pin with `npm run golden:capture`, in the SAME PR -- or ko-api changed its JSON ' +
    'underneath this Worker, which is the regression this gate exists to catch.',
  );
}

if (defectsFixed.length) {
  bad = true;
  console.error(`\n${defectsFixed.length} KNOWN DEFECT(S) APPEAR TO BE FIXED -- re-pin deliberately:`);
  for (const d of defectsFixed) {
    console.error(`  ${d.tool} [${d.case}] ${d.issue}`);
    console.error(`      ${d.why}`);
  }
  console.error(
    '\n  These fixtures carry an annotation saying the output is WRONG today, so that fixing the bug ' +
    'fails here instead of passing silently. If you fixed it: delete the knownDefect block in ' +
    'src/contract/cases.mjs, run `npm run golden:capture`, and close the issue in the same PR.',
  );
}

if (bad) process.exit(1);
console.log('\ngolden gate: contract intact.');
// Exit EXPLICITLY. Falling off the end waits for the event loop to drain, and
// on 2026-09-12 a surviving wrangler child kept this process alive for 25.9
// minutes after this very line printed -- a deploy step that had already done
// its job and reported success, blocking the lane with no signal at all.
// Every failure path above calls process.exit; success must too.
process.exit(0);
