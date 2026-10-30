import prisma from '../../config/database';
import { CLUSTER_AGENT_ROLE, CUSTOMER_SERVICE_ROLE } from '../../constants/roles';
import { computeIndicators, currentMonth, monthRange, MonthRange } from '../clusterScorecard/indicators';
import { computeSellerKpis, Measured } from './agent';
import { computeCsoKpis } from './cso';
import { KPI_DEFINITIONS, KpiGroup, KpiUnit, definitionFor } from './definitions';

/**
 * KPI cards: each person's figures for a month set against the targets an
 * administrator has chosen.
 *
 * Nothing is stored but the targets — every figure is recalculated from
 * contracts, payments and the call log when asked for, so a correction to a
 * payment shows straight away. Targets are monthly. While a month is running,
 * a figure that builds up over the month (collections, sales, calls) is judged
 * against the share of the target that should have been reached by today, so
 * an agent on the 10th is told "on track", not "below target".
 */

export const KPI_SELLER_ROLES = ['AGENT', 'SALES_AGENT', CLUSTER_AGENT_ROLE];

export type KpiStatus = 'MET' | 'ON_TRACK' | 'NEAR' | 'BELOW' | 'NO_TARGET' | 'NOT_MEASURED';

export interface KpiLine {
  key: string;
  label: string;
  description: string;
  unit: KpiUnit;
  higherIsBetter: boolean;
  value: number | null;
  count: number;
  target: number | null;
  /** The share of a cumulative target due by today, while the month runs. */
  expected: number | null;
  status: KpiStatus;
}

export interface KpiCard {
  userId: string;
  name: string;
  phone: string | null;
  role: string;
  group: KpiGroup;
  lines: KpiLine[];
  score: { targeted: number; met: number; near: number; below: number; percent: number | null };
  agentCount?: number;
}

export interface MonthInfo {
  month: string;
  inProgress: boolean;
  /** Share of the month gone, 0–1. 1 once it has ended. */
  elapsed: number;
}

/** Within this share of the target counts as "near". */
const NEAR_SHARE = 0.1;

export function monthInfo(month: string, now = new Date()): MonthInfo & { range: MonthRange } {
  const range = monthRange(month);
  if (range.from > now) throw new Error('That month has not started yet.');
  const inProgress = now < range.to;
  const elapsed = inProgress ? Math.min(1, Math.max(0, (now.getTime() - range.from.getTime()) / (range.to.getTime() - range.from.getTime()))) : 1;
  return { month, inProgress, elapsed, range };
}

export function judge(
  def: { higherIsBetter: boolean; cumulative: boolean },
  value: number | null,
  target: number | null,
  info: Pick<MonthInfo, 'inProgress' | 'elapsed'>,
): { status: KpiStatus; expected: number | null } {
  if (value === null) return { status: 'NOT_MEASURED', expected: null };
  if (target === null) return { status: 'NO_TARGET', expected: null };

  if (!def.higherIsBetter) {
    if (value <= target + 1e-9) return { status: 'MET', expected: null };
    if (target > 0 && value <= target * (1 + NEAR_SHARE)) return { status: 'NEAR', expected: null };
    return { status: 'BELOW', expected: null };
  }

  if (value + 1e-9 >= target) return { status: 'MET', expected: null };
  const prorate = def.cumulative && info.inProgress;
  const expected = prorate ? Math.round(target * info.elapsed * 100) / 100 : null;
  const bar = expected ?? target;
  if (prorate && value + 1e-9 >= bar) return { status: 'ON_TRACK', expected };
  if (value + 1e-9 >= bar * (1 - NEAR_SHARE)) return { status: 'NEAR', expected };
  return { status: 'BELOW', expected };
}

// ─── Targets ───────────────────────────────────────────────────────────────

export async function getTargets(): Promise<Record<KpiGroup, Record<string, number>>> {
  const rows = await prisma.kpiTarget.findMany();
  const out: Record<KpiGroup, Record<string, number>> = { AGENT: {}, TEAM: {}, CSO: {} };
  for (const r of rows) {
    if (r.group in out && definitionFor(r.group as KpiGroup, r.key)) out[r.group as KpiGroup][r.key] = r.target;
  }
  return out;
}

export function validateTarget(group: KpiGroup, key: unknown, target: unknown): { key: string; target: number | null } {
  const def = typeof key === 'string' ? definitionFor(group, key) : undefined;
  if (!def) throw new Error(`Unknown KPI: ${String(key)}`);
  if (target === null || target === undefined || target === '') return { key: def.key, target: null };
  const n = Number(target);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${def.label}: the target must be a number of 0 or more.`);
  if (def.unit === 'PERCENT' && n > 100) throw new Error(`${def.label}: a percentage target cannot be above 100.`);
  if (def.unit === 'COUNT' && !Number.isInteger(n)) throw new Error(`${def.label}: the target must be a whole number.`);
  return { key: def.key, target: Math.round(n * 100) / 100 };
}

/** Replace the targets given for one group; a null target removes it. */
export async function setTargets(group: KpiGroup, items: Array<{ key: string; target: number | null }>, actorId: string) {
  await prisma.$transaction(
    items.map((item) =>
      item.target === null
        ? prisma.kpiTarget.deleteMany({ where: { group, key: item.key } })
        : prisma.kpiTarget.upsert({
            where: { group_key: { group, key: item.key } },
            create: { group, key: item.key, target: item.target, updatedById: actorId },
            update: { target: item.target, updatedById: actorId },
          }),
    ),
  );
  return getTargets();
}

// ─── Cards ─────────────────────────────────────────────────────────────────

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: { name: string };
}

function card(
  group: KpiGroup,
  person: Person,
  values: Record<string, Measured>,
  targets: Record<string, number>,
  info: MonthInfo,
): KpiCard {
  const lines: KpiLine[] = KPI_DEFINITIONS[group].map((def) => {
    const measured = values[def.key] ?? { value: null, count: 0 };
    // PAR is only known for today; showing today's figure against a past month would mislead.
    const value = def.currentOnly && !info.inProgress ? null : measured.value;
    const target = targets[def.key] ?? null;
    const { status, expected } = judge(def, value, target, info);
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      unit: def.unit,
      higherIsBetter: def.higherIsBetter,
      value,
      count: measured.count,
      target,
      expected,
      status,
    };
  });
  const judged = lines.filter((l) => ['MET', 'ON_TRACK', 'NEAR', 'BELOW'].includes(l.status));
  const met = judged.filter((l) => l.status === 'MET' || l.status === 'ON_TRACK').length;
  const near = judged.filter((l) => l.status === 'NEAR').length;
  return {
    userId: person.id,
    name: `${person.firstName} ${person.lastName}`.trim(),
    phone: person.phone,
    role: person.role.name,
    group,
    lines,
    score: {
      targeted: judged.length,
      met,
      near,
      below: judged.length - met - near,
      // Near counts half: close is better than far off, but it is not done.
      percent: judged.length ? Math.round(((met + near / 2) / judged.length) * 100) : null,
    },
  };
}

const personSelect = { id: true, firstName: true, lastName: true, phone: true, role: { select: { name: true } } } as const;

async function depositRemitDays(): Promise<number> {
  const s = await prisma.clusterScorecardSettings.findUnique({ where: { id: 'singleton' }, select: { depositRemitDays: true } });
  return s?.depositRemitDays ?? 7;
}

async function people(where: Record<string, unknown>): Promise<Person[]> {
  return prisma.adminUser.findMany({ where, select: personSelect, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] });
}

export async function sellerCards(month: string, ids?: string[]): Promise<KpiCard[]> {
  const info = monthInfo(month);
  const list = await people(ids ? { id: { in: ids } } : { isActive: true, role: { name: { in: KPI_SELLER_ROLES } } });
  const [measured, targets] = await Promise.all([
    computeSellerKpis(info.range, list.map((p) => p.id), { depositRemitDays: await depositRemitDays(), includePar: info.inProgress }),
    getTargets(),
  ]);
  return list.map((p) => card('AGENT', p, measured.get(p.id)?.values ?? {}, targets.AGENT, info));
}

export async function teamCards(month: string, leaderIds?: string[]): Promise<KpiCard[]> {
  const info = monthInfo(month);
  const [measures, targets, list] = await Promise.all([
    computeIndicators(month, { depositRemitDays: await depositRemitDays(), leaderIds }),
    getTargets(),
    people(leaderIds ? { id: { in: leaderIds } } : { isActive: true, role: { name: CLUSTER_AGENT_ROLE } }),
  ]);
  const byLeader = new Map(measures.map((m) => [m.leaderId, m]));
  return list.map((p) => {
    const m = byLeader.get(p.id);
    const values: Record<string, Measured> = {};
    for (const v of m?.values ?? []) values[v.key] = { value: v.value, count: v.count };
    return { ...card('TEAM', p, values, targets.TEAM, info), agentCount: m?.agentCount ?? 0 };
  });
}

export async function csoCards(month: string, ids?: string[]): Promise<KpiCard[]> {
  const info = monthInfo(month);
  const list = await people(ids ? { id: { in: ids } } : { isActive: true, role: { name: CUSTOMER_SERVICE_ROLE } });
  const [measured, targets] = await Promise.all([computeCsoKpis(info.range, list.map((p) => p.id)), getTargets()]);
  return list.map((p) => card('CSO', p, measured.get(p.id) ?? {}, targets.CSO, info));
}

/** Best first: share of targets met, then the group's headline figure. */
export function rank(cards: KpiCard[]): KpiCard[] {
  const headline: Record<KpiGroup, string> = { AGENT: 'COLLECTIONS', TEAM: 'COLLECTIONS', CSO: 'COLLECTED_AFTER_CALL' };
  const value = (c: KpiCard) => c.lines.find((l) => l.key === headline[c.group])?.value ?? 0;
  return [...cards].sort((a, b) => (b.score.percent ?? -1) - (a.score.percent ?? -1) || value(b) - value(a) || a.name.localeCompare(b.name));
}

/** The caller's agents now — whom a cluster leader may look at. */
export async function currentTeam(leaderId: string): Promise<string[]> {
  const rows = await prisma.clusterAgentAssignment.findMany({ where: { clusterAgentId: leaderId }, select: { agentId: true } });
  return rows.map((r) => r.agentId);
}

export { currentMonth };
