/**
 * The cluster leader scorecard's indicators: what each measures, its unit,
 * and which payout rules make sense for it. The rates and amounts live in
 * ClusterScorecardIndicator rows; this file is the fixed catalogue.
 */

export type IndicatorKey =
  | 'COLLECTIONS'
  | 'COLLECTION_RATE'
  | 'PAR30'
  | 'ARREARS_RECOVERED'
  | 'DEPOSIT_REMITTANCE'
  | 'NEW_CONTRACTS'
  | 'QUALITY_CONTRACTS'
  | 'ACTIVE_AGENTS'
  | 'UNLOCKS_FULFILLED'
  | 'UNLOCKS_DEFAULTED'
  | 'WRITE_OFFS'
  | 'FOLLOW_UP_CALLS';

export type PayoutType = 'RATE' | 'PER_UNIT' | 'TARGET' | 'TIERS';
export type Unit = 'GHS' | 'PERCENT' | 'COUNT';

export interface IndicatorDefinition {
  key: IndicatorKey;
  label: string;
  description: string;
  unit: Unit;
  /** Rules an admin may pick for this indicator. */
  payoutTypes: PayoutType[];
  /** Which way is good — sets the default target direction. */
  higherIsBetter: boolean;
}

export const INDICATORS: IndicatorDefinition[] = [
  {
    key: 'COLLECTIONS',
    label: 'Collections',
    description: 'GHS collected in the month on contracts sold by the leader’s agents.',
    unit: 'GHS',
    payoutTypes: ['RATE', 'TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'COLLECTION_RATE',
    label: 'Collection rate',
    description: 'Share of instalment value due in the month that has been paid.',
    unit: 'PERCENT',
    payoutTypes: ['TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'PAR30',
    label: 'Portfolio at risk (PAR30)',
    description: 'Share of the cluster’s outstanding book on contracts more than 30 days behind, at month end.',
    unit: 'PERCENT',
    payoutTypes: ['TARGET', 'TIERS'],
    higherIsBetter: false,
  },
  {
    key: 'ARREARS_RECOVERED',
    label: 'Arrears recovered',
    description: 'GHS paid in the month on contracts that were 30+ days late when the month began.',
    unit: 'GHS',
    payoutTypes: ['RATE', 'TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'DEPOSIT_REMITTANCE',
    label: 'Deposits remitted on time',
    description: 'Share of agent deposits from sales in the month that were fully remitted within the allowed days.',
    unit: 'PERCENT',
    payoutTypes: ['TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'NEW_CONTRACTS',
    label: 'New contracts',
    description: 'Contracts approved in the month.',
    unit: 'COUNT',
    payoutTypes: ['PER_UNIT', 'TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'QUALITY_CONTRACTS',
    label: 'Quality contracts',
    description: 'Contracts approved two months earlier that are still in good standing (not 30+ days late, cancelled or written off).',
    unit: 'COUNT',
    payoutTypes: ['PER_UNIT', 'TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'ACTIVE_AGENTS',
    label: 'Active agents',
    description: 'Agents in the cluster with at least one approved sale in the month.',
    unit: 'COUNT',
    payoutTypes: ['PER_UNIT', 'TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'UNLOCKS_FULFILLED',
    label: 'Temporary unlocks repaid',
    description: 'Temporary unlocks the leader vouched for that ended with the customer catching up.',
    unit: 'COUNT',
    payoutTypes: ['PER_UNIT', 'TARGET', 'TIERS'],
    higherIsBetter: true,
  },
  {
    key: 'UNLOCKS_DEFAULTED',
    label: 'Temporary unlocks defaulted',
    description: 'Temporary unlocks the leader vouched for that ran out unpaid. Usually a deduction.',
    unit: 'COUNT',
    payoutTypes: ['PER_UNIT', 'TARGET', 'TIERS'],
    higherIsBetter: false,
  },
  {
    key: 'WRITE_OFFS',
    label: 'Written off',
    description: 'Outstanding balance written off in the month on the cluster’s contracts. Usually a deduction.',
    unit: 'GHS',
    payoutTypes: ['RATE', 'TARGET', 'TIERS'],
    higherIsBetter: false,
  },
  {
    key: 'FOLLOW_UP_CALLS',
    label: 'Follow-up calls',
    description: 'Collection and follow-up calls the leader logged in the month.',
    unit: 'COUNT',
    payoutTypes: ['PER_UNIT', 'TARGET', 'TIERS'],
    higherIsBetter: true,
  },
];

export const INDICATOR_BY_KEY = new Map(INDICATORS.map((d) => [d.key, d]));
