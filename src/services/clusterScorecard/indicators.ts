import prisma from '../../config/database';
import { getAgentPortfolioRisk } from '../portfolioRiskService';
import { CLUSTER_AGENT_ROLE } from '../../constants/roles';
import { IndicatorKey } from './definitions';
import { Interval, intervalsBetween, leaderAt, syncAssignmentHistory } from './history';
import { MeasuredValue } from './payout';

/**
 * Measure every indicator for every cluster leader over one month.
 *
 * Credit follows the agent's leader at the moment of each event: a payment
 * goes to whoever led the selling agent on the day it was paid, a sale to
 * whoever led them on the day it was approved. An agent who moves mid-month
 * is split between the two leaders that way. PAR is taken at month end (or
 * now, for the month in progress) and credited to the leader at that point.
 */

const DAY_MS = 86_400_000;
const LIVE_CONTRACT_STATUSES = ['ACTIVE', 'COMPLETED', 'DEFAULTED', 'WRITTEN_OFF'];

export interface MonthRange {
  month: string; // YYYY-MM
  from: Date;
  to: Date; // exclusive
}

export function monthRange(month: string): MonthRange {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('Month must be YYYY-MM');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error('Month must be YYYY-MM');
  return { month, from: new Date(y, mo - 1, 1), to: new Date(y, mo, 1) };
}

export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export interface LeaderMeasures {
  leaderId: string;
  name: string;
  phone: string | null;
  agentCount: number;
  values: MeasuredValue[];
  detail: Partial<Record<IndicatorKey, Record<string, unknown>>>;
}

interface Acc {
  sum: number;
  count: number;
  extra: Record<string, number>;
}

export async function computeIndicators(month: string, opts: { depositRemitDays: number; leaderIds?: string[] }): Promise<LeaderMeasures[]> {
  const range = monthRange(month);
  const now = new Date();
  const asOf = now < range.to ? now : range.to;
  await syncAssignmentHistory(now);

  const intervals = await intervalsBetween(range.from, range.to);
  const leaders = await prisma.adminUser.findMany({
    where: {
      OR: [
        { role: { name: CLUSTER_AGENT_ROLE }, isActive: true },
        { id: { in: [...new Set(intervals.map((i) => i.clusterAgentId))] } },
      ],
      ...(opts.leaderIds ? { id: { in: opts.leaderIds } } : {}),
    },
    select: { id: true, firstName: true, lastName: true, phone: true },
    orderBy: { firstName: 'asc' },
  });
  const leaderIds = new Set(leaders.map((l) => l.id));
  const agentIds = [...new Set(intervals.filter((i) => leaderIds.has(i.clusterAgentId)).map((i) => i.agentId))];

  const acc = new Map<string, Map<IndicatorKey, Acc>>();
  const add = (leaderId: string | null, key: IndicatorKey, sum: number, count = 1, extra?: Record<string, number>) => {
    if (!leaderId || !leaderIds.has(leaderId)) return;
    let m = acc.get(leaderId);
    if (!m) acc.set(leaderId, (m = new Map()));
    let a = m.get(key);
    if (!a) m.set(key, (a = { sum: 0, count: 0, extra: {} }));
    a.sum += sum;
    a.count += count;
    for (const [k, v] of Object.entries(extra || {})) a.extra[k] = (a.extra[k] || 0) + v;
  };
  const lead = (agentId: string, at: Date) => leaderAt(intervals, agentId, at);

  if (agentIds.length) {
    await Promise.all([
      measurePayments(range, agentIds, lead, add),
      measureCollectionRate(range, asOf, agentIds, lead, add),
      measureSales(range, agentIds, lead, add),
      measureQualitySales(range, asOf, agentIds, lead, add),
      measureDeposits(range, agentIds, lead, add, opts.depositRemitDays),
      measureWriteOffs(range, agentIds, lead, add),
      measurePar(asOf, intervals, agentIds, add),
    ]);
  }
  await Promise.all([measureUnlocks(range, [...leaderIds], add), measureCalls(range, [...leaderIds], add)]);

  return leaders.map((leader) => {
    const m = acc.get(leader.id) || new Map<IndicatorKey, Acc>();
    const get = (k: IndicatorKey) => m.get(k);
    const ratio = (k: IndicatorKey) => {
      const a = get(k);
      return a && a.extra.denominator > 0 ? Math.round((a.extra.numerator / a.extra.denominator) * 10000) / 100 : null;
    };
    const sum = (k: IndicatorKey) => Math.round((get(k)?.sum ?? 0) * 100) / 100;
    const count = (k: IndicatorKey) => get(k)?.count ?? 0;
    const activeAgents = get('ACTIVE_AGENTS')?.extra ?? {};

    const values: MeasuredValue[] = [
      { key: 'COLLECTIONS', value: sum('COLLECTIONS'), count: count('COLLECTIONS') },
      { key: 'COLLECTION_RATE', value: ratio('COLLECTION_RATE'), count: count('COLLECTION_RATE') },
      { key: 'PAR30', value: ratio('PAR30'), count: count('PAR30') },
      { key: 'ARREARS_RECOVERED', value: sum('ARREARS_RECOVERED'), count: count('ARREARS_RECOVERED') },
      { key: 'DEPOSIT_REMITTANCE', value: ratio('DEPOSIT_REMITTANCE'), count: count('DEPOSIT_REMITTANCE') },
      { key: 'NEW_CONTRACTS', value: count('NEW_CONTRACTS'), count: count('NEW_CONTRACTS') },
      { key: 'QUALITY_CONTRACTS', value: count('QUALITY_CONTRACTS'), count: count('QUALITY_CONTRACTS') },
      { key: 'ACTIVE_AGENTS', value: Object.keys(activeAgents).length, count: Object.keys(activeAgents).length },
      { key: 'UNLOCKS_FULFILLED', value: count('UNLOCKS_FULFILLED'), count: count('UNLOCKS_FULFILLED') },
      { key: 'UNLOCKS_DEFAULTED', value: count('UNLOCKS_DEFAULTED'), count: count('UNLOCKS_DEFAULTED') },
      { key: 'WRITE_OFFS', value: sum('WRITE_OFFS'), count: count('WRITE_OFFS') },
      { key: 'FOLLOW_UP_CALLS', value: count('FOLLOW_UP_CALLS'), count: count('FOLLOW_UP_CALLS') },
    ];

    const detail: LeaderMeasures['detail'] = {};
    for (const [k, a] of m) {
      if (k === 'ACTIVE_AGENTS') detail[k] = { agents: Object.keys(a.extra).length };
      else detail[k] = { ...a.extra, events: a.count };
    }

    return {
      leaderId: leader.id,
      name: `${leader.firstName} ${leader.lastName}`.trim(),
      phone: leader.phone,
      agentCount: new Set(intervals.filter((i) => i.clusterAgentId === leader.id).map((i) => i.agentId)).size,
      values,
      detail,
    };
  });
}

type Lead = (agentId: string, at: Date) => string | null;
type Add = (leaderId: string | null, key: IndicatorKey, sum: number, count?: number, extra?: Record<string, number>) => void;

/** COLLECTIONS and ARREARS_RECOVERED: successful payments dated in the month. */
async function measurePayments(range: MonthRange, agentIds: string[], lead: Lead, add: Add) {
  const payments = await prisma.paymentTransaction.findMany({
    where: {
      status: 'SUCCESS',
      contract: { createdById: { in: agentIds } },
      OR: [
        { paymentDate: { gte: range.from, lt: range.to } },
        { paymentDate: null, createdAt: { gte: range.from, lt: range.to } },
      ],
    },
    select: { amount: true, paymentDate: true, createdAt: true, contractId: true, contract: { select: { createdById: true } } },
  });

  // Contracts already 30+ days behind when the month began: an instalment
  // that fell due before (month start − 30 days) and was still unpaid then.
  const cutoff = new Date(range.from.getTime() - 30 * DAY_MS);
  const late = await prisma.installmentSchedule.findMany({
    where: {
      contractId: { in: [...new Set(payments.map((p) => p.contractId))] },
      dueDate: { lt: cutoff },
      OR: [{ paidAt: null, status: { not: 'PAID' } }, { paidAt: { gte: range.from } }],
    },
    select: { contractId: true },
    distinct: ['contractId'],
  });
  const lateContracts = new Set(late.map((l) => l.contractId));

  for (const p of payments) {
    const at = p.paymentDate ?? p.createdAt;
    const leader = lead(p.contract.createdById, at);
    add(leader, 'COLLECTIONS', p.amount);
    if (lateContracts.has(p.contractId)) add(leader, 'ARREARS_RECOVERED', p.amount);
  }
}

/** COLLECTION_RATE: instalment value due in the month against what has been paid of it. */
async function measureCollectionRate(range: MonthRange, asOf: Date, agentIds: string[], lead: Lead, add: Add) {
  const due = await prisma.installmentSchedule.findMany({
    where: {
      dueDate: { gte: range.from, lt: range.to < asOf ? range.to : asOf },
      contract: { createdById: { in: agentIds }, status: { in: LIVE_CONTRACT_STATUSES } },
    },
    select: { dueDate: true, amount: true, paidAmount: true, contract: { select: { createdById: true } } },
  });
  for (const i of due) {
    const paid = Math.min(i.amount, Math.max(0, i.paidAmount));
    add(lead(i.contract.createdById, i.dueDate), 'COLLECTION_RATE', paid, 1, { numerator: paid, denominator: i.amount });
  }
}

/** NEW_CONTRACTS and ACTIVE_AGENTS: sales approved in the month. */
async function measureSales(range: MonthRange, agentIds: string[], lead: Lead, add: Add) {
  const sales = await prisma.hirePurchaseContract.findMany({
    where: { createdById: { in: agentIds }, approvedAt: { gte: range.from, lt: range.to }, status: { not: 'CANCELLED' } },
    select: { createdById: true, approvedAt: true },
  });
  for (const s of sales) {
    const leader = lead(s.createdById, s.approvedAt!);
    add(leader, 'NEW_CONTRACTS', 1);
    add(leader, 'ACTIVE_AGENTS', 0, 0, { [s.createdById]: 1 });
  }
}

/** QUALITY_CONTRACTS: sales approved two months earlier that are still healthy. */
async function measureQualitySales(range: MonthRange, asOf: Date, agentIds: string[], lead: Lead, add: Add) {
  const from = new Date(range.from.getFullYear(), range.from.getMonth() - 2, 1);
  const to = new Date(range.from.getFullYear(), range.from.getMonth() - 1, 1);
  const sales = await prisma.hirePurchaseContract.findMany({
    where: { createdById: { in: agentIds }, approvedAt: { gte: from, lt: to } },
    select: {
      createdById: true,
      approvedAt: true,
      status: true,
      installments: {
        where: { status: { not: 'PAID' }, dueDate: { lt: new Date(asOf.getTime() - 30 * DAY_MS) } },
        select: { id: true },
        take: 1,
      },
    },
  });
  for (const s of sales) {
    const healthy = !['CANCELLED', 'WRITTEN_OFF', 'DEFAULTED'].includes(s.status) && s.installments.length === 0;
    if (healthy) add(lead(s.createdById, s.approvedAt!), 'QUALITY_CONTRACTS', 1);
  }
}

/** DEPOSIT_REMITTANCE: deposits raised in the month, fully paid within the allowed days. */
async function measureDeposits(range: MonthRange, agentIds: string[], lead: Lead, add: Add, allowedDays: number) {
  const entries = await prisma.agentDepositLedger.findMany({
    where: { agentId: { in: agentIds }, createdAt: { gte: range.from, lt: range.to }, status: { not: 'CANCELLED' }, amountDueCompany: { gt: 0 } },
    select: { agentId: true, createdAt: true, status: true, payments: { where: { status: 'SUCCESS' }, select: { paidAt: true } } },
  });
  for (const e of entries) {
    const lastPaid = e.payments.reduce<Date | null>((max, p) => (p.paidAt && (!max || p.paidAt > max) ? p.paidAt : max), null);
    const onTime = e.status === 'PAID' && !!lastPaid && lastPaid.getTime() <= e.createdAt.getTime() + allowedDays * DAY_MS;
    add(lead(e.agentId, e.createdAt), 'DEPOSIT_REMITTANCE', onTime ? 1 : 0, 1, { numerator: onTime ? 1 : 0, denominator: 1 });
  }
}

/** WRITE_OFFS: balance written off in the month. */
async function measureWriteOffs(range: MonthRange, agentIds: string[], lead: Lead, add: Add) {
  const rows = await prisma.hirePurchaseContract.findMany({
    where: { createdById: { in: agentIds }, writtenOffAt: { gte: range.from, lt: range.to } },
    select: { createdById: true, writtenOffAt: true, outstandingBalance: true },
  });
  for (const r of rows) add(lead(r.createdById, r.writtenOffAt!), 'WRITE_OFFS', Math.max(0, r.outstandingBalance));
}

/**
 * PAR30 at month end, credited to whoever led each agent then. Uses the same
 * calculation as the PAR report and the cluster dashboard, so a leader is
 * paid on the number they already see. It is "as of now", which is why a
 * month is closed promptly and frozen.
 */
async function measurePar(asOf: Date, intervals: Interval[], agentIds: string[], add: Add) {
  const risk = await getAgentPortfolioRisk(agentIds);
  const probe = new Date(asOf.getTime() - 1);
  for (const [agentId, r] of risk) {
    if (r.outstanding <= 0) continue;
    add(leaderAt(intervals, agentId, probe), 'PAR30', r.atRisk30, 1, { numerator: r.atRisk30, denominator: r.outstanding });
  }
}

/** UNLOCKS_FULFILLED / UNLOCKS_DEFAULTED: windows the leader asked for, settled in the month. */
async function measureUnlocks(range: MonthRange, leaderIds: string[], add: Add) {
  if (!leaderIds.length) return;
  const rows = await prisma.temporaryUnlockRequest.findMany({
    where: { requestedById: { in: leaderIds }, status: { in: ['FULFILLED', 'DEFAULTED'] }, resolvedAt: { gte: range.from, lt: range.to } },
    select: { requestedById: true, status: true },
  });
  for (const r of rows) add(r.requestedById, r.status === 'FULFILLED' ? 'UNLOCKS_FULFILLED' : 'UNLOCKS_DEFAULTED', 1);
}

/** FOLLOW_UP_CALLS: collection and follow-up calls the leader logged. */
async function measureCalls(range: MonthRange, leaderIds: string[], add: Add) {
  if (!leaderIds.length) return;
  const rows = await prisma.contactAttempt.groupBy({
    by: ['officerId'],
    where: { officerId: { in: leaderIds }, purpose: { in: ['COLLECTION', 'FOLLOW_UP'] }, contactedAt: { gte: range.from, lt: range.to } },
    _count: true,
  });
  for (const r of rows) add(r.officerId, 'FOLLOW_UP_CALLS', r._count, r._count);
}
