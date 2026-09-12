/**
 * The gate must END, not merely finish.
 *
 * 2026-09-12: a deploy of main ran `npm run golden:gate`, which printed
 * "checked 70/70 cases" and "golden gate: contract intact." SEVEN SECONDS after
 * it started -- and then held the step for 25.9 minutes until it was cancelled
 * by hand. The runner's cleanup named the survivors:
 *
 *   Terminate orphan process: pid (2635) (npm run golden:gate)
 *   Terminate orphan process: pid (2646) (sh)
 *
 * Two causes, both here in source rather than in the environment:
 *
 *   1. `spawn('npx', ['wrangler','dev',...])` without `detached`, stopped with
 *      `child.kill()`. That signals npx. wrangler and workerd are grandchildren
 *      and survive, holding the port and the stdio pipes open.
 *   2. golden-gate.mjs called process.exit(1) on every FAILURE path and nothing
 *      on success, so a green run fell off the end and waited on those handles.
 *
 * A green run that never returns is worse than a red one: the deploy lane stays
 * open with no signal, and "still running" is indistinguishable from "working".
 * These assertions are static on purpose -- they hold without booting anything.
 */
import { describe, it, expect } from 'vitest';
import { readGateSources } from '../../contract/gate-sources.mjs';

const { worker, gate, workflow } = readGateSources();

describe('the golden gate must exit', () => {
  it('spawns the worker detached, so the whole process group can be signalled', () => {
    expect(worker).toMatch(/detached:\s*true/);
  });

  it('kills the process GROUP, not just the direct child', () => {
    // A negative pid is the group. Without it, npx dies and workerd does not.
    expect(worker).toMatch(/process\.kill\(\s*-\s*child\.pid/);
  });

  it('escalates to SIGKILL, so a wrangler that ignores SIGTERM cannot outlive it', () => {
    expect(worker).toMatch(/SIGTERM/);
    expect(worker).toMatch(/SIGKILL/);
  });

  it('never lets its own escalation timer hold the event loop open', () => {
    expect(worker).toMatch(/unref\(\)/);
  });

  it('exits explicitly on SUCCESS, not only on failure', () => {
    // The regression was precisely an asymmetry: exit(1) on every red path,
    // nothing on green.
    expect(gate).toMatch(/golden gate: contract intact/);
    const afterSuccess = gate.slice(gate.indexOf('golden gate: contract intact'));
    expect(afterSuccess).toMatch(/process\.exit\(0\)/);
  });

  it('the deploy step carries a timeout backstop', () => {
    const wf = workflow;
    // Anchor on the STEP, not on the phrase: the file also carries a section
    // comment containing "Golden contract gate", and indexOf would find that
    // first -- a test that reads the wrong 400 characters and reports on them.
    const at = wf.indexOf('- name: Golden contract gate');
    expect(at, 'the gate step was renamed; this assertion is now blind').toBeGreaterThan(-1);
    expect(wf.slice(at, at + 400)).toMatch(/timeout-minutes:\s*\d+/);
  });
});
