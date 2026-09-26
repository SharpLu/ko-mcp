import { describe, it, expect } from 'vitest';
import {
  UPSTREAM_PIN, UPSTREAM_CONTRACT, UPSTREAM_CONTRACT_RAW, sha256, pinAgeDays, MAX_PIN_AGE_DAYS,
} from '../../registry/upstream.js';

/**
 * THE PIN ITSELF -- blocking, and fully offline.
 *
 * A committed copy of another repo's contract is only trustworthy while someone
 * can tell it is current. ko-mcp is public and ko-api is private, so the
 * contract here is DERIVED (see src/registry/upstream.ts) and cannot be proven
 * byte-identical to ko-api offline. Two of the three defences live here; the
 * third, real drift detection against ko-api origin/main, needs a checkout and
 * runs as `npm run registry:check-upstream`.
 *
 *   SELF-CONSISTENCY  contract.json must hash to pin.json.contractSha256, so it
 *                     cannot be edited to make a contract gate green without
 *                     also rewriting the pin -- a deliberate, visible act.
 *   AGE               a pin nobody has refreshed within MAX_PIN_AGE_DAYS is red,
 *                     with the refresh command in the message. This is what
 *                     stops the contract rotting quietly on a CI box that has no
 *                     ko-api access.
 */

describe('ko-api pin integrity', () => {
  it('records a commit, a date, a contract hash and a SHA per source file', () => {
    expect(UPSTREAM_PIN.koApiRepo).toBe('SharpLu/ko-api');
    expect(UPSTREAM_PIN.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(UPSTREAM_PIN.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(UPSTREAM_PIN.contractSha256).toMatch(/^[0-9a-f]{64}$/);
    const shas = Object.values(UPSTREAM_PIN.files);
    expect(shas.length).toBe(22); // 3 declaration files (routes, api-auth, entitlements catalog) + 19 route files
    expect(shas.every((s) => /^[0-9a-f]{40}$/.test(s))).toBe(true);
  });

  it('contract.json hashes to the digest the pin records', async () => {
    const actual = await sha256(UPSTREAM_CONTRACT_RAW);
    expect(
      actual,
      `contract.json hashes to ${actual}, pin.json says ${UPSTREAM_PIN.contractSha256}. ` +
      'The contract was hand-edited, or the pin was updated without it. Regenerate both: ' +
      'KO_API_REPO=/path/to/ko-api npm run registry:refresh-pin',
    ).toBe(UPSTREAM_PIN.contractSha256);
  });

  it('the contract and the pin describe the same ko-api commit', () => {
    expect(UPSTREAM_CONTRACT.koApiCommit).toBe(UPSTREAM_PIN.commit);
  });

  it('pins every route the contract describes, and nothing outside the MCP surface', () => {
    const keys = Object.keys(UPSTREAM_CONTRACT.routes);
    expect(keys.length).toBe(24);
    expect(keys.every((k) => k.startsWith('GET /api/v1/'))).toBe(true);
    // Scalar only: the ko-api route inventory stays in the private repo.
    expect(UPSTREAM_CONTRACT.sourceRouteCount).toBe(176);
  });

  it(`the pin is younger than ${MAX_PIN_AGE_DAYS} days`, () => {
    const age = pinAgeDays();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(
      age,
      `The ko-api pin was taken ${age} days ago (${UPSTREAM_PIN.pinnedAt}, commit ` +
      `${UPSTREAM_PIN.commit.slice(0, 12)}) and is now treated as unverified: every cross-repo ` +
      'gate is checking a contract that may no longer be what ko-api serves.\n' +
      'Refresh and read the diff:\n' +
      '  KO_API_REPO=/path/to/ko-api npm run registry:check-upstream\n' +
      '  KO_API_REPO=/path/to/ko-api npm run registry:refresh-pin',
    ).toBeLessThan(MAX_PIN_AGE_DAYS);
  });
});
