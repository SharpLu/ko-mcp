import { afterEach, expect, it, vi } from 'vitest';
import { makeFakeServer } from './helpers.js';
import { registerGovTools } from '../tools/gov.js';
import { KoTimeoutError } from '../ko-fetch.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('both gov transports abort a genuinely hanging fetch before the API deadline', async () => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const budget = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { expect(ms).toBe(18000); return original(25); });
  vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    // This mock has no success or independent rejection path; only abort settles it.
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
  })));
  const { server, tools } = makeFakeServer();
  registerGovTools(server, { baseUrl: 'https://api.ko.io', apiKey: '' });
  const started = Date.now();
  for (const name of ['get_gov_contracts', 'search_gov_contracts']) {
    await expect(tools.get(name)!.handler({ ticker: 'BA', include: 'actions' })).rejects.toBeInstanceOf(KoTimeoutError);
  }
  expect(budget).toHaveBeenCalledTimes(3);
  expect(Date.now() - started).toBeLessThan(1000);
});
