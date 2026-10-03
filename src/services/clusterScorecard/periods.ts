import prisma from '../../config/database';
import { INDICATORS, INDICATOR_BY_KEY, IndicatorKey, PayoutType } from './definitions';
import { applyRules, IndicatorRule, PayoutResult, ScorecardSettings } from './payout';
import { computeIndicators, currentMonth, LeaderMeasures, monthRange } from './indicators';

/**
 * Month lifecycle for the cluster leader scorecard.
 *
 *   preview   any month not yet closed — computed on request, never stored
 *   close     after the month has ended: values, payouts and the rules used
 *             are frozen, so later rate changes cannot alter it
 *   recompute while CLOSED, re-measure with the snapshot's rules
 *   approve   locks the month for good
 *   paid      per leader, with a reference, once approved
 */

export interface RulesSnapshot {
  indicators: IndicatorRule[];
  settings: ScorecardSettings & { depositRemitDays: number };
}

export interface LeaderScorecard extends PayoutResult {
  leaderId: string;
  name: string;
  phone: string | null;
  agentCount: number;
  status: 'PREVIEW' | 'PENDING' | 'PAID';
  paidAt: Date | null;
  reference: string | null;
}

export interface MonthScorecard {
  month: string;
  status: 'PREVIEW' | 'CLOSED' | 'APPROVED';
  canClose: boolean;
  closedAt: Date | null;
  approvedAt: Date | null;
  rules: RulesSnapshot;
  leaders: LeaderScorecard[];
  totals: { base: number; variable: number; deductions: number; total: number; paid: number };
}

// ─── Rules ─────────────────────────────────────────────────────────────────

async function ensureIndicators() {
  const existing = new Set((await prisma.clusterScorecardIndicator.findMany({ select: { key: true } })).map((r) => r.key));
  const missing = INDICATORS.filter((d) => !existing.has(d.key));
  if (missing.length) {
    await prisma.clusterScorecardIndicator.createMany({
      data: missing.map((d) => ({
        key: d.key,
        enabled: false,
        payoutType: d.payoutTypes[0],
        targetDirection: d.higherIsBetter ? 'GTE' : 'LTE',
        sortOrder: INDICATORS.indexOf(d),
      })),
      skipDuplicates: true,
    });
  }
}

export async function getRules(): Promise<RulesSnapshot> {
  await ensureIndicators();
  const [rows, settings] = await Promise.all([
    prisma.clusterScorecardIndicator.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.clusterScorecardSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton' }, update: {} }),
  ]);
  return {
    indicators: rows
      .filter((r) => INDICATOR_BY_KEY.has(r.key as IndicatorKey))
      .map((r) => ({
        key: r.key as IndicatorKey,
        enabled: r.enabled,
        payoutType: r.payoutType as PayoutType,
        rate: r.rate,
        unitAmount: r.unitAmount,
        target: r.target,
        targetDirection: r.targetDirection === 'LTE' ? 'LTE' : 'GTE',
        targetAmount: r.targetAmount,
        tiers: Array.isArray(r.tiers) ? (r.tiers as Array<{ threshold: number; amount: number }>) : null,
        cap: r.cap,
      })),
    settings: {
      baseAmount: settings.baseAmount,
      parGateEnabled: settings.parGateEnabled,
      parGateCeiling: settings.parGateCeiling,
      gateWithholdsBase: settings.gateWithholdsBase,
      depositRemitDays: settings.depositRemitDays,
    },
  };
}

export function validateRule(input: Record<string, unknown>): Partial<IndicatorRule> & { error?: string } {
  const key = String(input.key || '') as IndicatorKey;
  const def = INDICATOR_BY_KEY.get(key);
  if (!def) return { error: `Unknown indicator ${key}` };
  const payoutType = String(input.payoutType || def.payoutTypes[0]) as PayoutType;
  if (!def.payoutTypes.includes(payoutType)) return { error: `${def.label} cannot be paid by ${payoutType}` };
  const num = (v: unknown, name: string, allowNull = false): number | null | { error: string } => {
    if (v === null || v === undefined || v === '') return allowNull ? null : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : { error: `${def.label}: ${name} must be a number` };
  };
  const rate = num(input.rate, 'rate');
  const unitAmount = num(input.unitAmount, 'amount');
  const target = num(input.target, 'target', true);
  const targetAmount = num(input.targetAmount, 'amount');
  const cap = num(input.cap, 'cap', true);
  for (const v of [rate, unitAmount, target, targetAmount, cap]) if (v && typeof v === 'object') return v;
  if (typeof cap === 'number' && cap < 0) return { error: `${def.label}: cap cannot be negative` };

  let tiers: Array<{ threshold: number; amount: number }> | null = null;
  if (Array.isArray(input.tiers)) {
    tiers = [];
    for (const t of input.tiers as Array<Record<string, unknown>>) {
      const threshold = Number(t?.threshold);
      const amount = Number(t?.amount);
      if (!Number.isFinite(threshold) || !Number.isFinite(amount)) return { error: `${def.label}: every tier needs a threshold and an amount` };
      tiers.push({ threshold, amount });
    }
    if (tiers.length > 10) return { error: `${def.label}: at most 10 tiers` };
  }
  const enabled = Boolean(input.enabled);
  if (enabled && payoutType === 'TARGET' && target === null) return { error: `${def.label}: set a target` };
  if (enabled && payoutType === 'TIERS' && !tiers?.length) return { error: `${def.label}: add at least one tier` };

  return {
    key,
    enabled,
    payoutType,
    rate: rate as number,
    unitAmount: unitAmount as number,
    target: target as number | null,
    targetDirection: input.targetDirection === 'LTE' ? 'LTE' : input.targetDirection === 'GTE' ? 'GTE' : def.higherIsBetter ? 'GTE' : 'LTE',
    targetAmount: targetAmount as number,
    tiers,
    cap: cap as number | null,
  };
}

// ─── Months ────────────────────────────────────────────────────────────────

function score(measures: LeaderMeasures[], rules: RulesSnapshot): Array<LeaderMeasures & PayoutResult> {
  return measures.map((m) => ({ ...m, ...applyRules(m.values, rules.indicators, rules.settings) }));
}

function totalsOf(leaders: LeaderScorecard[]) {
  const sum = (f: (l: LeaderScorecard) => number) => Math.round(leaders.reduce((s, l) => s + f(l), 0) * 100) / 100;
  return {
    base: sum((l) => l.base),
    variable: sum((l) => l.variable),
    deductions: sum((l) => l.deductions),
    total: sum((l) => l.total),
    paid: sum((l) => (l.status === 'PAID' ? l.total : 0)),
  };
}

export async function getMonth(month: string, leaderIds?: string[]): Promise<MonthScorecard> {
  const range = monthRange(month);
  const period = await prisma.clusterScorecardPeriod.findUnique({ where: { month } });

  if (!period) {
    const rules = await getRules();
    const measures = await computeIndicators(month, { depositRemitDays: rules.settings.depositRemitDays, leaderIds });
    const leaders: LeaderScorecard[] = score(measures, rules).map((s) => ({
      ...s,
      status: 'PREVIEW',
      paidAt: null,
      reference: null,
    }));
    return {
      month,
      status: 'PREVIEW',
      canClose: new Date() >= range.to,
      closedAt: null,
      approvedAt: null,
      rules,
      leaders,
      totals: totalsOf(leaders),
    };
  }

  const [lines, payouts] = await Promise.all([
    prisma.clusterScorecardLine.findMany({ where: { periodId: period.id, ...(leaderIds ? { clusterAgentId: { in: leaderIds } } : {}) } }),
    prisma.clusterPayout.findMany({ where: { periodId: period.id, ...(leaderIds ? { clusterAgentId: { in: leaderIds } } : {}) } }),
  ]);
  const people = await prisma.adminUser.findMany({
    where: { id: { in: payouts.map((p) => p.clusterAgentId) } },
    select: { id: true, firstName: true, lastName: true, phone: true },
  });
  const personById = new Map(people.map((p) => [p.id, p]));
  const rules = period.rulesSnapshot as unknown as RulesSnapshot;
  const order = new Map(rules.indicators.map((r, i) => [r.key, i]));

  const leaders: LeaderScorecard[] = payouts
    .map((p) => {
      const person = personById.get(p.clusterAgentId);
      const own = lines
        .filter((l) => l.clusterAgentId === p.clusterAgentId)
        .sort((a, b) => (order.get(a.indicatorKey as IndicatorKey) ?? 99) - (order.get(b.indicatorKey as IndicatorKey) ?? 99));
      const detail = (k: string) => (own.find((l) => l.indicatorKey === k)?.detail as Record<string, unknown> | null) || {};
      return {
        leaderId: p.clusterAgentId,
        name: person ? `${person.firstName} ${person.lastName}`.trim() : 'Former leader',
        phone: person?.phone ?? null,
        agentCount: Number(detail('_meta').agentCount ?? 0),
        lines: own
          .filter((l) => l.indicatorKey !== '_meta')
          .map((l) => ({
            key: l.indicatorKey as IndicatorKey,
            value: (l.detail as any)?.isNull ? null : l.value,
            count: l.count,
            payout: l.payout,
            explanation: String((l.detail as any)?.explanation ?? ''),
          })),
        base: p.base,
        variable: p.variable,
        deductions: p.deductions,
        total: p.total,
        gated: p.gated,
        gateReason: (detail('_meta').gateReason as string | null) ?? null,
        status: p.status === 'PAID' ? 'PAID' : 'PENDING',
        paidAt: p.paidAt,
        reference: p.reference,
      } as LeaderScorecard;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    month,
    status: period.status === 'APPROVED' ? 'APPROVED' : 'CLOSED',
    canClose: false,
    closedAt: period.closedAt,
    approvedAt: period.approvedAt,
    rules,
    leaders,
    totals: totalsOf(leaders),
  };
}

async function freeze(periodId: string, scored: Array<LeaderMeasures & PayoutResult>) {
  await prisma.$transaction(async (tx) => {
    await tx.clusterScorecardLine.deleteMany({ where: { periodId } });
    await tx.clusterPayout.deleteMany({ where: { periodId } });
    for (const s of scored) {
      await tx.clusterScorecardLine.createMany({
        data: [
          ...s.lines.map((l) => ({
            periodId,
            clusterAgentId: s.leaderId,
            indicatorKey: l.key,
            value: l.value ?? 0,
            count: l.count,
            payout: l.payout,
            detail: { explanation: l.explanation, isNull: l.value === null, ...(s.detail[l.key] || {}) } as any,
          })),
          {
            periodId,
            clusterAgentId: s.leaderId,
            indicatorKey: '_meta',
            value: 0,
            count: 0,
            payout: 0,
            detail: { agentCount: s.agentCount, gateReason: s.gateReason } as any,
          },
        ],
      });
      await tx.clusterPayout.create({
        data: {
          periodId,
          clusterAgentId: s.leaderId,
          base: s.base,
          variable: s.variable,
          deductions: s.deductions,
          total: s.total,
          gated: s.gated,
        },
      });
    }
  });
}

export async function closeMonth(month: string, actorId: string): Promise<MonthScorecard> {
  const range = monthRange(month);
  if (new Date() < range.to) throw new Error('A month can only be closed after it has ended.');
  if (await prisma.clusterScorecardPeriod.findUnique({ where: { month } })) throw new Error('This month is already closed.');
  const rules = await getRules();
  const measures = await computeIndicators(month, { depositRemitDays: rules.settings.depositRemitDays });
  const period = await prisma.clusterScorecardPeriod.create({
    data: { month, status: 'CLOSED', rulesSnapshot: rules as any, closedById: actorId },
  });
  await freeze(period.id, score(measures, rules));
  return getMonth(month);
}

export async function recomputeMonth(month: string, actorId: string, useCurrentRules = false): Promise<MonthScorecard> {
  const period = await prisma.clusterScorecardPeriod.findUnique({ where: { month } });
  if (!period) throw new Error('This month has not been closed.');
  if (period.status === 'APPROVED') throw new Error('An approved month cannot be recomputed.');
  const rules = useCurrentRules ? await getRules() : (period.rulesSnapshot as unknown as RulesSnapshot);
  const measures = await computeIndicators(month, { depositRemitDays: rules.settings.depositRemitDays });
  await freeze(period.id, score(measures, rules));
  await prisma.clusterScorecardPeriod.update({
    where: { id: period.id },
    data: { rulesSnapshot: rules as any, closedById: actorId, closedAt: new Date() },
  });
  return getMonth(month);
}

export async function approveMonth(month: string, actorId: string): Promise<MonthScorecard> {
  const period = await prisma.clusterScorecardPeriod.findUnique({ where: { month } });
  if (!period) throw new Error('Close the month before approving it.');
  if (period.status === 'APPROVED') throw new Error('This month is already approved.');
  await prisma.clusterScorecardPeriod.update({
    where: { id: period.id },
    data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() },
  });
  return getMonth(month);
}

export async function setPaid(month: string, leaderId: string, paid: boolean, actorId: string, reference?: string): Promise<MonthScorecard> {
  const period = await prisma.clusterScorecardPeriod.findUnique({ where: { month } });
  if (!period || period.status !== 'APPROVED') throw new Error('Approve the month before recording payments.');
  const payout = await prisma.clusterPayout.findUnique({ where: { periodId_clusterAgentId: { periodId: period.id, clusterAgentId: leaderId } } });
  if (!payout) throw new Error('No payout for this leader in this month.');
  if (paid && !reference?.trim()) throw new Error('Enter the payment reference.');
  await prisma.clusterPayout.update({
    where: { id: payout.id },
    data: paid
      ? { status: 'PAID', paidAt: new Date(), paidById: actorId, reference: reference!.trim().slice(0, 100) }
      : { status: 'PENDING', paidAt: null, paidById: null, reference: null },
  });
  return getMonth(month);
}

export { currentMonth };
