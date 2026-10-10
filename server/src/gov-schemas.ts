/** USAspending wire schemas. Amounts retain the API's canonical two-decimal strings. */
import { z } from 'zod';
export const GovMoney = z.string().regex(/^-?\d+\.\d{2}$/);
const count = z.number().int().nonnegative();
export const GovIdentity = z.object({ ticker: z.string(), cik: z.string(), company_name: z.string(), issuer_tickers: z.array(z.string()) });
export const GovTotals = z.object({ gross_obligated: GovMoney, deobligated: GovMoney, net_obligated: GovMoney, actions: count, awards: count, agencies: count });
export const GovMonth = z.object({ month: z.string(), gross_obligated: GovMoney, deobligated: GovMoney, net_obligated: GovMoney, actions: count, awards: count, provisional: z.boolean(), window_clipped: z.boolean() });
export const GovAgency = z.object({ code: z.string(), name: z.string(), gross_obligated: GovMoney, net_obligated: GovMoney, actions: count, gross_share: z.number().nullable() });
export const GovTier = z.object({ link_tier: z.enum(['A', 'B']), actions: count });
const agency = z.object({ code: z.string(), name: z.string(), sub_code: z.string(), sub_name: z.string() });
const recipient = z.object({ name: z.string(), uei: z.string(), parent_name: z.string(), parent_uei: z.string() });
const classification = z.object({ code: z.string(), description: z.string() });
export const GovAction = z.object({
  transaction_id: z.string(), award_id: z.string(), piid: z.string(), modification_number: z.string(), action_date: z.string(),
  obligated_amount: GovMoney, award_type: z.enum(['A', 'B', 'C', 'D']), agency, recipient, naics: classification, psc: classification,
  place_of_performance: z.object({ country: z.string(), state: z.string(), city: z.string() }), description: z.string(),
  link_tier: z.enum(['A', 'B']), provisional: z.boolean(), source_url: z.string(),
});
export const GovFeedAction = GovAction.extend({ ticker: z.string().nullable(), cik: z.string(), company_name: z.string().nullable() });
export const GovCompany = z.object({ rank: count, ticker: z.string().nullable(), cik: z.string(), company_name: z.string().nullable(), gross_obligated: GovMoney, deobligated: GovMoney, net_obligated: GovMoney, actions: count, awards: count });
export const GovAward = z.object({ award_id: z.string(), piid: z.string(), award_type: z.string(), agency, recipient, award_description: z.string(), latest_action_date: z.string(), attributed_actions: count.nullable(), attributed_net_obligated: GovMoney.nullable(), attributed_scope: z.literal('issuer_attributed_since_fy2015'), requires_plan: z.string().nullable(), source_url: z.string() });
export const GovSummary = GovIdentity.extend({ totals: GovTotals, monthly: z.array(GovMonth), agencies: z.array(GovAgency), link_tiers: z.array(GovTier) });
export const GovWindow = z.object({ start: z.string(), end: z.string(), clamped: z.boolean(), date_basis: z.literal('action_date'), period: z.string().nullable() });
