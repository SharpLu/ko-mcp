import { describe, it, expect, vi } from 'vitest';

// Mock ONLY the transport. Spreading importActual keeps the module's real
// constants (KO_FETCH_TIMEOUT_MS) and classes (KoTimeoutError) in place: a
// factory that lists exports by hand silently yields `undefined` for any new
// one, which is how the ko-bastion#127 timeout constant first read as undefined
// inside filings.ts and made a declared upstream leg vanish from this gate.
vi.mock('../../ko-fetch.js', async () => ({
  ...(await vi.importActual<typeof import('../../ko-fetch.js')>('../../ko-fetch.js')),
  koFetch: vi.fn(),
}));
import { koFetch } from '../../ko-fetch.js';

import koFetchSource from '../../ko-fetch.ts?raw';
import { BEHAVIOURAL_DEFECTS } from '../../registry/tools.js';
import { PROBES, registerAllTools } from './probes.js';

const mock = vi.mocked(koFetch);

/**
 * GATE (g): the known non-param defects are asserted to STILL EXIST.
 *
 * This reads backwards until you see what it buys. The M0 audit found four
 * defects this PR does not fix; writing them in a document would let them rot
 * either way -- silently fixed (and the doc lies), or silently fixed in part
 * (and nobody notices what is left). Asserting the defect is still real means
 * the day someone fixes it, THIS test fails and the fixer must delete the
 * matching BEHAVIOURAL_DEFECTS entry. The registry can never quietly disagree
 * with the code in either direction.
 */

const defect = (id: string) => {
  const d = BEHAVIOURAL_DEFECTS.find((x) => x.id === id);
  if (!d) throw new Error(`BEHAVIOURAL_DEFECTS has no entry "${id}"`);
  return d;
};

/** Render a tool against an empty upstream response. */
async function renderEmpty(tool: string): Promise<string> {
  mock.mockReset();
  mock.mockResolvedValue([] as never);
  const res = await registerAllTools().get(tool)!.handler(PROBES[tool]);
  return res.content.map((c) => c.text).join('\n');
}

describe('registry gate (g): declared defects still exist', () => {
  it('the defect table has an entry per known non-param defect', () => {
    expect(BEHAVIOURAL_DEFECTS.map((d) => d.id).sort()).toEqual([
      'error-passthrough-contradicts-comment',
      'filing-document-plan-undeclared',
      'headed-empty-table',
      // 'no-timeout' retired when ko-bastion#127 shipped; the assertion below
      // now guards the FIX rather than the defect.
    ]);
  });

  /**
   * The inverse of the gate that used to stand here (ko-bastion#127).
   *
   * Until 2026-09-12 this asserted the DEFECT: that ko-fetch.ts mentioned no
   * AbortSignal, so fixing it would fail here and force the fixer to retire the
   * entry. It has been retired, and the same assertion is now turned around to
   * guard the fix -- a future edit that deletes the bound puts the 60,222 ms
   * hang back and must fail here rather than pass quietly.
   */
  it('the fetch is bounded, and bounded below the upstream budget', async () => {
    expect(BEHAVIOURAL_DEFECTS.find((d) => d.id === 'no-timeout')).toBeUndefined();
    expect(koFetchSource).toMatch(/AbortSignal\.timeout\(/);
    const { KO_FETCH_TIMEOUT_MS } = await vi.importActual<typeof import('../../ko-fetch.js')>('../../ko-fetch.js');
    // The upstream ko-api `filings` route declares timeoutMs: 30000. Ours must
    // fire first or we inherit its failure instead of naming our own.
    expect(KO_FETCH_TIMEOUT_MS).toBeLessThan(30_000);
    // ...and must clear the slowest healthy call ever measured, 1,050 ms.
    expect(KO_FETCH_TIMEOUT_MS).toBeGreaterThan(1_050 * 5);
  });

  it('error-passthrough: the comment and the code still contradict each other', () => {
    const d = defect('error-passthrough-contradicts-comment');
    const claimsNoPassthrough = /do NOT pass through/.test(koFetchSource);
    const passesThrough = /detail = `: \$\{j\.error\.message\}`/.test(koFetchSource);
    expect(
      [claimsNoPassthrough, passesThrough],
      `ko-fetch.ts changed. Either the comment was corrected or the passthrough was removed; ` +
      `either way retire the "${d.id}" entry.`,
    ).toEqual([true, true]);
  });

  it('filing-document-plan-undeclared: the description still hides that it is paid-only', () => {
    const d = defect('filing-document-plan-undeclared');
    const description = registerAllTools().get('sec_get_filing_document')!.description;
    expect(
      /\b(paid|pro plan|subscription|requires a plan|api key required)\b/i.test(description),
      `sec_get_filing_document now states its plan requirement -- retire "${d.id}".`,
    ).toBe(false);
  });

  it('headed-empty-table: the one remaining tool still renders an empty table with a header', async () => {
    const d = defect('headed-empty-table');
    for (const tool of ['list_institutions']) {
      const text = await renderEmpty(tool);
      expect(
        /\n\|[-\s|]+\|\s*$/m.test(text),
        `${tool} no longer renders a headed empty table -- retire "${d.id}".`,
      ).toBe(true);
    }
  });

  it('headed-empty-table: the rest of the surface says "no results" in words', async () => {
    // Contrast group: these guard their table on a non-empty response, which is
    // the behaviour list_institutions should converge on. get_congress_member
    // joined this group on 2026-09-20 -- it is the assertion that the fix is
    // real, and it fails if anyone puts the bare header back.
    for (const tool of ['get_congress_member', 'get_congress_trades', 'get_form144_notices', 'get_crypto_holders']) {
      const text = await renderEmpty(tool);
      expect(/\n\|[-\s|]+\|\s*$/m.test(text), `${tool} rendered a headed empty table`).toBe(false);
    }
  });
});
