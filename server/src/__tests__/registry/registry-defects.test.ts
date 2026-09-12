import { describe, it, expect, vi } from 'vitest';

vi.mock('../../ko-fetch.js', () => ({ koFetch: vi.fn() }));
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
      'no-timeout',
    ]);
  });

  it('no-timeout: ko-fetch.ts still has no timeout, retry or breaker', () => {
    const d = defect('no-timeout');
    const hits = ['AbortSignal', 'AbortController', 'setTimeout', 'timeout', 'retry']
      .filter((needle) => new RegExp(needle, 'i').test(koFetchSource));
    expect(
      hits,
      `ko-fetch.ts now mentions ${hits.join('/')}. If the fetch is bounded at last, delete the ` +
      `"${d.id}" entry from BEHAVIOURAL_DEFECTS and close ${d.issue}. Measured before the fix: ` +
      'a single call blocked 60,222 ms against an upstream route whose declared timeout is 30 s.',
    ).toEqual([]);
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

  it('headed-empty-table: the two odd tools still render an empty table with a header', async () => {
    const d = defect('headed-empty-table');
    for (const tool of ['list_institutions', 'get_congress_member']) {
      const text = await renderEmpty(tool);
      expect(
        /\n\|[-\s|]+\|\s*$/m.test(text),
        `${tool} no longer renders a headed empty table -- retire "${d.id}" if both are fixed.`,
      ).toBe(true);
    }
  });

  it('headed-empty-table: the rest of the surface says "no results" in words', async () => {
    // Contrast group: these guard their table on a non-empty response, which is
    // the behaviour the two above should converge on.
    for (const tool of ['get_congress_trades', 'get_form144_notices', 'get_crypto_holders']) {
      const text = await renderEmpty(tool);
      expect(/\n\|[-\s|]+\|\s*$/m.test(text), `${tool} rendered a headed empty table`).toBe(false);
    }
  });
});
