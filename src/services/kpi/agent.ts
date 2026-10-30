import prisma from '../../config/database';
import { getAgentPortfolioRisk } from '../portfolioRiskService';
import { IndicatorKey } from '../clusterScorecard/definitions';
import {
  MonthRange,
  measureCalls,
  measureCollectionRate,
  measureDeposits,
  measurePayments,
  measureQualitySales,
  measureSales,
  measureWriteOffs,
} from '../clusterScorecard/indicators';

/**
 * One seller's own KPIs for a month.
 *
 * These are the cluster scorecard's own measures with the credit going to the
 * seller instead of their leader, so an agent, their leader's team figures and
 * the leader's pay are all counted the same way.
 */

export interface Measured {
  value: number | null;
  count: number;
}

/** Running totals per key; `numerator`/`denominator` carry the ratios. */
export interface Acc {
  sum: number;
  count: number;
  numerator: number;
  denominator: number;
}

export interface SellerKpis {
  values: Record<string, Measured>;
  /** The totals behind each value, so callers can combine sellers (a CSO's agents). */
  raw: Map<string, Acc>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function emptyAcc(): Acc {
  return { sum: 0, count: 0, numerator: 0, denominator: 0 };
}

export function ratioOf(a: Acc | undefined): number | null {
  return a && a.denominator > 0 ? Math.round((a.numerator / a.denominator) * 10000) / 100 : null;
}

export async function computeSellerKpis(
  range: MonthRange,
  agentIds: string[],
  opts: { depositRemitDays: number; includePar: boolean },
): Promise<Map<string, SellerKpis>> {
  const result = new Map<string, SellerKpis>();
  if (!agentIds.length) return result;

  const now = new Date();
  const asOf = now < range.to ? now : range.to;
  const known = new Set(agentIds);
  const acc = new Map<string, Map<string, Acc>>();
  const bucket = (agentId: string, key: string) => {
    let m = acc.get(agentId);
    if (!m) acc.set(agentId, (m = new Map()));
    let a = m.get(key);
    if (!a) m.set(key, (a = emptyAcc()));
    return a;
  };

  // The scorecard's measures, credited to the seller.
  const self = (agentId: string) => agentId;
  const add = (agentId: string | null, key: IndicatorKey, sum: number, count = 1, extra?: Record<string, number>) => {
    if (!agentId || !known.has(agentId)) return;
    const a = bucket(agentId, key);
    a.sum += sum;
    a.count += count;
    a.numerator += extra?.numerator ?? 0;
    a.denominator += extra?.denominator ?? 0;
  };

  await Promise.all([
    measurePayments(range, agentIds, self, add),
    measureCollectionRate(range, asOf, agentIds, self, add),
    measureSales(range, agentIds, self, add),
    measureQualitySales(range, asOf, agentIds, self, add),
    measureDeposits(range, agentIds, self, add, opts.depositRemitDays),
    measureWriteOffs(range, agentIds, self, add),
    measureCalls(range, agentIds, add),
    measureCompletions(range, agentIds, (id) => {
      const a = bucket(id, 'COMPLETED_CONTRACTS');
      a.sum += 1;
      a.count += 1;
    }),
    opts.includePar
      ? getAgentPortfolioRisk(agentIds).then((risk) => {
          for (const [agentId, r] of risk) {
            if (r.outstanding <= 0 || !known.has(agentId)) continue;
            const a = bucket(agentId, 'PAR30');
            a.sum += r.atRisk30;
            a.count += r.contractsAtRisk30;
            a.numerator += r.atRisk30;
            a.denominator += r.outstanding;
          }
        })
      : Promise.resolve(),
  ]);

  for (const agentId of agentIds) {
    const m = acc.get(agentId) || new Map<string, Acc>();
    const sum = (k: string) => round2(m.get(k)?.sum ?? 0);
    const count = (k: string) => m.get(k)?.count ?? 0;
    const values: Record<string, Measured> = {
      COLLECTIONS: { value: sum('COLLECTIONS'), count: count('COLLECTIONS') },
      COLLECTION_RATE: { value: ratioOf(m.get('COLLECTION_RATE')), count: count('COLLECTION_RATE') },
      // Null with no book to measure, and for past months (PAR is only known for today).
      PAR30: { value: opts.includePar ? ratioOf(m.get('PAR30')) : null, count: count('PAR30') },
      ARREARS_RECOVERED: { value: sum('ARREARS_RECOVERED'), count: count('ARREARS_RECOVERED') },
      NEW_CONTRACTS: { value: count('NEW_CONTRACTS'), count: count('NEW_CONTRACTS') },
      QUALITY_CONTRACTS: { value: count('QUALITY_CONTRACTS'), count: count('QUALITY_CONTRACTS') },
      COMPLETED_CONTRACTS: { value: count('COMPLETED_CONTRACTS'), count: count('COMPLETED_CONTRACTS') },
      DEPOSIT_REMITTANCE: { value: ratioOf(m.get('DEPOSIT_REMITTANCE')), count: count('DEPOSIT_REMITTANCE') },
      WRITE_OFFS: { value: sum('WRITE_OFFS'), count: count('WRITE_OFFS') },
      FOLLOW_UP_CALLS: { value: count('FOLLOW_UP_CALLS'), count: count('FOLLOW_UP_CALLS') },
    };
    result.set(agentId, { values, raw: m });
  }
  return result;
}

/** COMPLETED_CONTRACTS: contracts paid off in the month, by the date they completed. */
async function measureCompletions(range: MonthRange, agentIds: string[], add: (agentId: string) => void) {
  const rows = await prisma.hirePurchaseContract.findMany({
    where: { createdById: { in: agentIds }, status: 'COMPLETED', completedAt: { gte: range.from, lt: range.to } },
    select: { createdById: true },
  });
  for (const r of rows) add(r.createdById);
}
