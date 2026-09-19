import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { getSupervisionSettings } from '../services/supervisionService';
import { breachesParLimit, getAgentPortfolioRisk } from '../services/portfolioRiskService';
import { resolveContractScope } from '../services/scopeService';

const prismaAny = prisma as any;
const DAY_MS = 86_400_000;

/** Arrears ageing. The 30+ bands are what PAR30 is built from. */
const BUCKETS = [
  { key: 'current', label: 'Not late', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1–30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31–60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90 days', min: 61, max: 90 },
  { key: 'd90', label: 'Over 90 days', min: 91, max: Infinity },
];

function daysLateOf(installments: any[], now: number): number {
  const unpaid = installments.filter((i: any) => i.amount - i.paidAmount > 0.005);
  if (unpaid.length === 0) return 0;
  const oldest = Math.min(...unpaid.map((i: any) => new Date(i.dueDate).getTime()));
  return Math.floor((now - oldest) / DAY_MS);
}

// GET /reports/portfolio-at-risk
export async function getPortfolioAtRiskReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const scope = await resolveContractScope(admin);

    // A cluster leader or officer opening this sees their own people only;
    // an admin sees the whole book.
    let agentFilter: string[] | null = null;
    if (scope.mode === 'assigned') agentFilter = (scope as any).agentIds;
    else if (scope.mode === 'own') agentFilter = [admin.id];
    else if (scope.mode === 'none') {
      res.json({ summary: null, buckets: [], agents: [], clusters: [] });
      return;
    }

    const now = Date.now();
    const [settings, risk, contracts, sellers, clusterRows] = await Promise.all([
      getSupervisionSettings(),
      getAgentPortfolioRisk(agentFilter ?? undefined),
      prismaAny.hirePurchaseContract.findMany({
        where: { status: 'ACTIVE', ...(agentFilter ? { createdById: { in: agentFilter } } : {}) },
        select: {
          createdById: true,
          outstandingBalance: true,
          installments: {
            where: { status: { in: ['OVERDUE', 'PARTIAL', 'PENDING'] }, dueDate: { lt: new Date() } },
            select: { dueDate: true, amount: true, paidAmount: true },
          },
          temporaryUnlocks: { where: { status: 'APPROVED', expiresAt: { gt: new Date() } }, select: { id: true } },
        },
      }),
      prismaAny.adminUser.findMany({
        where: { role: { name: { in: ['AGENT', 'SALES_AGENT', 'CLUSTER_AGENT'] } }, ...(agentFilter ? { id: { in: agentFilter } } : {}) },
        select: { id: true, firstName: true, lastName: true, phone: true, area: true, district: true, isActive: true, role: { select: { name: true } } },
      }),
      prismaAny.clusterAgentAssignment.findMany({
        select: { agentId: true, clusterAgent: { select: { id: true, firstName: true, lastName: true } } },
      }),
    ]);

    const leaderOf = new Map<string, { id: string; name: string }>(
      clusterRows.map((r: any) => [r.agentId, { id: r.clusterAgent.id, name: `${r.clusterAgent.firstName} ${r.clusterAgent.lastName}`.trim() }])
    );

    // Ageing and the headline figures are both computed over every active
    // contract in scope, so the two halves of the page reconcile. The agent
    // table below covers only contracts with an agent on them — 458 active
    // contracts were created under an admin login and have no agent recorded,
    // and silently dropping them would understate the book.
    const sellerIds = new Set(sellers.map((s: any) => s.id));
    const buckets = BUCKETS.map((b) => ({ ...b, contracts: 0, amount: 0 }));
    let underWindowAmount = 0;
    let underWindowContracts = 0;
    let bookOutstanding = 0;
    let bookAtRisk1 = 0;
    let bookAtRisk30 = 0;
    const unattributed = { contracts: 0, outstanding: 0, atRisk30: 0 };

    for (const c of contracts) {
      bookOutstanding += c.outstandingBalance;
      const orphan = !sellerIds.has(c.createdById);
      if (orphan) {
        unattributed.contracts += 1;
        unattributed.outstanding += c.outstandingBalance;
      }
      if ((c.temporaryUnlocks ?? []).length > 0) {
        underWindowContracts += 1;
        underWindowAmount += c.outstandingBalance;
        continue;
      }
      const d = daysLateOf(c.installments, now);
      const b = buckets.find((x) => d >= x.min && d <= x.max) ?? buckets[0];
      b.contracts += 1;
      b.amount += c.outstandingBalance;
      if (d >= 1) bookAtRisk1 += c.outstandingBalance;
      if (d > 30) {
        bookAtRisk30 += c.outstandingBalance;
        if (orphan) unattributed.atRisk30 += c.outstandingBalance;
      }
    }

    const agents = sellers
      .map((s: any) => {
        const r = risk.get(s.id);
        const leader = leaderOf.get(s.id) ?? null;
        return {
          id: s.id,
          name: `${s.firstName} ${s.lastName}`.trim(),
          role: s.role.name,
          phone: s.phone,
          area: s.area,
          district: s.district,
          isActive: s.isActive,
          clusterAgentId: leader?.id ?? null,
          clusterAgentName: leader?.name ?? null,
          activeContracts: r?.activeContracts ?? 0,
          outstanding: r?.outstanding ?? 0,
          atRisk1: r?.atRisk1 ?? 0,
          atRisk30: r?.atRisk30 ?? 0,
          contractsAtRisk30: r?.contractsAtRisk30 ?? 0,
          par1: r?.par1 ?? 0,
          par30: r?.par30 ?? 0,
          overLimit: r ? breachesParLimit(r, settings) : false,
          // An agent below the minimum book size is measured but not judged.
          judged: (r?.activeContracts ?? 0) >= settings.parBlockMinContracts,
        };
      })
      .filter((a: any) => a.activeContracts > 0)
      .sort((a: any, b: any) => b.par30 - a.par30);

    // Roll up by cluster leader, so a whole team's risk is visible at once.
    const clusterMap = new Map<string, any>();
    for (const a of agents) {
      const key = a.clusterAgentId ?? 'none';
      const e = clusterMap.get(key) ?? {
        id: a.clusterAgentId,
        name: a.clusterAgentName ?? 'No cluster leader',
        agents: 0, activeContracts: 0, outstanding: 0, atRisk30: 0, overLimit: 0,
      };
      e.agents += 1;
      e.activeContracts += a.activeContracts;
      e.outstanding += a.outstanding;
      e.atRisk30 += a.atRisk30;
      if (a.overLimit) e.overLimit += 1;
      clusterMap.set(key, e);
    }
    const clusters = [...clusterMap.values()]
      .map((c) => ({ ...c, par30: c.outstanding > 0 ? Math.round((c.atRisk30 / c.outstanding) * 1000) / 10 : 0 }))
      .sort((a, b) => b.par30 - a.par30);

    const round = (n: number) => Math.round(n * 100) / 100;

    res.json({
      summary: {
        agents: agents.length,
        activeContracts: contracts.length,
        outstanding: round(bookOutstanding),
        atRisk1: round(bookAtRisk1),
        atRisk30: round(bookAtRisk30),
        par1: bookOutstanding > 0 ? Math.round((bookAtRisk1 / bookOutstanding) * 1000) / 10 : 0,
        par30: bookOutstanding > 0 ? Math.round((bookAtRisk30 / bookOutstanding) * 1000) / 10 : 0,
        overLimit: agents.filter((a: any) => a.overLimit).length,
        underUnlockWindow: { contracts: underWindowContracts, amount: round(underWindowAmount) },
        // Contracts created under an admin login, with no agent to attribute
        // the risk to. They count in the book and in the ageing, and in nobody's
        // PAR — worth seeing rather than quietly excluding.
        unattributed: {
          contracts: unattributed.contracts,
          outstanding: round(unattributed.outstanding),
          atRisk30: round(unattributed.atRisk30),
        },
      },
      settings: {
        enabled: settings.parBlockEnabled,
        threshold: settings.parBlockThreshold,
        minContracts: settings.parBlockMinContracts,
      },
      buckets: buckets.map((b) => ({ key: b.key, label: b.label, contracts: b.contracts, amount: Math.round(b.amount * 100) / 100 })),
      agents,
      clusters,
    });
  } catch (error) {
    console.error('getPortfolioAtRiskReport error:', error);
    res.status(500).json({ error: 'Failed to build the portfolio at risk report' });
  }
}

// GET /reports/portfolio-at-risk/:agentId
//
// The customers behind one agent's number — the list someone actually chases.
export async function getAgentAtRiskContracts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { agentId } = req.params;
    const scope = await resolveContractScope(admin);
    if (scope.mode === 'assigned' && !(scope as any).agentIds.includes(agentId)) {
      res.status(403).json({ error: 'That agent is outside your portfolio' });
      return;
    }
    if (scope.mode === 'own' && agentId !== admin.id) {
      res.status(403).json({ error: 'That agent is outside your portfolio' });
      return;
    }
    if (scope.mode === 'none') {
      res.json({ contracts: [] });
      return;
    }

    const now = Date.now();
    const contracts = await prismaAny.hirePurchaseContract.findMany({
      where: { status: 'ACTIVE', createdById: agentId },
      select: {
        id: true,
        contractNumber: true,
        outstandingBalance: true,
        penaltyOutstanding: true,
        customer: { select: { firstName: true, lastName: true, phone: true, membershipId: true } },
        managedDevice: { select: { actualState: true } },
        installments: {
          where: { status: { in: ['OVERDUE', 'PARTIAL', 'PENDING'] }, dueDate: { lt: new Date() } },
          select: { dueDate: true, amount: true, paidAmount: true },
        },
        temporaryUnlocks: { where: { status: 'APPROVED', expiresAt: { gt: new Date() } }, select: { expiresAt: true } },
      },
    });

    const rows = contracts
      .map((c: any) => {
        const unpaid = c.installments.filter((i: any) => i.amount - i.paidAmount > 0.005);
        const daysLate = daysLateOf(c.installments, now);
        return {
          id: c.id,
          contractNumber: c.contractNumber,
          customerName: `${c.customer.firstName} ${c.customer.lastName}`.trim(),
          phone: c.customer.phone,
          membershipId: c.customer.membershipId,
          daysLate,
          overdueAmount: Math.round(unpaid.reduce((s: number, i: any) => s + (i.amount - i.paidAmount), 0) * 100) / 100,
          missedInstallments: unpaid.length,
          outstanding: c.outstandingBalance,
          penaltyOutstanding: c.penaltyOutstanding ?? 0,
          deviceState: c.managedDevice?.actualState ?? null,
          unlockWindowEnds: c.temporaryUnlocks?.[0]?.expiresAt ?? null,
        };
      })
      .filter((r: any) => r.daysLate > 0)
      .sort((a: any, b: any) => b.daysLate - a.daysLate);

    res.json({ contracts: rows });
  } catch (error) {
    console.error('getAgentAtRiskContracts error:', error);
    res.status(500).json({ error: 'Failed to load the agent\'s customers' });
  }
}
