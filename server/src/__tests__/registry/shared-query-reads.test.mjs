import { describe, expect, it } from 'vitest';
import { sharedQueryReads } from '../../../scripts/shared-query-reads.mjs';

// Synthetic source only: ko-api is private; never copy its handlers here.
const root = 'src/routes/example.ts';
const helper = 'src/lib/params.ts';
const paging = 'src/lib/page.ts';
const sources = {
  [root]: `
    import { value, windowParams, paging } from '@/lib/params.js';
    async function handle(c, view) {
      if (view === 'coverage') return [];
      const sp = new URL(c.req.url).searchParams;
      const window = windowParams(sp);
      if (view === 'summary' || view === 'transactions') { const ticker = c.req.param('ticker'); }
      else { value(sp, 'ticker'); }
      const award = view === 'transactions' ? value(sp, 'award_id') : null;
      if (view === 'feed' || view === 'transactions') value(sp, 'min_amount');
      if (view === 'feed') value(sp, 'recipient');
      if (view === 'summary') return window;
      const page = paging(sp);
      const sort = value(sp, 'sort');
      return page;
    }
    app.get('/coverage', c => handle(c, 'coverage'));
    app.get('/summary', c => handle(c, 'summary'));
    app.get('/transactions', c => handle(c, 'transactions'));
    app.get('/feed', c => handle(c, 'feed'));
    app.get('/companies', c => handle(c, 'companies'));
  `,
  [helper]: `
    import { pageSize } from './page.js';
    export const value = (sp, key) => sp.get(key)?.trim() || null;
    export function windowParams(sp) { return [value(sp, 'period'), value(sp, 'from')]; }
    export function paging(sp) { const page = value(sp, 'page'); return pageSize(sp); }
  `,
  [paging]: `export function pageSize(sp) { return sp.get('per_page') || sp.get('limit'); }`,
};
function scan(changes = {}) {
  const files = { ...sources, ...changes };
  return sharedQueryReads(root, path => { if (!(path in files)) throw new Error(`Missing source ${path}`); return files[path]; });
}
const params = result => Object.fromEntries(result.handlers.map(h => [h.path, h.readParams]));
describe('shared upstream query reads', () => {
  it('binds view literals, honors early returns and excludes sibling-only params', () => {
    expect(params(scan())).toEqual({
      '/coverage': [],
      '/summary': ['from', 'period'],
      '/transactions': ['award_id', 'from', 'limit', 'min_amount', 'page', 'per_page', 'period', 'sort'],
      '/feed': ['from', 'limit', 'min_amount', 'page', 'per_page', 'period', 'recipient', 'sort', 'ticker'],
      '/companies': ['from', 'limit', 'page', 'per_page', 'period', 'sort', 'ticker'],
    });
    expect(scan().files.sort()).toEqual([root, helper, paging].sort());
  });
  it('derives nested helper reads from source instead of a fixed parameter inventory', () => {
    const result = scan({ [paging]: sources[paging].replace("sp.get('limit')", "sp.get('page_size')") });
    expect(params(result)['/transactions']).toContain('page_size');
    expect(params(result)['/transactions']).not.toContain('limit');
  });
  it('tracks URLSearchParams aliases and imported helper aliases', () => {
    const changed = sources[root].replace('value, windowParams', 'value as readValue, windowParams').replaceAll('value(sp,', 'readValue(alias,').replace('const window =', 'const alias = sp; const window =');
    expect(params(scan({ [root]: changed }))).toEqual(params(scan()));
  });
  it('prunes a false view branch even when another condition is unknown', () => {
    const changed = sources[root].replace("if (view === 'feed') value(sp, 'recipient');", "if (runtimeFlag && view === 'feed') value(sp, 'recipient');");
    expect(params(scan({ [root]: changed }))).toEqual(params(scan()));
  });
  it('scans both runtime-dependent branches without treating a conditional return as unconditional', () => {
    const changed = sources[helper].replace("return [value(sp, 'period'), value(sp, 'from')];", "if (value(sp, 'mode')) return sp.get('a'); else sp.get('b'); return sp.get('c');");
    expect(params(scan({ [helper]: changed }))['/summary']).toEqual(['a', 'b', 'c', 'mode']);
  });
  for (const [name, expression] of [
    ['unknown helper', 'missing(sp)'],
    ['dynamic key', 'sp.get(runtimeKey)'],
    ['unknown imported helper', 'windowParams2(sp)'],
    ['indirect helper', 'object.read(sp)'],
    ['object escape', 'missing({ sp })'],
    ['unsupported method', 'sp.entries()'],
    ['assignment escape', 'saved = sp'],
    ['view mutation', "view = 'feed'"],
  ]) it(`fails closed on ${name}`, () => {
    const changed = sources[root].replace('const window = windowParams(sp);', `const window = windowParams(sp); ${expression};`);
    expect(() => scan({ [root]: changed })).toThrow();
  });
  it('fails closed if a transitive helper disappears or the wrapper changes', () => {
    expect(() => scan({ [paging]: 'export function renamed() {}' })).toThrow();
    expect(() => scan({ [paging]: 'export function pageSize(sp) { return sp; }' })).toThrow();
    expect(() => scan({ [root]: sources[root].replace("handle(c, 'summary')", 'handle(c, runtimeView)') })).toThrow();
    expect(() => scan({ [root]: sources[root].replace("c => handle(c, 'summary')", 'c => unknown(c)') })).toThrow();
  });
});
