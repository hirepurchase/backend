import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { CONTRACT_APPROVAL_ACCESS_PERMISSIONS, PERMISSIONS, hasAnyPermission } from '../constants/permissions';
import { monthEndIssues, monthEndStatus } from '../services/monthEndService';

const db = prisma as any;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AttentionItem {
  key: string;
  label: string;
  count: number;
  amount?: number;
  detail?: string;
  href: string;
  tone: 'red' | 'amber' | 'blue';
}

/**
 * GET /reports/attention — what is waiting on someone, as counts with links,
 * limited to the items this person is allowed to act on. Nothing with a count
 * of zero is returned.
 */
export async function getAttention(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const isSuper = admin.role === 'SUPER_ADMIN';
    const can = (...p: string[]) => isSuper || hasAnyPermission(admin.permissions, p as any);
    const items: AttentionItem[] = [];
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

    const jobs: Array<Promise<void>> = [];
    if (can(...CONTRACT_APPROVAL_ACCESS_PERMISSIONS)) {
      jobs.push(db.hirePurchaseContract.count({ where: { status: 'PENDING_APPROVAL' } }).then((n: number) => {
        if (n) items.push({ key: 'approvals', label: 'Contracts waiting for approval', count: n, href: '/admin/contract-approvals', tone: 'amber' });
      }));
    }
    if (can(PERMISSIONS.EDIT_CONTRACT_VALUES)) {
      jobs.push(db.contractReschedule.count({ where: { status: 'PENDING' } }).then((n: number) => {
        if (n) items.push({ key: 'reschedules', label: 'Reschedule requests waiting', count: n, href: '/admin/reschedules', tone: 'amber' });
      }));
    }
    if (can(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK)) {
      jobs.push(db.temporaryUnlockRequest.count({ where: { status: 'PENDING' } }).then((n: number) => {
        if (n) items.push({ key: 'unlocks', label: 'Temporary unlock requests waiting', count: n, href: '/admin/temporary-unlocks', tone: 'amber' });
      }));
    }
    if (can(PERMISSIONS.MANAGE_AGENT_LEDGER)) {
      jobs.push(db.agentDepositLedger.aggregate({ where: { status: 'PENDING', outstandingBalance: { gt: 0 } }, _count: { _all: true }, _sum: { outstandingBalance: true } }).then((a: any) => {
        if (a._count._all) items.push({ key: 'deposits', label: 'Agent deposits not yet paid in', count: a._count._all, amount: round2(a._sum.outstandingBalance ?? 0), href: '/admin/agent/admin-ledger', tone: 'red' });
      }));
    }
    if (can(PERMISSIONS.VIEW_FAILED_PAYMENTS)) {
      jobs.push(db.paymentTransaction.count({ where: { status: 'FAILED', createdAt: { gte: sevenDaysAgo } } }).then((n: number) => {
        if (n) items.push({ key: 'failed', label: 'Failed payments in the last 7 days', count: n, href: '/admin/failed-payments', tone: 'red' });
      }));
    }
    await Promise.all(jobs);

    // Commission month-end: for those who run or pay the months.
    let monthEnd: { month: string; issues: string[] } | null = null;
    if (can(PERMISSIONS.MANAGE_AGENT_LEDGER, PERMISSIONS.MANAGE_COMMISSION_SETTINGS)) {
      const s = await monthEndStatus();
      const issues = monthEndIssues(s);
      if (issues.length) monthEnd = { month: s.month, issues };
      if (s.agent.stage === 'NOT_CLOSED' || s.agent.stage === 'NOT_APPROVED') {
        items.push({ key: 'agent-month', label: `Agent completion commission: ${s.agent.stage === 'NOT_CLOSED' ? 'last month not closed' : 'waiting for approval'}`, count: 1, href: '/admin/agent/completion-commission', tone: 'blue' });
      }
      if (s.leader.stage === 'NOT_CLOSED' || s.leader.stage === 'NOT_APPROVED') {
        items.push({ key: 'leader-month', label: `Cluster leader pay: ${s.leader.stage === 'NOT_CLOSED' ? 'last month not closed' : 'waiting for approval'}`, count: 1, href: '/admin/cluster-scorecard', tone: 'blue' });
      }
      if (s.unpaidCount) {
        items.push({
          key: 'payouts',
          label: 'Approved commission not yet sent',
          count: s.unpaidCount,
          amount: s.unpaidTotal,
          detail: s.balanceShort && s.balance !== null ? `Paystack balance GHS ${s.balance.toFixed(2)} is not enough` : undefined,
          href: s.agent.stage === 'UNPAID' || !s.leader.unpaidCount ? '/admin/agent/completion-commission' : '/admin/cluster-scorecard',
          tone: s.balanceShort ? 'red' : 'amber',
        });
      }
      if (s.missingNumbers) {
        items.push({ key: 'numbers', label: 'People owed commission with no payout number', count: s.missingNumbers, href: '/admin/agent/completion-commission', tone: 'amber' });
      }
    }

    const order = ['approvals', 'reschedules', 'unlocks', 'deposits', 'failed', 'agent-month', 'leader-month', 'payouts', 'numbers'];
    items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    res.json({ items, monthEnd });
  } catch (error) {
    console.error('Attention error:', error);
    res.status(500).json({ error: 'Failed to load' });
  }
}
