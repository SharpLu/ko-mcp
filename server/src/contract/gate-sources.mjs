/**
 * Reads the three files whose SHAPE the exit contract depends on.
 *
 * It lives in .mjs because tsconfig types only @cloudflare/workers-types --
 * this is a Worker project, so `node:fs` does not exist to tsc. The house
 * pattern for "a test needs the filesystem" is a .mjs module plus a .d.mts,
 * the same way cases.mjs is consumed by golden.test.ts.
 *
 * Paths resolve from the working directory; vitest.config.ts fixes cwd to
 * server/, so `scripts/` and `../.github/` are stable.
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function readGateSources() {
  const scripts = resolve('scripts');
  return {
    worker: readFileSync(join(scripts, 'lib/local-worker.mjs'), 'utf8'),
    gate: readFileSync(join(scripts, 'golden-gate.mjs'), 'utf8'),
    workflow: readFileSync(resolve('..', '.github/workflows/deploy-server.yml'), 'utf8'),
  };
}
