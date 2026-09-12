#!/usr/bin/env node
/**
 * Re-pin the golden contract fixtures.
 *
 *   node scripts/golden-capture.mjs
 *       Boot the Worker built from this working tree on loopback, replay every
 *       case in src/contract/cases.mjs TWICE, and write a fixture only when the
 *       two probes agree. This is the normal refresh.
 *
 *   node scripts/golden-capture.mjs --tool <name> [--tool <name> ...]
 *       Re-pin ONLY the named tools, from the build, leaving every other
 *       fixture on disk untouched. Added 2026-09-12 with ko-bastion#127: that
 *       PR re-pins one case, and without a filter the only way to do it was a
 *       full sweep, which rewrites all 24 files' `provenance` from `recordings`
 *       to `build` and buries a one-case change in a 24-file diff. A reviewer
 *       who cannot see what moved cannot judge whether it should have.
 *
 *   node scripts/golden-capture.mjs --from-recordings <dir>
 *       Derive the fixtures from a directory of verbatim JSON-RPC response
 *       bodies named <tool>.<case>.json. Used once, to seed these fixtures from
 *       the M0 audit's 2026-09-12 capture of mcp.ko.io without re-calling
 *       production. There is no double-probe in this mode -- the bodies are
 *       already fixed on disk -- so the mode is recorded in the fixture's
 *       provenance and the reviewer is told which one produced it.
 *
 * WHEN RE-RECORDING IS LEGITIMATE
 * -------------------------------
 * Only when the CONTRACT actually changed and the change was intended:
 *
 *   - a tool's rendering was deliberately edited (a column added, a heading
 *     reworded, an empty result turned from a headed table into a sentence);
 *   - a tool's input schema changed, so its zod -32602 body changed with it;
 *   - a known defect was FIXED, which the gate reports by name and issue.
 *
 * A diff you did not intend is a regression. In particular a column that
 * vanished, a section that stopped rendering, an isError that flipped, or a
 * table that became a sentence is ko-api changing its JSON under this Worker --
 * the exact failure the gate exists to catch. Re-recording it makes the bug the
 * contract. Read docs/GOLDEN_CONTRACT.md before running this with a red gate on
 * screen.
 *
 * WHO RE-PINS: whoever is shipping the change that moved the contract, in the
 * same PR, with the diff of src/contract/golden/*.json visible in review. Never
 * a follow-up commit, never a separate PR, and never someone clearing a red
 * build they did not cause.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, EXCLUDED, CASE_COUNT } from '../src/contract/cases.mjs';
import { contractOf, callTool, firstText, diffContract, rawValuesIn } from '../src/contract/skeleton.mjs';
import { startLocalWorker } from './lib/local-worker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..');
const OUT = join(SERVER, 'src', 'contract', 'golden');

const argv = process.argv.slice(2);
const fromIdx = argv.indexOf('--from-recordings');
const RECORDINGS = fromIdx >= 0 ? argv[fromIdx + 1] : null;

/** `--tool x --tool y` -> re-pin only those. Empty means every tool. */
const ONLY = argv.flatMap((a, i) => (a === '--tool' ? [argv[i + 1]] : []));
for (const t of ONLY) {
  if (!CASES.some((c) => c.tool === t)) {
    console.error(`--tool ${t}: not a tool in src/contract/cases.mjs`);
    process.exit(1);
  }
}
const SELECTED = ONLY.length ? CASES.filter((c) => ONLY.includes(c.tool)) : CASES;

mkdirSync(OUT, { recursive: true });

function fixtureFile(tool) {
  return join(OUT, `${tool}.json`);
}

async function captureFromRecordings(dir) {
  const written = [];
  for (const spec of SELECTED) {
    const cases = [];
    for (const c of spec.cases) {
      const file = join(dir, `${spec.tool}.${c.recordedAs || c.name}.json`);
      if (!existsSync(file)) throw new Error(`no recording for ${spec.tool}.${c.recordedAs || c.name} at ${file}`);
      const body = JSON.parse(readFileSync(file, 'utf8'));
      cases.push(buildCase(spec, c, contractOf(body)));
    }
    written.push(write(spec, cases, {
      source: dir,
      mode: 'recordings',
      note: 'Verbatim JSON-RPC bodies captured from https://mcp.ko.io by the M0 audit on 2026-09-12; ' +
            'pretty-printed only, never edited. Arguments were reconstructed into src/contract/cases.mjs ' +
            'and confirmed by replaying each one against a locally built Worker.',
    }));
  }
  return written;
}

async function captureFromBuild() {
  const worker = await startLocalWorker({ cwd: SERVER });
  console.log(`local worker up at ${worker.base}`);
  const written = [];
  try {
    for (const spec of SELECTED) {
      const cases = [];
      for (const c of spec.cases) {
        // TWO independent probes. ko-api#236 pinned `meta.cached`, a field that
        // exists only on a cache hit: the capture happened to be cold, the gate
        // happened to be warm, and the build was byte-identical in between. A
        // field that is not stable across two calls is not a contract and must
        // not become one, so disagreement refuses the write instead of picking
        // a winner.
        const a = await probe(worker.base, spec.tool, c);
        const b = await probe(worker.base, spec.tool, c);
        const drift = diffContract(a, b);
        if (drift.length) {
          throw new Error(
            `${spec.tool}.${c.name}: two probes of the same case disagree, so this is not a contract:\n  ` +
            drift.join('\n  ') +
            `\nEither normalise the varying part in src/contract/skeleton.mjs or exclude the case in ` +
            `src/contract/cases.mjs with a reason.`,
          );
        }
        cases.push(buildCase(spec, c, a));
      }
      written.push(write(spec, cases, {
        source: worker.base,
        mode: 'build',
        note: 'Captured from the Worker built from this working tree, on loopback. Each case was probed ' +
              'twice and written only because the two probes agreed.',
      }));
    }
  } finally {
    worker.stop();
  }
  return written;
}

async function probe(base, tool, c) {
  const r = await callTool(base, tool, c.arguments);
  if (!r.ok) throw new Error(`${tool}.${c.name}: ${r.err}`);
  return contractOf(r.body);
}

function buildCase(spec, c, contract) {
  const leaked = contract.blocks.flatMap((b) => b.lines.flatMap((l) => rawValuesIn(l)));
  if (leaked.length) {
    throw new Error(
      `${spec.tool}.${c.name}: skeleton still carries raw values [${leaked.slice(0, 5).join(', ')}].\n` +
      `Every one of those moves on its own and would turn this gate into a coin flip (ko-api#236). ` +
      `Extend normalizeLine in src/contract/skeleton.mjs.`,
    );
  }
  const out = { name: c.name, arguments: c.arguments, why: c.why, contract };
  if (c.recordedAs) out.recordedAs = c.recordedAs;
  if (c.knownDefect) out.knownDefect = c.knownDefect;
  return out;
}

function write(spec, cases, provenance) {
  const fixture = {
    tool: spec.tool,
    planGated: Boolean(spec.planGated),
    capturedAt: new Date().toISOString().slice(0, 10),
    provenance,
    cases,
  };
  writeFileSync(fixtureFile(spec.tool), `${JSON.stringify(fixture, null, 2)}\n`);
  return spec.tool;
}

const written = RECORDINGS ? await captureFromRecordings(RECORDINGS) : await captureFromBuild();

const scope = ONLY.length ? `only ${ONLY.join(', ')} -- every other fixture left untouched` : `all ${CASE_COUNT} cases`;
console.log(`\nwrote ${written.length} fixtures to src/contract/golden/ (${scope})`);
console.log(`excluded cases (see src/contract/cases.mjs for the reasons): ${Object.keys(EXCLUDED).length}`);
for (const id of Object.keys(EXCLUDED)) console.log(`  - ${id}`);
