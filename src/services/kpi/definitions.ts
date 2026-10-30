/**
 * The KPI catalogue: what each figure measures, its unit, and which way is
 * good. The figures are calculated in agent.ts, team (the cluster scorecard's
 * own measures) and cso.ts; targets live in KpiTarget rows.
 *
 *   AGENT — one seller's own book. Used for agents and for a cluster leader's
 *           own sales.
 *   TEAM  — a cluster leader's agents, measured exactly as the scorecard
 *           measures them, so a leader is never shown one number here and paid
 *           on another.
 *   CSO   — a customer service officer's calls and what came of them.
 */

export type KpiGroup = 'AGENT' | 'TEAM' | 'CSO';
export type KpiUnit = 'GHS' | 'PERCENT' | 'COUNT';

export interface KpiDefinition {
  key: string;
  label: string;
  description: string;
  unit: KpiUnit;
  higherIsBetter: boolean;
  /** Builds up over the month, so mid-month it is judged against a share of the target. */
  cumulative: boolean;
  /** Measured as of today only (no history), so past months show nothing. */
  currentOnly?: boolean;
}

export const KPI_GROUPS: KpiGroup[] = ['AGENT', 'TEAM', 'CSO'];

/** Days after a call within which a payment is credited to it. */
export const PAID_AFTER_CALL_DAYS = 7;

/** Outcomes where the customer was actually spoken to. */
export const REACHED_OUTCOMES = ['REACHED', 'PROMISE_TO_PAY', 'REFUSED', 'CALLBACK_REQUESTED'];

/** Calls about money owed — what the CSO payment KPIs are built from. */
export const PAYMENT_CALL_PURPOSES = ['COLLECTION', 'FOLLOW_UP'];

const AGENT: KpiDefinition[] = [
  { key: 'COLLECTIONS', label: 'Collections', description: 'GHS paid in the month by customers on contracts they sold.', unit: 'GHS', higherIsBetter: true, cumulative: true },
  { key: 'COLLECTION_RATE', label: 'Collection rate', description: 'Share of instalment value falling due in the month (to date) that has been paid.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'PAR30', label: 'Portfolio at risk (PAR30)', description: 'Share of their outstanding book on contracts more than 30 days behind, today.', unit: 'PERCENT', higherIsBetter: false, cumulative: false, currentOnly: true },
  { key: 'ARREARS_RECOVERED', label: 'Arrears recovered', description: 'GHS paid in the month on contracts that were 30+ days late when the month began.', unit: 'GHS', higherIsBetter: true, cumulative: true },
  { key: 'NEW_CONTRACTS', label: 'New contracts', description: 'Sales approved in the month.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'QUALITY_CONTRACTS', label: 'Quality contracts', description: 'Sales approved two months earlier that are still current — not cancelled, defaulted, written off or 30+ days behind.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'COMPLETED_CONTRACTS', label: 'Contracts completed', description: 'Customers who finished paying in the month.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'DEPOSIT_REMITTANCE', label: 'Deposits remitted on time', description: 'Share of deposits from sales in the month fully remitted within the allowed days.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'WRITE_OFFS', label: 'Written off', description: 'Balance written off in the month on contracts they sold.', unit: 'GHS', higherIsBetter: false, cumulative: false },
  { key: 'FOLLOW_UP_CALLS', label: 'Follow-up calls', description: 'Collection and follow-up calls they logged.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
];

const TEAM: KpiDefinition[] = [
  { key: 'COLLECTIONS', label: 'Team collections', description: 'GHS paid in the month on contracts sold by their agents.', unit: 'GHS', higherIsBetter: true, cumulative: true },
  { key: 'COLLECTION_RATE', label: 'Team collection rate', description: 'Share of instalment value falling due in the month (to date) that has been paid, across their agents.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'PAR30', label: 'Team PAR30', description: 'Share of their agents’ outstanding book on contracts more than 30 days behind, today.', unit: 'PERCENT', higherIsBetter: false, cumulative: false, currentOnly: true },
  { key: 'ARREARS_RECOVERED', label: 'Team arrears recovered', description: 'GHS paid in the month on their agents’ contracts that were 30+ days late when the month began.', unit: 'GHS', higherIsBetter: true, cumulative: true },
  { key: 'NEW_CONTRACTS', label: 'Team new contracts', description: 'Sales by their agents approved in the month.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'QUALITY_CONTRACTS', label: 'Team quality contracts', description: 'Their agents’ sales from two months earlier that are still current.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'ACTIVE_AGENTS', label: 'Agents selling', description: 'Agents in their team with at least one sale approved in the month.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'DEPOSIT_REMITTANCE', label: 'Team deposits remitted on time', description: 'Share of their agents’ deposits from the month fully remitted within the allowed days.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'UNLOCKS_FULFILLED', label: 'Unlocks paid', description: 'Temporary unlocks they asked for where the customer paid in time.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'UNLOCKS_DEFAULTED', label: 'Unlocks defaulted', description: 'Temporary unlocks they asked for that ran out unpaid.', unit: 'COUNT', higherIsBetter: false, cumulative: false },
  { key: 'WRITE_OFFS', label: 'Team written off', description: 'Balance written off in the month on their agents’ contracts.', unit: 'GHS', higherIsBetter: false, cumulative: false },
];

const CSO: KpiDefinition[] = [
  { key: 'CALLS_MADE', label: 'Payment calls made', description: 'Collection and follow-up calls logged in the month.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'CUSTOMERS_CALLED', label: 'Customers called', description: 'Different customers called about payment in the month.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'REACH_RATE', label: 'Reach rate', description: 'Share of payment calls where the customer was spoken to.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'CUSTOMERS_PAID_AFTER_CALL', label: 'Customers who paid after a call', description: `Customers called in the month who paid within ${PAID_AFTER_CALL_DAYS} days of the call. If two officers called, the payment counts for the later call.`, unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'CALL_CONVERSION', label: 'Call conversion', description: 'Share of customers called in the month who paid after the call.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'COLLECTED_AFTER_CALL', label: 'Collected after calls', description: `GHS paid within ${PAID_AFTER_CALL_DAYS} days of their calls. Each payment counts once, for the most recent call before it.`, unit: 'GHS', higherIsBetter: true, cumulative: true },
  { key: 'PROMISES_KEPT', label: 'Promises kept', description: 'Share of promises to pay falling due in the month that were paid in full by the promised day.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'FOLLOW_UPS_ON_TIME', label: 'Follow-ups on time', description: 'Share of follow-ups due in the month that were made by the next day — or not needed because the customer paid.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
  { key: 'VERIFICATIONS_DONE', label: 'Verifications done', description: 'New contracts verified by speaking to the customer.', unit: 'COUNT', higherIsBetter: true, cumulative: true },
  { key: 'PORTFOLIO_COLLECTION_RATE', label: 'Collection rate — my agents', description: 'Collection rate across the agents they cover.', unit: 'PERCENT', higherIsBetter: true, cumulative: false },
];

export const KPI_DEFINITIONS: Record<KpiGroup, KpiDefinition[]> = { AGENT, TEAM, CSO };

export function definitionFor(group: KpiGroup, key: string): KpiDefinition | undefined {
  return KPI_DEFINITIONS[group].find((d) => d.key === key);
}

export function isKpiGroup(value: unknown): value is KpiGroup {
  return typeof value === 'string' && (KPI_GROUPS as string[]).includes(value);
}
