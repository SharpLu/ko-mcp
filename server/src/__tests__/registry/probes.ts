/**
 * Probes: one argument set per tool, chosen so that EVERY declared upstream leg
 * and EVERY declared param actually reaches the transport.
 *
 * The registry would be worth little if it were only compared with itself. The
 * behaviour gate runs each tool handler for real against a mocked transport and
 * compares what the code does with what the registry says it does, so a probe
 * that skips an input is a hole in the gate -- hence the assertion that every
 * probe covers every key of the tool's zod schema.
 *
 * `institution` is deliberately free text for the two tools with a
 * name-resolution leg: a CIK or slug short-circuits resolve.ts and that leg
 * would never be observed.
 */
import { registerInstitutionTools } from '../../tools/institutions.js';
import { registerStockTools } from '../../tools/stocks.js';
import { registerInsiderTools } from '../../tools/insiders.js';
import { registerCongressTools } from '../../tools/congress.js';
import { registerSearchTool } from '../../tools/search.js';
import { registerForm144Tools } from '../../tools/form144.js';
import { registerFilingTools } from '../../tools/filings.js';
import { registerFinancialTools } from '../../tools/financials.js';
import { registerMacroTools } from '../../tools/macro.js';
import { registerCryptoTools } from '../../tools/crypto.js';
import { makeFakeServer, type CapturedTool } from '../helpers.js';

export const PROBES: Record<string, Record<string, unknown>> = {
  get_institution_holdings: { institution: 'Berkshire Hathaway', ticker: 'GOOG', entity: 'filer', page: 2, limit: 25 },
  list_institutions: { search: 'Baupost', page: 2, limit: 25 },
  get_stock_profile: { ticker: 'AAPL' },
  get_stock_holders: { ticker: 'NVDA', page: 2, limit: 25 },
  get_stock_activity: { ticker: 'NVDA', quarters: 8 },
  get_stock_price: { ticker: 'AAPL', period: '3y', series: true, limit: 100 },
  get_stock_financials: { ticker: 'AAPL', period_type: 'annual', limit: 8 },
  get_insider_trades: { ticker: 'AAPL', executive_cik: '1214128', period: '1Y', page: 2, limit: 25 },
  list_insider_traders: { search: 'Musk', role: 'ceo', page: 2, limit: 25 },
  get_congress_trades: {
    chamber: 'house', party: 'D', ticker: 'NVDA', state: 'CA',
    search: 'Pelosi', sort: 'recent', page: 2, limit: 25,
  },
  get_congress_member: { member: 'nancy-pelosi', page: 2, limit: 25 },
  search: { query: 'apple', limit: 5 },
  get_form144_notices: { ticker: 'AAPL', insider_cik: '1214128', limit: 25 },
  sec_list_filings: { cik: '320193', form_type: '10-K', from: '2024-01-01', to: '2024-12-31', limit: 25 },
  sec_get_filing_index: { cik: '320193', accession_no: '0000320193-24-000123' },
  sec_get_filing_document: {
    cik: '320193', accession_no: '0000320193-24-000123',
    file: 'aapl-20240928.htm', include_excerpt: true,
  },
  get_treasury_yields: { days: 30 },
  get_fed_rates: { days: 30 },
  get_economic_indicators: { category: 'cpi', days: 365, page: 2, limit: 25 },
  get_ftd_data: { ticker: 'GME', days: 90, page: 2, limit: 25 },
  get_financial_stress: { days: 365, page: 2, limit: 25 },
  get_crypto_exposure: {},
  get_crypto_holders: { product: 'IBIT', page: 2, limit: 25 },
  get_crypto_holder: { institution: 'Goldman Sachs' },
};

/**
 * Extra argument sets for tools whose legs are MUTUALLY EXCLUSIVE, so no single
 * probe can reach them all. The behaviour gate runs the main probe AND every
 * variant and judges the union of the calls: each declared leg must be seen,
 * nothing undeclared may be sent. The main probe still has to set every input
 * (the coverage assertion reads PROBES only); a variant exists solely to take
 * the other branch.
 */
export const PROBE_VARIANTS: Record<string, Array<Record<string, unknown>>> = {
  // executive_cik present -> /insider/:cik/transactions (main probe);
  // absent -> /insider-trades (this variant).
  get_insider_trades: [{ ticker: 'AAPL', period: '1Y', page: 2, limit: 25 }],
};

/**
 * Canned upstream payloads. Only the legs whose RESULT decides whether a later
 * leg runs need to be realistic: resolve.ts returns null on an empty match list
 * and the tool then never calls its primary route. Everything else may throw
 * during rendering -- the transport call has already been recorded by then.
 */
export function cannedResponse(path: string): unknown {
  if (path === '/api/v1/institutions') {
    return [{ cik: '1067983', name: 'Berkshire Hathaway', slug: 'berkshire-hathaway' }];
  }
  if (path.endsWith('/share')) {
    return { url: 'https://api.ko.io/signed', expires_at: '2026-09-13T00:00:00Z' };
  }
  return [];
}

export function registerAllTools(): Map<string, CapturedTool> {
  const { server, tools } = makeFakeServer();
  const config = { baseUrl: 'https://api.ko.io', apiKey: '' };
  registerInstitutionTools(server, config);
  registerStockTools(server, config);
  registerInsiderTools(server, config);
  registerCongressTools(server, config);
  registerSearchTool(server, config);
  registerForm144Tools(server, config);
  registerFilingTools(server, config);
  registerFinancialTools(server, config);
  registerMacroTools(server, config);
  registerCryptoTools(server, config);
  return tools;
}

/** `/api/v1/holdings/:cik` -> matcher for the concrete paths it can produce. */
export function templateToRegExp(template: string): RegExp {
  const escaped = template
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}
