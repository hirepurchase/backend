/**
 * Where last month's commission stands, for the admin dashboard and the
 * month-end reminders: is the agent completion month closed, approved and
 * paid; the same for cluster leader pay; what is approved but not yet sent;
 * and whether the payout gateway balance covers it.
 */
import prisma from '../config/database';
import { createAuditLog } from './auditService';

const db = prisma as any;
const round2 = (n: number) => Math.round(n * 100) / 100;

export type MonthStage = 'NOT_STARTED' | 'NOT_CLOSED' | 'NOT_APPROVED' | 'UNPAID' | 'DONE';

export interface MonthEndStatus {
  month: string;
  agent: { stage: MonthStage; unpaidCount: number; unpaidTotal: number };
  leader: { stage: MonthStage; unpaidCount: number; unpaidTotal: number };
  /** Approved but not yet paid, across every approved month of both kinds. */
  unpaidCount: number;
  unpaidTotal: number;
  /** People owed in approved months who have no payout number. */
  missingNumbers: number;
  gateway: 'PAYSTACK' | 'HUBTEL';
  balance: number | null;
  balanceShort: boolean;
}

export function previousMonth(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

let balanceCache: { at: number; value: number | null } | null = null;
async function paystackBalance(): Promise<number | null> {
  if (balanceCache && Date.now() - balanceCache.at < 5 * 60_000) return balanceCache.value;
  const { getGhsBalance, isPaystackConfigured } = await import('./gateways/paystack');
  const value = isPaystackConfigured() ? await getGhsBalance() : null;
  balanceCache = { at: Date.now(), value };
  return value;
}

async function stageOf(periodModel: string, payoutModel: string, month: string, startMonth: string | null) {
  if (startMonth && month < startMonth) return { stage: 'NOT_STARTED' as MonthStage, unpaidCount: 0, unpaidTotal: 0 };
  const period = await db[periodModel].findUnique({ where: { month } });
  if (!period) return { stage: 'NOT_CLOSED' as MonthStage, unpaidCount: 0, unpaidTotal: 0 };
  if (period.status !== 'APPROVED') return { stage: 'NOT_APPROVED' as MonthStage, unpaidCount: 0, unpaidTotal: 0 };
  const agg = await db[payoutModel].aggregate({ where: { periodId: period.id, status: { not: 'PAID' }, total: { gt: 0 } }, _count: { _all: true }, _sum: { total: true } });
  const unpaidCount = agg._count._all;
  return { stage: (unpaidCount ? 'UNPAID' : 'DONE') as MonthStage, unpaidCount, unpaidTotal: round2(agg._sum.total ?? 0) };
}

export async function monthEndStatus(now = new Date()): Promise<MonthEndStatus> {
  const month = previousMonth(now);
  const [agentSettings, leaderSettings, gwRow] = await Promise.all([
    db.agentCompletionPaySettings.findUnique({ where: { id: 'singleton' } }),
    db.clusterScorecardSettings.findUnique({ where: { id: 'singleton' } }),
    db.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { payoutGateway: true } }),
  ]);
  const [agent, leader] = await Promise.all([
    stageOf('agentCompletionPayPeriod', 'agentCompletionPayout', month, agentSettings?.startMonth ?? '2026-11'),
    stageOf('clusterScorecardPeriod', 'clusterPayout', month, leaderSettings?.effectiveMonth ?? '2026-11'),
  ]);

  // Everything approved and still owed, in any month.
  const [agentOwed, leaderOwed] = await Promise.all([
    db.agentCompletionPayout.findMany({ where: { status: { not: 'PAID' }, total: { gt: 0 }, periodId: { in: (await db.agentCompletionPayPeriod.findMany({ where: { status: 'APPROVED' }, select: { id: true } })).map((p: any) => p.id) } }, select: { agentId: true, total: true } }),
    db.clusterPayout.findMany({ where: { status: { not: 'PAID' }, total: { gt: 0 }, periodId: { in: (await db.clusterScorecardPeriod.findMany({ where: { status: 'APPROVED' }, select: { id: true } })).map((p: any) => p.id) } }, select: { clusterAgentId: true, total: true } }),
  ]);
  const owedIds = [...new Set([...agentOwed.map((r: any) => r.agentId), ...leaderOwed.map((r: any) => r.clusterAgentId)])];
  const missingNumbers = owedIds.length
    ? await db.adminUser.count({ where: { id: { in: owedIds }, payoutMomoNumber: null } })
    : 0;
  const unpaidTotal = round2([...agentOwed, ...leaderOwed].reduce((s: number, r: any) => s + r.total, 0));
  const gateway = gwRow?.payoutGateway === 'HUBTEL' ? 'HUBTEL' : 'PAYSTACK';
  const balance = gateway === 'PAYSTACK' && unpaidTotal > 0 ? await paystackBalance() : null;
  return {
    month,
    agent,
    leader,
    unpaidCount: agentOwed.length + leaderOwed.length,
    unpaidTotal,
    missingNumbers,
    gateway,
    balance,
    balanceShort: balance !== null && balance + 0.005 < unpaidTotal,
  };
}

const STAGE_TEXT: Record<MonthStage, string> = {
  NOT_STARTED: '',
  NOT_CLOSED: 'not closed',
  NOT_APPROVED: 'closed, waiting for approval',
  UNPAID: 'approved, not all paid',
  DONE: 'paid',
};

function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** Plain lines describing what is still to do, empty when nothing is. */
export function monthEndIssues(s: MonthEndStatus): string[] {
  const out: string[] = [];
  const name = monthName(s.month);
  for (const [label, part] of [['Agent completion commission', s.agent], ['Cluster leader pay', s.leader]] as const) {
    if (part.stage === 'NOT_CLOSED' || part.stage === 'NOT_APPROVED') out.push(`${label} for ${name}: ${STAGE_TEXT[part.stage]}.`);
  }
  if (s.unpaidCount) out.push(`GHS ${s.unpaidTotal.toFixed(2)} approved but not yet sent (${s.unpaidCount} ${s.unpaidCount === 1 ? 'person' : 'people'}).`);
  if (s.missingNumbers) out.push(`${s.missingNumbers} of them ${s.missingNumbers === 1 ? 'has' : 'have'} no payout number yet.`);
  if (s.balanceShort && s.balance !== null) out.push(`Paystack balance GHS ${s.balance.toFixed(2)} is less than the GHS ${s.unpaidTotal.toFixed(2)} to pay.`);
  return out;
}

/**
 * Days 2, 5 and 8 of the month at 9:10: if last month's commission is not
 * closed, approved and paid (or the balance cannot cover it), tell the super
 * admins by SMS. Once a day at most, even with several servers running.
 */
export async function sendMonthEndReminders(now = new Date()): Promise<{ sent: number; issues: string[] }> {
  if (![2, 5, 8].includes(now.getDate())) return { sent: 0, issues: [] };
  const status = await monthEndStatus(now);
  const issues = monthEndIssues(status);
  if (!issues.length) return { sent: 0, issues };
  // Compared with when entries were actually written, so measured on the real clock.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const already = await db.auditLog.findFirst({ where: { action: 'MONTH_END_REMINDER', createdAt: { gte: dayStart } }, select: { id: true } });
  if (already) return { sent: 0, issues };
  await createAuditLog({ action: 'MONTH_END_REMINDER', entity: 'Commission', entityId: status.month, newValues: { issues } });
  const admins = await db.adminUser.findMany({ where: { isActive: true, role: { name: 'SUPER_ADMIN' }, phone: { not: null } }, select: { phone: true } });
  const { sendSMS } = await import('./notificationService');
  const message = `Commission reminder: ${issues.join(' ')} Open the admin portal to finish.`.slice(0, 600);
  let sent = 0;
  for (const a of admins) if (await sendSMS({ to: a.phone, message })) sent++;
  return { sent, issues };
}
