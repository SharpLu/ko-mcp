import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../ko-fetch.js', async () => ({ ...(await vi.importActual<typeof import('../ko-fetch.js')>('../ko-fetch.js')), koFetch: vi.fn() }));
import { koFetch, KoApiError } from '../ko-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerGovTools, GOV_TIMEOUT_MS } from '../tools/gov.js';
import { textSkeleton } from '../contract/skeleton.mjs';
import { action, award, meta, summary, transactions, feed, companies } from './gov-fixtures.js';
const mock = vi.mocked(koFetch);
async function call(name: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: 'gov-test', version: 'test' });
  registerGovTools(server, { baseUrl: 'https://api.ko.io', apiKey: '' });
  const client = new Client({ name: 'test', version: 'test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try { await client.listTools(); return await client.callTool({ name, arguments: args }); }
  finally { await client.close(); await server.close(); }
}
beforeEach(() => { mock.mockReset(); mock.mockImplementation(async (_c, path) => path.endsWith('/transactions') ? transactions() : path.endsWith('/companies') ? companies() : path === '/api/v1/gov-contracts' ? feed() : summary()); });
describe('government contracts SDK-validated tool contract', () => {
  it('defaults to the API window, forwards per_page and starts both company legs', async () => {
    const r = await call('get_gov_contracts', { ticker: 'ba', include: 'actions', limit: 200, page: 2 });
    expect(r.isError).toBeFalsy();
    expect(mock.mock.calls.map(c => c[1])).toEqual(['/api/v1/gov-contracts/BA', '/api/v1/gov-contracts/BA/transactions']);
    for (const c of mock.mock.calls) { expect(c[2]?.period).toBeUndefined(); expect(c[3]).toEqual({ envelope: true, timeoutMs: 18000 }); }
    expect(mock.mock.calls[1][2]).toMatchObject({ page: 2, per_page: 200 });
    expect(GOV_TIMEOUT_MS).toBeLessThan(20000);
    expect(r.structuredContent).toMatchObject({ scope: 'company', totals: { net_obligated: '8750000.00' } });
  });
  it('renders four distinct summary tables with independently protected column headers', async () => {
    const r = await call('get_gov_contracts', { ticker: 'BA' });
    const text = (r.content as Array<{ text: string }>).map(c => c.text).join('\n');
    expect(textSkeleton(text).tables).toHaveLength(4);
    expect(textSkeleton(text).lines.filter(l => l.startsWith('THEAD'))).toHaveLength(4);
  });
  for (const empty of [false, true]) it(`award ${empty ? 'empty' : 'populated'} retains metadata without company totals`, async () => {
    mock.mockResolvedValue(transactions(empty, true));
    const r = await call('get_gov_contracts', { ticker: 'BA', award_id: 'CONT_AWD_X' });
    expect(r.isError).toBeFalsy();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][1]).toBe('/api/v1/gov-contracts/BA/transactions');
    expect(r.structuredContent).toMatchObject({ scope: 'award', cik: meta.identity.cik, company_name: meta.identity.company_name, issuer_tickers: ['BA'], refreshed_at: meta.refreshed_at, caveats: meta.caveats, award });
    for (const key of ['totals', 'monthly', 'agencies', 'link_tiers']) expect(r.structuredContent).not.toHaveProperty(key);
    expect(JSON.stringify(r.content)).toContain('Attributed actions on award');
    expect(JSON.stringify(r.content)).not.toContain('Gross obligations (USD)');
  });
  for (const amount of ['0.00', '1.50', '-1250000.00', '123456789012345678901234567890.10']) it(`keeps ${amount} exact in structured and text output`, async () => {
    const body = transactions(false, true); body.data = [{ ...action, obligated_amount: amount }];
    mock.mockResolvedValue(body);
    const r = await call('get_gov_contracts', { ticker: 'BA', award_id: 'CONT_AWD_X' });
    expect(r.isError).toBeFalsy(); expect(JSON.stringify(r.structuredContent)).toContain(amount); expect(JSON.stringify(r.content)).toContain(amount);
  });
  it('supports nested lists and nullable company display identity', async () => {
    const body = companies(); const row = { ...body.data[0], ticker: null, company_name: null };
    mock.mockResolvedValue({ data: { data: [row] }, meta: body.meta });
    const r = await call('search_gov_contracts', { view: 'companies' });
    expect(r.isError).toBeFalsy(); expect(JSON.stringify(r.content)).toContain(row.cik);
  });
  for (const args of [{ period: '1Q', fiscal_year: 2026 }, { fiscal_year: 2026, from: '2026-01-01' }, { period: '1Q', to: '2026-01-01' }, { to: '2026-01-01' }]) it(`rejects invalid window ${JSON.stringify(args)} without upstream calls`, async () => {
    const r = await call('get_gov_contracts', { ticker: 'BA', ...args }); expect(r.isError).toBe(true); expect(mock).not.toHaveBeenCalled();
  });
  for (const key of ['recipient', 'naics', 'award_type', 'min_amount', 'sort_actions']) it(`rejects ${key} on companies view`, async () => {
    const value = { recipient: 'BOEING', naics: '3364', award_type: 'D', min_amount: '1.00', sort_actions: 'amount' }[key];
    const r = await call('search_gov_contracts', { view: 'companies', [key]: value });
    expect(r.isError).toBe(true); expect(JSON.stringify(r.content)).toContain(key); expect(mock).not.toHaveBeenCalled();
  });
  it('rejects company sort in actions view', async () => {
    const r = await call('search_gov_contracts', { sort_companies: 'net' }); expect(r.isError).toBe(true); expect(mock).not.toHaveBeenCalled();
  });
  it('does not silently cap a full page of 200 actions', async () => {
    const body = feed(); body.data = Array.from({ length: 200 }, () => body.data[0]); body.meta.total_count = 300;
    mock.mockResolvedValue(body); const r = await call('search_gov_contracts', { limit: 200 });
    expect(((r.structuredContent as { actions: unknown[] }).actions).length).toBe(200);
    expect(JSON.stringify(r.content)).toContain('page=2');
  });
  it('respects keyless continuation and the clamped window', async () => {
    mock.mockResolvedValue({ ...feed(), meta: { ...meta, window_clamped: true, total_count: 100, per_page: 25, softwall: { row_cap: 25, truncated: true, continuation: 'SIGNIN_REQUIRED' } } });
    const r = await call('search_gov_contracts', {});
    expect(r.structuredContent).toMatchObject({ window: { clamped: true }, paging: { next_page: null, continuation: 'SIGNIN_REQUIRED' } });
    expect(JSON.stringify(r.content)).not.toContain('use page=2');
  });
  it('defensively rejects an unexpected legacy plan-emptied 200 response', async () => {
    mock.mockResolvedValue({ ...feed(true), meta: { ...meta, softwall: { truncated: true } } });
    const r = await call('search_gov_contracts', {}); expect(r.isError).toBe(true); expect(JSON.stringify(r.content)).toContain('plan');
  });
  it('keeps plan denials as errors, never no-data responses', async () => {
    mock.mockRejectedValue(new KoApiError('PLAN_REQUIRED: history requires Pro', 403, 'PLAN_REQUIRED', null));
    const r = await call('get_gov_contracts', { ticker: 'BA', period: 'ALL' }); expect(r.isError).toBe(true); expect(JSON.stringify(r.content)).toContain('Pro');
  });
  it('retains attributed actions when award context is unavailable during publication', async () => {
    mock.mockResolvedValue({ ...transactions(false, true), meta: { ...transactions(false, true).meta, award: null } });
    const r = await call('get_gov_contracts', { ticker: 'BA', award_id: 'CONT_AWD_X' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ scope: 'award', award: null, actions: [action] });
    expect(JSON.stringify(r.content)).toContain('Award metadata is temporarily unavailable');
  });
  it('does not claim earlier actions exist for an unlinked Free issuer and uses canonical identity', async () => {
    const body = summary(true);
    mock.mockResolvedValue({ ...body, data: { ...body.data, ticker: 'BRK-B' }, meta: { ...body.meta, softwall: { window_start: meta.window_start, window_end: meta.window_end } } });
    const r = await call('get_gov_contracts', { ticker: 'BRK.B' });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).not.toContain('Earlier data exists');
    expect(JSON.stringify(r.content)).toContain('(BRK-B)');
    expect(JSON.stringify(r.content)).toContain('History outside this Free window requires Pro');
  });
  it('does not place out-of-window actions behind Pro for a bounded Free query', async () => {
    const body = summary(true);
    mock.mockResolvedValue({ ...body, meta: { ...body.meta, match_status: 'none_in_window', window_start: '2026-09-01', window_end: '2026-09-02', softwall: { window_start: meta.window_start, window_end: meta.window_end } } });
    const r = await call('get_gov_contracts', { ticker: 'BA', from: '2026-09-01', to: '2026-09-02' });
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).not.toContain('Earlier data exists');
  });
  it('fails closed if an empty award response omits identity', async () => {
    mock.mockResolvedValue({ data: [], meta: { ...transactions(true, true).meta, identity: undefined } });
    const r = await call('get_gov_contracts', { ticker: 'BA', award_id: 'CONT_AWD_X' }); expect(r.isError).toBe(true);
  });
});
