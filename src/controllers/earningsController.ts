import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { myProgress } from '../services/agentCompletionPayService';

const db = prisma as any;
const round2 = (n: number) => Math.round(n * 100) / 100;
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * GET /earnings/mine — everything the signed-in agent or cluster leader earns,
 * in one place: commission kept at each sale, the monthly completion
 * commission, leader pay (for leaders), what has been paid and what is on its
 * way, and whether their payout number is set.
 */
export async function getMyEarnings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const me = req.user as AdminUserPayload;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const [user, ledger, allTime, owed, recent] = await Promise.all([
      db.adminUser.findUnique({ where: { id: me.id }, select: { payoutMomoNumber: true, payoutMomoNetwork: true, payoutMomoName: true, payoutMomoCheck: true } }),
      db.agentDepositLedger.findMany({ where: { agentId: me.id, status: { not: 'CANCELLED' }, createdAt: { gte: yearStart < sixMonthsAgo ? yearStart : sixMonthsAgo } }, select: { createdAt: true, commissionAmount: true } }),
      db.agentDepositLedger.aggregate({ where: { agentId: me.id, status: { not: 'CANCELLED' } }, _count: { _all: true }, _sum: { commissionAmount: true } }),
      db.agentDepositLedger.aggregate({ where: { agentId: me.id, status: 'PENDING', outstandingBalance: { gt: 0 } }, _count: { _all: true }, _sum: { outstandingBalance: true } }),
      db.commissionTransfer.findMany({ where: { recipientId: me.id, status: { in: ['QUEUED', 'SENDING', 'PENDING'] } }, select: { amount: true } }),
    ]);

    const sum = (rows: any[]) => round2(rows.reduce((s, r) => s + (r.commissionAmount || 0), 0));
    const thisMonthRows = ledger.filter((r: any) => r.createdAt >= monthStart);
    const thisYearRows = ledger.filter((r: any) => r.createdAt >= yearStart);
    const months: Array<{ month: string; sales: number; saleCommission: number; completionPaid: number; leaderPaid: number }> = [];
    for (let i = 5; i >= 0; i--) {
      const m = monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1));
      const rows = ledger.filter((r: any) => monthKey(r.createdAt) === m);
      months.push({ month: m, sales: rows.length, saleCommission: sum(rows), completionPaid: 0, leaderPaid: 0 });
    }

    // Monthly pay, by the month it was earned for.
    const completionRows = await db.agentCompletionPayout.findMany({ where: { agentId: me.id, total: { gt: 0 } }, select: { periodId: true, total: true, count: true, carriedOver: true, status: true, paidAt: true, reference: true } });
    const leaderRows = me.role === 'CLUSTER_AGENT'
      ? await db.clusterPayout.findMany({ where: { clusterAgentId: me.id, total: { gt: 0 } }, select: { periodId: true, total: true, status: true, paidAt: true, reference: true } })
      : [];
    const [cPeriods, lPeriods] = await Promise.all([
      db.agentCompletionPayPeriod.findMany({ where: { id: { in: completionRows.map((r: any) => r.periodId) } }, select: { id: true, month: true, status: true } }),
      db.clusterScorecardPeriod.findMany({ where: { id: { in: leaderRows.map((r: any) => r.periodId) } }, select: { id: true, month: true, status: true } }),
    ]);
    const cBy = new Map(cPeriods.map((p: any) => [p.id, p]));
    const lBy = new Map(lPeriods.map((p: any) => [p.id, p]));
    const payouts = [
      ...completionRows.map((r: any) => ({ kind: 'COMPLETION' as const, month: (cBy.get(r.periodId) as any)?.month, approved: (cBy.get(r.periodId) as any)?.status === 'APPROVED', amount: r.total, count: r.count, carriedOver: r.carriedOver ?? 0, status: r.status, paidAt: r.paidAt, reference: r.reference })),
      ...leaderRows.map((r: any) => ({ kind: 'LEADER' as const, month: (lBy.get(r.periodId) as any)?.month, approved: (lBy.get(r.periodId) as any)?.status === 'APPROVED', amount: r.total, count: null, carriedOver: 0, status: r.status, paidAt: r.paidAt, reference: r.reference })),
    ].filter((p) => p.month).sort((a, b) => b.month.localeCompare(a.month));
    for (const p of payouts) {
      const row = months.find((m) => m.month === p.month);
      if (row && p.status === 'PAID') {
        if (p.kind === 'COMPLETION') row.completionPaid = round2(row.completionPaid + p.amount);
        else row.leaderPaid = round2(row.leaderPaid + p.amount);
      }
    }
    const paidThisYear = round2(payouts.filter((p) => p.status === 'PAID' && p.paidAt && new Date(p.paidAt) >= yearStart).reduce((s, p) => s + p.amount, 0));
    const waitingApproval = round2(payouts.filter((p) => p.status !== 'PAID' && !p.approved).reduce((s, p) => s + p.amount, 0));
    const approvedUnpaid = round2(payouts.filter((p) => p.status !== 'PAID' && p.approved).reduce((s, p) => s + p.amount, 0));

    // Leader pay so far this month (live, not yet owed).
    let leaderThisMonth: { month: string; total: number; lines: Array<{ label: string; count: number; payout: number }> } | null = null;
    if (me.role === 'CLUSTER_AGENT') {
      try {
        const { getMonth } = await import('../services/clusterScorecard/periods');
        const { INDICATOR_BY_KEY } = await import('../services/clusterScorecard/definitions');
        const m = monthKey(now);
        const view = await getMonth(m, [me.id]);
        const card = view.leaders.find((l) => l.leaderId === me.id);
        if (card) {
          leaderThisMonth = {
            month: m,
            total: card.total,
            lines: card.lines.filter((l) => l.payout !== 0).map((l) => ({ label: INDICATOR_BY_KEY.get(l.key)?.label ?? l.key, count: l.count, payout: l.payout })),
          };
        }
      } catch (err) {
        console.warn('Earnings: leader preview unavailable', (err as Error)?.message || err);
      }
    }

    res.json({
      role: me.role,
      payoutAccount: user?.payoutMomoNumber ? { number: user.payoutMomoNumber, network: user.payoutMomoNetwork, registeredName: user.payoutMomoName, check: user.payoutMomoCheck } : null,
      sale: {
        thisMonth: { count: thisMonthRows.length, amount: sum(thisMonthRows) },
        thisYear: { count: thisYearRows.length, amount: sum(thisYearRows) },
        allTime: { count: allTime._count._all, amount: round2(allTime._sum.commissionAmount ?? 0) },
        depositsToPayIn: { count: owed._count._all, amount: round2(owed._sum.outstandingBalance ?? 0) },
      },
      completion: await myProgress(me.id),
      leaderThisMonth,
      payouts: payouts.slice(0, 24),
      totals: {
        paidThisYear,
        onTheWay: round2(recent.reduce((s: number, r: any) => s + r.amount, 0)),
        approvedUnpaid,
        waitingApproval,
      },
      months,
    });
  } catch (error) {
    console.error('Earnings error:', error);
    res.status(500).json({ error: 'Failed to load your earnings' });
  }
}
