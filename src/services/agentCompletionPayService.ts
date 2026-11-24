/**
 * Monthly completion commission for agents.
 *
 * Counted per selling agent: their customers who finished paying since the
 * start month (any completion counts, inside the contract period or after).
 * Once that running total reaches the threshold, every one of those
 * completions is paid at the set amount — the first ones included — and every
 * later completion is paid in the month it happens. Below the threshold,
 * nothing is paid yet; the completions keep counting.
 *
 * Paid like cluster leaders: a month is previewed while it runs, closed after
 * it ends (in order, from the start month), approved, then each agent is
 * marked paid with the payment reference. A closed month keeps the amount and
 * threshold it was closed with. Each payout lists the contracts it covers, so
 * a completion is never paid twice, even if the contract is later reopened
 * and completed again.
 */
import prisma from '../config/database';
import { ASSIGNABLE_AGENT_ROLES } from '../constants/roles';
import { createAuditLog } from './auditService';

const db = prisma as any;
const round2 = (n: number) => Math.round(n * 100) / 100;

export class CompletionPayError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface CompletionPaySettings {
  amountPerCompletion: number;
  threshold: number;
  startMonth: string;
  updatedById?: string | null;
  updatedAt?: Date | null;
}

const MONTH_RE = /^(\d{4})-(\d{2})$/;

export function monthRange(month: string): { from: Date; to: Date } {
  const m = MONTH_RE.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new CompletionPayError('Month must be YYYY-MM');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { from: new Date(y, mo - 1, 1), to: new Date(y, mo, 1) };
}

export function nextMonth(month: string): string {
  const { to } = monthRange(month);
  return `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}`;
}

export async function getSettings(): Promise<CompletionPaySettings> {
  const row = await db.agentCompletionPaySettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton' }, update: {} });
  return { amountPerCompletion: row.amountPerCompletion, threshold: row.threshold, startMonth: row.startMonth, updatedById: row.updatedById, updatedAt: row.updatedAt };
}

export async function saveSettings(input: Partial<CompletionPaySettings>, adminId: string): Promise<CompletionPaySettings> {
  const before = await getSettings();
  const data: Record<string, unknown> = {};
  if (input.amountPerCompletion !== undefined) {
    const n = Number(input.amountPerCompletion);
    if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new CompletionPayError('Amount per completion must be from 0 to 100,000');
    data.amountPerCompletion = round2(n);
  }
  if (input.threshold !== undefined) {
    const n = Number(input.threshold);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new CompletionPayError('Number of completions must be a whole number from 1');
    data.threshold = n;
  }
  if (input.startMonth !== undefined) {
    monthRange(String(input.startMonth));
    data.startMonth = String(input.startMonth);
  }
  const row = await db.agentCompletionPaySettings.update({ where: { id: 'singleton' }, data: { ...data, updatedById: adminId } });
  await createAuditLog({
    userId: adminId,
    action: 'UPDATE_AGENT_COMPLETION_PAY_SETTINGS',
    entity: 'AgentCompletionPaySettings',
    entityId: 'singleton',
    oldValues: { amountPerCompletion: before.amountPerCompletion, threshold: before.threshold, startMonth: before.startMonth },
    newValues: data,
  });
  return { amountPerCompletion: row.amountPerCompletion, threshold: row.threshold, startMonth: row.startMonth, updatedById: row.updatedById, updatedAt: row.updatedAt };
}

// ---------------------------------------------------------------- figures

export interface CoveredContract {
  id: string;
  contractNumber: string;
  completedAt: string;
}

export interface PayoutAccount {
  number: string;
  network: string | null;
  registeredName: string | null;
  check: string | null;
}

export function payoutOf(u: any): PayoutAccount | null {
  return u?.payoutMomoNumber
    ? { number: u.payoutMomoNumber, network: u.payoutMomoNetwork ?? null, registeredName: u.payoutMomoName ?? null, check: u.payoutMomoCheck ?? null }
    : null;
}

const PAYOUT_SELECT = { payoutMomoNumber: true, payoutMomoNetwork: true, payoutMomoName: true, payoutMomoCheck: true } as const;

export interface AgentLine {
  agentId: string;
  /** Where to send the money; null until the agent sets it in their portal. */
  payout: PayoutAccount | null;
  name: string;
  phone: string | null;
  role: string;
  /** Completions from the start month to the end of this month. */
  completedToDate: number;
  /** Completions in this month alone. */
  completedThisMonth: number;
  qualified: boolean;
  /** How many more completions are needed to qualify (0 once qualified). */
  toGo: number;
  count: number;
  rate: number;
  total: number;
  contracts: CoveredContract[];
  status: 'PREVIEW' | 'PENDING' | 'PAID';
  paidAt: Date | null;
  reference: string | null;
}

/** Contract ids already covered by payouts of other closed months. */
async function alreadyPaid(excludePeriodId?: string): Promise<Set<string>> {
  const rows = await db.agentCompletionPayout.findMany({
    where: excludePeriodId ? { periodId: { not: excludePeriodId } } : {},
    select: { contracts: true },
  });
  const out = new Set<string>();
  for (const r of rows) for (const c of (r.contracts as CoveredContract[]) || []) out.add(c.id);
  return out;
}

export async function computeMonth(
  month: string,
  settings: CompletionPaySettings,
  opts: { agentIds?: string[]; excludePeriodId?: string } = {}
): Promise<AgentLine[]> {
  const range = monthRange(month);
  const start = monthRange(settings.startMonth).from;
  if (range.to <= start) return [];
  const completed = await db.hirePurchaseContract.findMany({
    where: {
      status: 'COMPLETED',
      completedAt: { gte: start, lt: range.to },
      createdBy: { role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } } },
      ...(opts.agentIds ? { createdById: { in: opts.agentIds } } : {}),
    },
    select: {
      id: true, contractNumber: true, completedAt: true, createdById: true,
      createdBy: { select: { firstName: true, lastName: true, phone: true, role: { select: { name: true } }, ...PAYOUT_SELECT } },
    },
    orderBy: { completedAt: 'asc' },
  });
  const paid = await alreadyPaid(opts.excludePeriodId);

  const byAgent = new Map<string, typeof completed>();
  for (const c of completed) {
    const list = byAgent.get(c.createdById) ?? [];
    list.push(c);
    byAgent.set(c.createdById, list);
  }
  const lines: AgentLine[] = [];
  for (const [agentId, list] of byAgent) {
    const who = list[0].createdBy;
    const completedToDate = list.length;
    const qualified = completedToDate >= settings.threshold;
    const due = qualified ? list.filter((c: any) => !paid.has(c.id)) : [];
    lines.push({
      agentId,
      payout: payoutOf(who),
      name: `${who.firstName} ${who.lastName}`.trim(),
      phone: who.phone ?? null,
      role: who.role?.name ?? '',
      completedToDate,
      completedThisMonth: list.filter((c: any) => c.completedAt >= range.from).length,
      qualified,
      toGo: Math.max(0, settings.threshold - completedToDate),
      count: due.length,
      rate: settings.amountPerCompletion,
      total: round2(due.length * settings.amountPerCompletion),
      contracts: due.map((c: any) => ({ id: c.id, contractNumber: c.contractNumber, completedAt: c.completedAt.toISOString() })),
      status: 'PREVIEW',
      paidAt: null,
      reference: null,
    });
  }
  return lines.sort((a, b) => b.total - a.total || b.completedToDate - a.completedToDate || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- months

export interface MonthView {
  month: string;
  status: 'PREVIEW' | 'CLOSED' | 'APPROVED';
  canClose: boolean;
  /** Why it cannot be closed yet, when it cannot. */
  closeBlock: string | null;
  beforeStart: boolean;
  settings: CompletionPaySettings;
  agents: AgentLine[];
  totals: { agents: number; qualified: number; count: number; total: number; paid: number };
}

function totalsOf(agents: AgentLine[]) {
  return {
    agents: agents.length,
    qualified: agents.filter((a) => a.qualified).length,
    count: agents.reduce((s, a) => s + a.count, 0),
    total: round2(agents.reduce((s, a) => s + a.total, 0)),
    paid: round2(agents.reduce((s, a) => s + (a.status === 'PAID' ? a.total : 0), 0)),
  };
}

async function closeBlockFor(month: string, settings: CompletionPaySettings): Promise<string | null> {
  const range = monthRange(month);
  if (month < settings.startMonth) return `Completion commission starts with ${settings.startMonth}.`;
  if (new Date() < range.to) return 'A month can only be closed after it has ended.';
  // In order: every month from the start up to this one must already be closed.
  for (let m = settings.startMonth; m < month; m = nextMonth(m)) {
    if (!(await db.agentCompletionPayPeriod.findUnique({ where: { month: m }, select: { id: true } }))) {
      return `Close ${m} first.`;
    }
  }
  return null;
}

export async function getMonth(month: string, opts: { agentIds?: string[] } = {}): Promise<MonthView> {
  monthRange(month);
  const period = await db.agentCompletionPayPeriod.findUnique({ where: { month } });
  if (!period) {
    const settings = await getSettings();
    const agents = await computeMonth(month, settings, opts);
    const closeBlock = await closeBlockFor(month, settings);
    return {
      month, status: 'PREVIEW', canClose: !closeBlock, closeBlock, beforeStart: month < settings.startMonth,
      settings, agents, totals: totalsOf(agents),
    };
  }
  const settings = period.settingsSnapshot as CompletionPaySettings;
  const payouts = await db.agentCompletionPayout.findMany({
    where: { periodId: period.id, ...(opts.agentIds ? { agentId: { in: opts.agentIds } } : {}) },
  });
  const people = await db.adminUser.findMany({
    where: { id: { in: payouts.map((p: any) => p.agentId) } },
    select: { id: true, firstName: true, lastName: true, phone: true, role: { select: { name: true } }, ...PAYOUT_SELECT },
  });
  const byId = new Map(people.map((p: any) => [p.id, p]));
  const range = monthRange(month);
  const agents: AgentLine[] = payouts.map((p: any) => {
    const who: any = byId.get(p.agentId);
    const contracts = (p.contracts as CoveredContract[]) || [];
    return {
      agentId: p.agentId,
      payout: payoutOf(who),
      name: who ? `${who.firstName} ${who.lastName}`.trim() : 'Former agent',
      phone: who?.phone ?? null,
      role: who?.role?.name ?? '',
      completedToDate: p.completedToDate,
      completedThisMonth: contracts.filter((c) => new Date(c.completedAt) >= range.from).length,
      qualified: p.qualified,
      toGo: Math.max(0, settings.threshold - p.completedToDate),
      count: p.count,
      rate: p.rate,
      total: p.total,
      contracts,
      status: p.status === 'PAID' ? 'PAID' : 'PENDING',
      paidAt: p.paidAt,
      reference: p.reference,
    };
  });
  agents.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    month, status: period.status === 'APPROVED' ? 'APPROVED' : 'CLOSED', canClose: false, closeBlock: null,
    beforeStart: false, settings, agents, totals: totalsOf(agents),
  };
}

async function freeze(periodId: string, lines: AgentLine[], tx: any) {
  await tx.agentCompletionPayout.deleteMany({ where: { periodId } });
  if (!lines.length) return;
  await tx.agentCompletionPayout.createMany({
    data: lines.map((l) => ({
      periodId, agentId: l.agentId, completedToDate: l.completedToDate, qualified: l.qualified,
      count: l.count, rate: l.rate, total: l.total, contracts: l.contracts as any,
    })),
  });
}

export async function closeMonth(month: string, actorId: string): Promise<MonthView> {
  const settings = await getSettings();
  const block = await closeBlockFor(month, settings);
  if (block) throw new CompletionPayError(block, 409);
  if (await db.agentCompletionPayPeriod.findUnique({ where: { month } })) throw new CompletionPayError('This month is already closed.', 409);
  const lines = await computeMonth(month, settings);
  await db.$transaction(async (tx: any) => {
    const period = await tx.agentCompletionPayPeriod.create({
      data: { month, status: 'CLOSED', closedById: actorId, settingsSnapshot: { amountPerCompletion: settings.amountPerCompletion, threshold: settings.threshold, startMonth: settings.startMonth } },
    });
    await freeze(period.id, lines, tx);
  });
  return getMonth(month);
}

export async function recomputeMonth(month: string, useCurrentSettings = false): Promise<MonthView> {
  const period = await db.agentCompletionPayPeriod.findUnique({ where: { month } });
  if (!period) throw new CompletionPayError('This month has not been closed.', 409);
  if (period.status === 'APPROVED') throw new CompletionPayError('An approved month cannot be recalculated.', 409);
  const later = await db.agentCompletionPayPeriod.findFirst({ where: { month: { gt: month } }, select: { month: true } });
  if (later) throw new CompletionPayError(`${later.month} is already closed; reopen it first.`, 409);
  const settings = useCurrentSettings ? await getSettings() : (period.settingsSnapshot as CompletionPaySettings);
  const lines = await computeMonth(month, settings, { excludePeriodId: period.id });
  await db.$transaction(async (tx: any) => {
    await freeze(period.id, lines, tx);
    if (useCurrentSettings) {
      await tx.agentCompletionPayPeriod.update({ where: { id: period.id }, data: { settingsSnapshot: { amountPerCompletion: settings.amountPerCompletion, threshold: settings.threshold, startMonth: settings.startMonth } } });
    }
  });
  return getMonth(month);
}

/** Undo a close that has not been approved, so the month can be closed again later. */
export async function reopenMonth(month: string): Promise<MonthView> {
  const period = await db.agentCompletionPayPeriod.findUnique({ where: { month } });
  if (!period) throw new CompletionPayError('This month has not been closed.', 409);
  if (period.status === 'APPROVED') throw new CompletionPayError('An approved month cannot be reopened.', 409);
  const later = await db.agentCompletionPayPeriod.findFirst({ where: { month: { gt: month } }, select: { month: true } });
  if (later) throw new CompletionPayError(`${later.month} is already closed; reopen it first.`, 409);
  await db.$transaction([
    db.agentCompletionPayout.deleteMany({ where: { periodId: period.id } }),
    db.agentCompletionPayPeriod.delete({ where: { id: period.id } }),
  ]);
  return getMonth(month);
}

export async function approveMonth(month: string, actorId: string): Promise<MonthView> {
  const r = await db.agentCompletionPayPeriod.updateMany({
    where: { month, status: 'CLOSED' },
    data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() },
  });
  if (r.count === 0) throw new CompletionPayError('Close the month before approving it (or it is already approved).', 409);
  return getMonth(month);
}

export async function setPaid(month: string, agentId: string, paid: boolean, actorId: string, reference?: string): Promise<MonthView> {
  const period = await db.agentCompletionPayPeriod.findUnique({ where: { month } });
  if (!period || period.status !== 'APPROVED') throw new CompletionPayError('Approve the month before recording payments.', 409);
  const payout = await db.agentCompletionPayout.findUnique({ where: { periodId_agentId: { periodId: period.id, agentId } } });
  if (!payout) throw new CompletionPayError('No payout for this agent in this month.', 404);
  if (paid) {
    if (payout.total <= 0) throw new CompletionPayError('Nothing is owed to this agent for this month.', 409);
    if (!reference?.trim()) throw new CompletionPayError('Enter the payment reference.');
  }
  await db.agentCompletionPayout.update({
    where: { id: payout.id },
    data: paid
      ? { status: 'PAID', paidAt: new Date(), paidById: actorId, reference: reference!.trim().slice(0, 100) }
      : { status: 'PENDING', paidAt: null, paidById: null, reference: null },
  });
  return getMonth(month);
}

// ---------------------------------------------------------------- agent's own view

export async function myProgress(agentId: string) {
  const settings = await getSettings();
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [line] = month >= settings.startMonth ? await computeMonth(month, settings, { agentIds: [agentId] }) : [];
  const payouts = await db.agentCompletionPayout.findMany({ where: { agentId }, orderBy: { createdAt: 'desc' }, take: 24 });
  const periods = await db.agentCompletionPayPeriod.findMany({ where: { id: { in: payouts.map((p: any) => p.periodId) } }, select: { id: true, month: true, status: true } });
  const periodById = new Map(periods.map((p: any) => [p.id, p]));
  return {
    settings: { amountPerCompletion: settings.amountPerCompletion, threshold: settings.threshold, startMonth: settings.startMonth },
    completedToDate: line?.completedToDate ?? 0,
    qualified: line?.qualified ?? false,
    toGo: line?.toGo ?? settings.threshold,
    /** What this month would pay if it closed now. */
    thisMonth: { month, count: line?.count ?? 0, total: line?.total ?? 0 },
    history: payouts
      .filter((p: any) => p.total > 0)
      .map((p: any) => ({
        month: (periodById.get(p.periodId) as any)?.month ?? null,
        approved: (periodById.get(p.periodId) as any)?.status === 'APPROVED',
        count: p.count,
        total: p.total,
        status: p.status,
        paidAt: p.paidAt,
        reference: p.reference,
      })),
  };
}
