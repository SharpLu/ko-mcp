import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defineTool, type ToolResultLike } from '../tool-def.js';
import { koFetch, asEnvelope, type KoConfig, type KoMeta } from '../ko-fetch.js';
import { pagingOf, pagingLines, windowLine, planLimitOf } from '../paging.js';
import { GOV_CONTRACTS_OUTPUT, GOV_SEARCH_OUTPUT } from '../output-schemas.js';
import { GovIdentity, GovSummary, GovAction, GovFeedAction, GovCompany, GovAward, GovWindow } from '../gov-schemas.js';

export const GOV_TIMEOUT_MS = 18_000;
const options = { envelope: true, timeoutMs: GOV_TIMEOUT_MS };
const methodology = 'https://ko.io/datasets/gov-contracts/';
const windowInputs = {
  period: z.enum(['1Q', '2Q', '1Y', 'ALL']).optional(), fiscal_year: z.number().int().min(2015).optional(),
  from: z.string().date().optional(), to: z.string().date().optional(),
  agency: z.string().optional(), sub_agency: z.string().optional(),
};
const pagination = { page: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(200).default(50) };
const actionSort = z.enum(['date', 'amount', '-amount']);
const getInputs = { ticker: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9][A-Za-z0-9.\-]*$/), ...windowInputs,
  include: z.enum(['summary', 'actions']).default('summary'), award_id: z.string().min(1).max(200).optional(), sort: actionSort.optional(), ...pagination };
const searchInputs = { view: z.enum(['actions', 'companies']).default('actions'), ticker: z.string().optional(), ...windowInputs,
  recipient: z.string().optional(), naics: z.string().regex(/^\d{2,6}$/).optional(), award_type: z.string().regex(/^[ABCD](,[ABCD])*$/).optional(),
  min_amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(), sort_actions: actionSort.optional(), sort_companies: z.enum(['net', 'gross', 'actions']).optional(), ...pagination };
type WindowArgs = z.infer<z.ZodObject<typeof windowInputs>>;
function windowError(a: WindowArgs): string | null {
  if ([a.period !== undefined, a.fiscal_year !== undefined, a.from !== undefined || a.to !== undefined].filter(Boolean).length > 1) return 'Choose one window: period, fiscal_year, or from/to.';
  if (a.to && !a.from) return 'to requires from.';
  if (a.from && a.to && a.from > a.to) return 'from must be on or before to.';
  return null;
}
const fail = (message: string): ToolResultLike => ({ isError: true, content: [{ type: 'text', text: message }] });
const params = (a: WindowArgs) => ({ period: a.period, fiscal_year: a.fiscal_year, from: a.from, to: a.to, agency: a.agency, sub_agency: a.sub_agency });
const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
function table(headers: string[], rows: unknown[][]): string[] {
  return rows.length ? ['', '| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...rows.map(r => '| ' + r.map(cell).join(' | ') + ' |')] : [];
}
function windowOf(m: KoMeta) {
  return GovWindow.parse({ start: m.window_start, end: m.window_end, clamped: m.window_clamped, date_basis: m.date_basis, period: m.period });
}
function notes(m: KoMeta): string[] {
  // An existence probe outside a requested window does not prove earlier or paid history.
  const freeWindow = windowLine(m, false);
  return [freeWindow, `Window: ${m.window_start} to ${m.window_end} (action date).`,
    m.window_clamped ? 'The requested window was clamped to the Free window.' : null,
    'Amounts are signed obligations, not payments. Recent months are provisional (*); partial months are marked ~. Defense reports about 90 days late.',
    `Automatic exact matches cover companies listed today, plus reviewed links with recorded evidence. Current parents are not historical ownership. [Methodology](${methodology})`,
  ].filter((x): x is string => Boolean(x));
}
function rowsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && 'data' in raw && Array.isArray(raw.data)) return raw.data;
  throw new Error('Invalid government contracts list response');
}
function actionTable(rows: z.infer<typeof GovAction>[]) {
  return table(['Date', 'Agency / sub-agency', 'Award / modification', 'Obligation (USD)', 'Link', 'Source'], rows.map(r => [r.action_date + (r.provisional ? '*' : ''), `${r.agency.name} / ${r.agency.sub_name}`, `${r.piid} / ${r.modification_number}`, r.obligated_amount, r.link_tier === 'A' ? 'automatic exact match' : 'reviewed link', r.source_url]));
}
// Defensive against a legacy/upstream regression. Current gov policy rejects history with 403.
function planEmptied(m: KoMeta, empty: boolean) {
  return empty && m.softwall?.truncated === true ? fail('The caller’s ko.io plan withheld these results. Use Pro for history: https://ko.io/pricing') : null;
}
export function registerGovTools(server: McpServer, config: KoConfig) {
  defineTool(server, 'get_gov_contracts',
    'U.S. federal prime-contract obligations (USAspending, FY2015+) attributed to one issuer, across all share classes. Gross, signed deobligations, net, monthly series and agencies. include=actions adds actions; award_id returns only attributed actions on that award plus award context. Exact decimal strings. Recent months are provisional; Defense reports about 90 days late. Automatic exact matches cover companies listed today, plus reviewed links. No link does not mean no contracts. Free: trailing 92 days; history: Pro.',
    getInputs, async (a) => {
      const invalid = windowError(a);
      if (invalid) return fail(invalid);
      if (a.sort && a.include !== 'actions' && !a.award_id) return fail('sort requires include=actions or award_id.');
      const ticker = a.ticker.toUpperCase();
      const path = `/api/v1/gov-contracts/${encodeURIComponent(ticker)}`;
      const wantActions = a.include === 'actions' || Boolean(a.award_id);
      // Start both legs before parsing: each has the same bounded 18s budget.
      const [summary, transactions] = await Promise.all([
        a.award_id ? undefined : koFetch(config, path, params(a), options),
        wantActions ? koFetch(config, `${path}/transactions`, { ...params(a), award_id: a.award_id, sort: a.sort, page: a.page ?? 1, per_page: a.limit ?? 50 }, options) : undefined,
      ]);
      const e = asEnvelope<unknown>(a.award_id ? transactions : summary);
      const m = e.meta;
      const s = a.award_id ? undefined : GovSummary.parse(e.data);
      // Transactions retain this explicit identity block even when data: [].
      const identity = s ? GovIdentity.parse(s) : GovIdentity.parse(m.identity);
      const tx = transactions === undefined ? undefined : asEnvelope<unknown>(transactions);
      const actions = tx ? z.array(GovAction).parse(rowsOf(tx.data)) : undefined;
      const denied = planEmptied(m, s ? s.totals.actions === 0 : actions?.length === 0) ?? (tx ? planEmptied(tx.meta, actions?.length === 0) : null);
      if (denied) return denied;
      if (a.award_id && m.scope !== 'award') throw new Error('Invalid award scope in government contracts response');
      const award = a.award_id ? GovAward.nullable().parse(m.award) : undefined;
      const paging = tx ? pagingOf(tx.meta, { page: a.page ?? 1, limit: a.limit ?? 50, returned: actions!.length }) : undefined;
      const output = z.object(GOV_CONTRACTS_OUTPUT).parse({
        scope: a.award_id ? 'award' : 'company', ...identity, window: windowOf(m), match_status: m.match_status,
        ...(s ? { totals: s.totals, monthly: s.monthly, agencies: s.agencies, link_tiers: s.link_tiers } : {}),
        ...(actions ? { actions } : {}), ...(a.award_id ? { award } : {}), provisional_from: m.provisional_from, refreshed_at: m.refreshed_at,
        caveats: m.caveats, ...(paging ? { paging } : {}), plan_limit: planLimitOf(tx?.meta.softwall ? tx.meta : m),
      });
      const lines = [`## ${a.award_id ? `Attributed actions on award ${cell(a.award_id)}` : 'Government contracts'} — ${cell(identity.company_name)} (${cell(identity.ticker)})`, ...notes(m)];
      if (identity.issuer_tickers.length > 1) lines.push('Issuer-level: all share classes (' + identity.issuer_tickers.join(', ') + ').');
      if (m.match_status !== 'has_actions') lines.push(`No contract actions linked to ${cell(identity.ticker)}${a.award_id ? ` on award ${cell(a.award_id)}` : ''} in this window${a.agency || a.sub_agency ? ' for the selected agency filters' : ''}; this is not evidence of zero federal contracts.`);
      if (s) {
        lines.push(...table(['Gross obligations (USD)', 'Deobligations (USD)', 'Net obligations (USD)', 'Actions', 'Awards', 'Agencies'], [[s.totals.gross_obligated, s.totals.deobligated, s.totals.net_obligated, s.totals.actions, s.totals.awards, s.totals.agencies]]));
        lines.push(...table(['Month', 'Gross (USD)', 'Deobligations (USD)', 'Net (USD)', 'Actions', 'Awards'], s.monthly.map(r => [r.month + (r.provisional ? '*' : '') + (r.window_clipped ? '~' : ''), r.gross_obligated, r.deobligated, r.net_obligated, r.actions, r.awards])));
        lines.push(...table(['Agency', 'Gross (USD)', 'Net (USD)', 'Actions', 'Gross share'], s.agencies.map(r => [r.name, r.gross_obligated, r.net_obligated, r.actions, r.gross_share === null ? 'unknown' : `${(r.gross_share * 100).toFixed(2)}%`])));
        lines.push(...table(['Link tier', 'Actions'], s.link_tiers.map(r => [r.link_tier === 'A' ? 'automatic exact match' : 'reviewed link', r.actions])));
      }
      if (a.award_id && award === null) lines.push('Award metadata is temporarily unavailable. Attributed actions are shown below.');
      if (award) lines.push(`Award-wide context ${award.coverage_label}: ${award.coverage_net_obligated ?? 'requires Pro'} USD net; ${award.coverage_actions ?? 'requires Pro'} actions. These figures cover all recipients of the award.`, award.source_url);
      if (actions) lines.push(...actionTable(actions));
      if (paging) lines.push(...pagingLines(paging));
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: output };
    }, { outputSchema: GOV_CONTRACTS_OUTPUT });

  defineTool(server, 'search_gov_contracts',
    'Search U.S. federal prime-contract actions (USAspending, FY2015+) across companies, or rank companies by obligations with view=companies. Companies listed today plus reviewed links. Filter by ticker(s), agency, sub-agency, fiscal year or dates. Actions also support recipient, NAICS, award type and minimum absolute amount. Without tickers the window is at most 366 days. Exact decimal strings; signed obligations, not payments. Provisional recent months; Defense reports about 90 days late. Free: trailing 92 days; history: Pro.',
    searchInputs, async a => {
      const invalid = windowError(a);
      if (invalid) return fail(invalid);
      const view = a.view ?? 'actions';
      const disallowed = view === 'companies' ? ['recipient', 'naics', 'award_type', 'min_amount', 'sort_actions'] as const : ['sort_companies'] as const;
      for (const key of disallowed) if (a[key] !== undefined) return fail(`${key} is not supported for view=${view}.`);
      const wire = { ...params(a), ticker: a.ticker, page: a.page ?? 1, per_page: a.limit ?? 50,
        ...(view === 'companies' ? { sort: a.sort_companies } : { sort: a.sort_actions, recipient: a.recipient, naics: a.naics, award_type: a.award_type, min_amount: a.min_amount }) };
      const e = asEnvelope<unknown>(await koFetch(config, `/api/v1/gov-contracts${view === 'companies' ? '/companies' : ''}`, wire, options));
      const rows = rowsOf(e.data);
      const denied = planEmptied(e.meta, rows.length === 0);
      if (denied) return denied;
      const actions = view === 'actions' ? z.array(GovFeedAction).parse(rows) : undefined;
      const companies = view === 'companies' ? z.array(GovCompany).parse(rows) : undefined;
      const paging = pagingOf(e.meta, { page: a.page ?? 1, limit: a.limit ?? 50, returned: rows.length });
      const output = z.object(GOV_SEARCH_OUTPUT).parse({ view, window: windowOf(e.meta), ...(actions ? { actions } : { companies }), universe: 'listed_companies_plus_reviewed_links', caveats: e.meta.caveats, paging, plan_limit: planLimitOf(e.meta) });
      const lines = [`## Government contracts — ${view}`, ...notes(e.meta)];
      if (!rows.length) lines.push('No contract actions match these filters in this window. No linked actions is not evidence of zero federal contracts.');
      if (actions) lines.push(...table(['Company', 'Date', 'Agency / sub-agency', 'Award', 'Obligation (USD)', 'Source'], actions.map(r => [r.ticker ?? r.cik, r.action_date + (r.provisional ? '*' : ''), `${r.agency.name} / ${r.agency.sub_name}`, r.piid, r.obligated_amount, r.source_url])));
      if (companies) lines.push(...table(['Rank', 'Company', 'Gross (USD)', 'Deobligations (USD)', 'Net (USD)', 'Actions', 'Awards'], companies.map(r => [r.rank, r.ticker ?? r.cik, r.gross_obligated, r.deobligated, r.net_obligated, r.actions, r.awards])));
      lines.push(...pagingLines(paging));
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: output };
    }, { outputSchema: GOV_SEARCH_OUTPUT });
}
