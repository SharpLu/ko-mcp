/** Machine capture/replay of the real MCP protocol with synthetic API fixtures.
 * This is explicitly offline evidence, not an assertion that ko-api is live.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
vi.mock('../../ko-fetch.ts', async () => ({ ...(await vi.importActual('../../ko-fetch.ts')), koFetch: vi.fn() }));
import { koFetch, KoApiError } from '../../ko-fetch.ts';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerGovTools } from '../../tools/gov.ts';
import { summary, feed } from '../gov-fixtures.ts';
import { CASES } from '../../contract/cases.mjs';
import { contractOf, diffContract, rawValuesIn } from '../../contract/skeleton.mjs';

async function probe(tool, args) {
  vi.mocked(koFetch).mockImplementation(async (_c, path, p) => {
    if (p?.period === 'ALL') throw new KoApiError('ko.io API error (403): Access forbidden (check your plan): History requires Pro. This is a plan limit, not missing data.', 403, 'PLAN_REQUIRED', null);
    return path.endsWith('/BA') ? summary(p?.agency === '9999') : feed(p?.agency === '9999');
  });
  const server = new McpServer({ name: 'ko-sec-data', version: '1.3.0' });
  registerGovTools(server, { baseUrl: 'https://api.ko.io', apiKey: '' });
  const client = new Client({ name: 'golden', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try { await client.listTools(); return contractOf({ jsonrpc: '2.0', id: 1, result: await client.callTool({ name: tool, arguments: args }) }); }
  finally { await client.close(); await server.close(); }
}
describe('government tool golden contracts (offline, synthetic upstream)', () => {
  for (const spec of CASES.filter(s => ['get_gov_contracts', 'search_gov_contracts'].includes(s.tool))) {
    it(`${spec.tool}: double-probe capture or strict replay`, async () => {
      const cases = [];
      for (const c of spec.cases) {
        const a = await probe(spec.tool, c.arguments);
        const b = await probe(spec.tool, c.arguments);
        expect(diffContract(a, b)).toEqual([]);
        for (const block of a.blocks) for (const line of block.lines) expect(rawValuesIn(line)).toEqual([]);
        cases.push({ ...c, contract: a });
      }
      const path = resolve('src/contract/gov-offline', `${spec.tool}.json`);
      const livePath = resolve('src/contract/golden', `${spec.tool}.json`);
      const source = 'src/__tests__/contract/gov-golden.test.mjs';
      if (process.env.KO_CAPTURE_GOV_FIXTURES === '1') {
        mkdirSync(resolve('src/contract/gov-offline'), { recursive: true });
        const captured = JSON.stringify({ tool: spec.tool, planGated: false, capturedAt: new Date().toISOString().slice(0, 10), provenance: { source: 'src/__tests__/contract/gov-golden.test.mjs', mode: 'recordings', note: 'Machine-captured real MCP Server/Client responses with synthetic USAspending API fixtures. Two independent probes agree. Offline contract evidence only; recapture against live API before merge.' }, cases }, null, 2) + '\n';
        writeFileSync(path, captured);
        // Bootstrap only: a later real upstream capture must never be overwritten by synthetic data.
        if (!existsSync(livePath) || JSON.parse(readFileSync(livePath, 'utf8')).provenance.source === source) writeFileSync(livePath, captured);
      } else {
        const fixture = JSON.parse(readFileSync(path, 'utf8'));
        expect(fixture.cases.length).toBe(cases.length);
        for (const c of cases) expect(diffContract(fixture.cases.find((f) => f.name === c.name).contract, c.contract), c.name).toEqual([]);
      }
    });
  }
});
