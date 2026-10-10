import { describe, expect, it, vi } from 'vitest';
import { KoClient, type GovAward } from '../src/index.js';

describe('government contracts wire contract', () => {
  const amounts = ['0.00', '1.50', '-1250000.00', '123456789012345678901234567890.10'];
  const body = { data: amounts.map(obligated_amount => ({ obligated_amount })), meta: { scope: 'award', identity: { cik: '0000012927', company_name: 'BOEING', issuer_tickers: ['BA'] }, refreshed_at: null, caveats: ['listed_today_survivorship'] } };
  const cases = [
    { path: '/BA', params: { fiscal_year: '2026', sub_agency: '2100' }, call: (ko: KoClient) => ko.govContracts.company('ba', { fiscalYear: 2026, subAgency: '2100' }) },
    { path: '/BA/transactions', params: { award_id: 'CONT_AWD_X', page: '2', per_page: '200', min_amount: '1.50' }, call: (ko: KoClient) => ko.govContracts.transactions('BA', { awardId: 'CONT_AWD_X', page: 2, perPage: 200, minAmount: '1.50' }) },
    { path: '', params: { from: '2026-01-01', to: '2026-02-01', recipient: 'BOEING', naics: '3364', award_type: 'D', min_amount: '1.50', facets: 'agency', sort: '-amount' }, call: (ko: KoClient) => ko.govContracts.search({ from: '2026-01-01', to: '2026-02-01', recipient: 'BOEING', naics: '3364', awardType: 'D', minAmount: '1.50', facets: 'agency', sort: '-amount' }) },
    { path: '/companies', params: { ticker: 'BA,LMT', agency: '097', sort: 'gross' }, call: (ko: KoClient) => ko.govContracts.companies({ ticker: 'BA,LMT', agency: '097', sort: 'gross' }) },
    { path: '/coverage', params: {}, call: (ko: KoClient) => ko.govContracts.coverage() },
  ];
  for (const c of cases) it(`maps ${c.path || 'feed'} and preserves exact decimals and metadata`, async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
    const ko = new KoClient({ fetch, apiKey: 'ko_test' });
    const result = await c.call(ko);
    expect(result.data).toEqual(body.data); expect(result.meta).toEqual(body.meta);
    const url = new URL(String((fetch.mock.calls as unknown[][])[0]![0]));
    expect(url.pathname).toBe('/api/v1/gov-contracts' + c.path);
    for (const [k, v] of Object.entries(c.params)) expect(url.searchParams.get(k)).toBe(v);
    expect(url.searchParams.has('period')).toBe(false);
  });
  for (const amount of [...amounts, null]) it(`preserves issuer-attributed award context with total ${amount}`, async () => {
    const award: GovAward = {
      award_id: 'CONT_AWD_X', piid: 'N0001924C0012', award_type: 'D', award_description: 'Aircraft procurement',
      agency: { code: '097', name: 'DEFENSE', sub_code: '2100', sub_name: 'ARMY' },
      recipient: { name: 'BOEING', uei: 'UEI', parent_name: 'BOEING', parent_uei: 'UEI' },
      latest_action_date: '2026-10-06', attributed_actions: amount === null ? null : 42,
      attributed_net_obligated: amount, attributed_scope: 'issuer_attributed_since_fy2015',
      requires_plan: amount === null ? 'developer' : null, source_url: 'https://www.usaspending.gov/award/CONT_AWD_X/',
    };
    const ko = new KoClient({ fetch: async () => new Response(JSON.stringify({ data: [], meta: { ...body.meta, award } })) });
    const r = await ko.govContracts.transactions('BA', { awardId: award.award_id });
    expect(r.data).toEqual([]);
    expect(r.meta.award).toEqual(award);
  });
  it('preserves metadata when an award has no actions in the window', async () => {
    const ko = new KoClient({ fetch: async () => new Response(JSON.stringify({ ...body, data: [] })) });
    const r = await ko.govContracts.transactions('BA', { awardId: 'CONT_AWD_X' });
    expect(r.data).toEqual([]); expect(r.meta.identity).toEqual(body.meta.identity); expect(r.meta.scope).toBe('award');
  });
});
