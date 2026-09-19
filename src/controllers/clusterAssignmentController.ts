import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { getAgentPortfolioRisk } from '../services/portfolioRiskService';
import { CLUSTER_SUPERVISABLE_ROLES, CLUSTER_AGENT_ROLE } from '../constants/roles';

// GET /admin-users/:id/cluster-agents
export async function getClusterAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const clusterAgent = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
    });

    if (!clusterAgent) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [assignments, assignableAgents] = await Promise.all([
      prisma.clusterAgentAssignment.findMany({
        where: { clusterAgentId: id },
        include: {
          agent: {
            select: { id: true, firstName: true, lastName: true, email: true, role: { select: { name: true } } },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.adminUser.findMany({
        where: { isActive: true, role: { name: { in: [...CLUSTER_SUPERVISABLE_ROLES] } } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          role: { select: { name: true } },
          // Surfaced so the picker can say who is already spoken for rather
          // than failing on save — an agent has exactly one cluster agent.
          agentCluster: {
            select: {
              clusterAgentId: true,
              clusterAgent: { select: { firstName: true, lastName: true } },
            },
          },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
    ]);

    res.json({
      clusterAgent: {
        id: clusterAgent.id,
        firstName: clusterAgent.firstName,
        lastName: clusterAgent.lastName,
        role: clusterAgent.role.name,
        isClusterAgent: clusterAgent.role.name === CLUSTER_AGENT_ROLE,
      },
      assignedAgentIds: assignments.map((a) => a.agentId),
      assignedAgents: assignments.map((a) => ({
        id: a.agent.id,
        firstName: a.agent.firstName,
        lastName: a.agent.lastName,
        email: a.agent.email,
        role: a.agent.role.name,
        assignedAt: a.createdAt,
      })),
      availableAgents: assignableAgents
        .filter((agent) => agent.id !== id)
        .map((agent) => ({
          id: agent.id,
          firstName: agent.firstName,
          lastName: agent.lastName,
          email: agent.email,
          role: agent.role.name,
          assignedToOtherCluster:
            !!agent.agentCluster && agent.agentCluster.clusterAgentId !== id,
          currentClusterAgentName: agent.agentCluster
            ? `${agent.agentCluster.clusterAgent.firstName} ${agent.agentCluster.clusterAgent.lastName}`.trim()
            : null,
        })),
    });
  } catch (error) {
    console.error('getClusterAgents error:', error);
    res.status(500).json({ error: 'Failed to fetch cluster agents' });
  }
}

// PUT /admin-users/:id/cluster-agents
export async function setClusterAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { agentIds } = req.body;
    const admin = req.user as AdminUserPayload;

    if (!Array.isArray(agentIds)) {
      res.status(400).json({ error: 'agentIds must be an array' });
      return;
    }

    const uniqueAgentIds = Array.from(new Set(agentIds.map((value) => String(value))));

    const clusterAgent = await prisma.adminUser.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });

    if (!clusterAgent) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (clusterAgent.role.name !== CLUSTER_AGENT_ROLE) {
      res.status(400).json({ error: 'Only cluster agents can supervise agents' });
      return;
    }

    // Assignments are cleared when a user is deactivated; without this they
    // could be handed straight back to someone who can no longer log in, and
    // their agents would look supervised by nobody.
    if (!clusterAgent.isActive && uniqueAgentIds.length > 0) {
      res.status(400).json({ error: 'This cluster agent is deactivated. Reactivate them before assigning agents.' });
      return;
    }

    if (uniqueAgentIds.includes(id)) {
      res.status(400).json({ error: 'A cluster agent cannot supervise themselves' });
      return;
    }

    if (uniqueAgentIds.length > 0) {
      const agents = await prisma.adminUser.findMany({
        where: { id: { in: uniqueAgentIds }, isActive: true, role: { name: { in: [...CLUSTER_SUPERVISABLE_ROLES] } } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          agentCluster: {
            select: {
              clusterAgentId: true,
              clusterAgent: { select: { firstName: true, lastName: true } },
            },
          },
        },
      });

      if (agents.length !== uniqueAgentIds.length) {
        const found = new Set(agents.map((a) => a.id));
        res.status(400).json({
          error: 'One or more agents are invalid, inactive, or cannot be supervised. Cluster agents supervise agents, not other cluster agents.',
          invalidAgentIds: uniqueAgentIds.filter((agentId) => !found.has(agentId)),
        });
        return;
      }

      // An agent reports to exactly one cluster agent. The unique constraint
      // would catch this, but a named conflict is far more useful than a
      // Prisma constraint error surfacing as a 500.
      const takenElsewhere = agents.filter(
        (agent) => agent.agentCluster && agent.agentCluster.clusterAgentId !== id
      );

      if (takenElsewhere.length > 0) {
        res.status(400).json({
          error: 'Some agents already report to another cluster agent. Remove them there first.',
          conflicts: takenElsewhere.map((agent) => ({
            agentId: agent.id,
            agentName: `${agent.firstName} ${agent.lastName}`.trim(),
            currentClusterAgentName: `${agent.agentCluster!.clusterAgent.firstName} ${agent.agentCluster!.clusterAgent.lastName}`.trim(),
          })),
        });
        return;
      }
    }

    const previous = await prisma.clusterAgentAssignment.findMany({
      where: { clusterAgentId: id },
      select: { agentId: true },
    });
    const previousIds = previous.map((p) => p.agentId);

    await prisma.$transaction(async (tx) => {
      await tx.clusterAgentAssignment.deleteMany({ where: { clusterAgentId: id } });
      if (uniqueAgentIds.length > 0) {
        await tx.clusterAgentAssignment.createMany({
          data: uniqueAgentIds.map((agentId) => ({
            clusterAgentId: id,
            agentId,
            assignedById: admin.id,
          })),
        });
      }
    });

    await createAuditLog({
      userId: admin.id,
      action: 'SET_CLUSTER_ASSIGNMENTS',
      entity: 'AdminUser',
      entityId: id,
      oldValues: { assignedAgentIds: previousIds },
      newValues: { assignedAgentIds: uniqueAgentIds },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    res.json({
      message: 'Cluster agents updated',
      assignedAgentIds: uniqueAgentIds,
      count: uniqueAgentIds.length,
    });
  } catch (error) {
    console.error('setClusterAgents error:', error);
    res.status(500).json({ error: 'Failed to update cluster agents' });
  }
}

// GET /cluster/my-agents — the signed-in cluster agent's own team, with the
// numbers they are held accountable for: follow-up load and portfolio at risk.
export async function getMyClusterAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;

    const assignments = await prisma.clusterAgentAssignment.findMany({
      where: { clusterAgentId: admin.id },
      include: {
        agent: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            isActive: true,
            _count: { select: { customersCreated: true, contractsCreated: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // A cluster agent sells as well as supervises, so their own contracts are
    // part of the portfolio they answer for. Querying only the supervised ids
    // left the dashboard disagreeing with their own contract list, which does
    // include their book (scopeService.getAssignedAgentIds adds self).
    const agentIds = assignments.map((a) => a.agentId);
    const bookIds = [...agentIds, admin.id];

    const [pendingByAgent, self] = await Promise.all([
      prisma.hirePurchaseContract.groupBy({
        by: ['createdById'],
        where: { createdById: { in: bookIds }, status: 'PENDING_APPROVAL' },
        _count: { _all: true },
      }),
      prisma.adminUser.findUnique({
        where: { id: admin.id },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          isActive: true,
          createdAt: true,
          _count: { select: { customersCreated: true, contractsCreated: true } },
        },
      }),
    ]);

    const pendingMap = new Map(pendingByAgent.map((row) => [row.createdById, row._count._all]));

    // PAR from the shared calculation, so a leader sees the same number the
    // contract block judges their agents on. The previous "any overdue
    // installment" figure read roughly three times higher and ranked agents in
    // the wrong order.
    const bookRisk = await getAgentPortfolioRisk(bookIds);
    const riskMap = new Map<string, { overdueContracts: number; atRisk: number; total: number; atRisk1: number; par1: number; par30: number; activeContracts: number }>();
    for (const [id, r] of bookRisk) {
      riskMap.set(id, {
        overdueContracts: r.contractsAtRisk30,
        atRisk: r.atRisk30,
        total: r.outstanding,
        atRisk1: r.atRisk1,
        par1: r.par1,
        par30: r.par30,
        activeContracts: r.activeContracts,
      });
    }

    const agents = assignments.map((a) => {
      const risk = riskMap.get(a.agentId) ?? { overdueContracts: 0, atRisk: 0, total: 0, atRisk1: 0, par1: 0, par30: 0, activeContracts: 0 };
      return {
        id: a.agent.id,
        name: `${a.agent.firstName} ${a.agent.lastName}`.trim(),
        email: a.agent.email,
        phone: a.agent.phone,
        isActive: a.agent.isActive,
        assignedAt: a.createdAt,
        customers: a.agent._count.customersCreated,
        contracts: a.agent._count.contractsCreated,
        pendingVerification: pendingMap.get(a.agentId) ?? 0,
        contractsOverdue: risk.overdueContracts,
        outstanding: Math.round(risk.total * 100) / 100,
        amountAtRisk: Math.round(risk.atRisk * 100) / 100,
        portfolioAtRisk: risk.par30,
        par1: risk.par1,
        activeContracts: risk.activeContracts,
      };
    });

    // Their own row, flagged so the page can label it rather than pass the
    // supervisor off as one of their own agents.
    const selfRisk = riskMap.get(admin.id) ?? { overdueContracts: 0, atRisk: 0, total: 0, atRisk1: 0, par1: 0, par30: 0, activeContracts: 0 };
    const ownBook = self
      ? {
          id: self.id,
          name: `${self.firstName} ${self.lastName}`.trim(),
          email: self.email,
          phone: self.phone,
          isActive: self.isActive,
          assignedAt: self.createdAt,
          customers: self._count.customersCreated,
          contracts: self._count.contractsCreated,
          pendingVerification: pendingMap.get(admin.id) ?? 0,
          contractsOverdue: selfRisk.overdueContracts,
          outstanding: Math.round(selfRisk.total * 100) / 100,
          amountAtRisk: Math.round(selfRisk.atRisk * 100) / 100,
          portfolioAtRisk: selfRisk.par30,
          par1: selfRisk.par1,
          activeContracts: selfRisk.activeContracts,
          isSelf: true,
        }
      : null;

    // Totals cover the whole book the supervisor answers for, their own
    // contracts included — a cluster agent carrying arrears of their own
    // should not see a clean dashboard.
    const portfolio = ownBook ? [...agents, ownBook] : agents;
    const totalOutstanding = portfolio.reduce((sum, a) => sum + a.outstanding, 0);
    const totalAtRisk = portfolio.reduce((sum, a) => sum + a.amountAtRisk, 0);

    res.json({
      count: agents.length,
      summary: {
        // Headcount is the team; every money figure is the whole book.
        agents: agents.length,
        customers: portfolio.reduce((sum, a) => sum + a.customers, 0),
        contractsOverdue: portfolio.reduce((sum, a) => sum + a.contractsOverdue, 0),
        pendingVerification: portfolio.reduce((sum, a) => sum + a.pendingVerification, 0),
        outstanding: Math.round(totalOutstanding * 100) / 100,
        amountAtRisk: Math.round(totalAtRisk * 100) / 100,
        portfolioAtRisk: totalOutstanding > 0 ? Math.round((totalAtRisk / totalOutstanding) * 1000) / 10 : 0,
      },
      agents,
      ownBook,
    });
  } catch (error) {
    console.error('getMyClusterAgents error:', error);
    res.status(500).json({ error: 'Failed to fetch your agents' });
  }
}

// GET /cluster/coverage
// Who supervises whom, and — the point of it — who supervises nobody.
export async function getClusterCoverage(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const [clusterAgents, assignments, allAgents] = await Promise.all([
      prisma.adminUser.findMany({
        where: { isActive: true, role: { name: CLUSTER_AGENT_ROLE } },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.clusterAgentAssignment.findMany({
        include: {
          agent: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, isActive: true } },
        },
      }),
      prisma.adminUser.findMany({
        where: { isActive: true, role: { name: { in: [...CLUSTER_SUPERVISABLE_ROLES] } } },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
    ]);

    const byCluster = new Map<string, typeof assignments>();
    const coveredAgentIds = new Set<string>();
    for (const assignment of assignments) {
      if (!assignment.agent.isActive) continue;
      coveredAgentIds.add(assignment.agentId);
      const list = byCluster.get(assignment.clusterAgentId) ?? [];
      list.push(assignment);
      byCluster.set(assignment.clusterAgentId, list);
    }

    res.json({
      clusterAgents: clusterAgents.map((cluster) => {
        const agents = (byCluster.get(cluster.id) ?? [])
          .map((a) => ({
            id: a.agent.id,
            name: `${a.agent.firstName} ${a.agent.lastName}`.trim(),
            email: a.agent.email,
            phone: a.agent.phone,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          id: cluster.id,
          name: `${cluster.firstName} ${cluster.lastName}`.trim(),
          email: cluster.email,
          phone: cluster.phone,
          agentCount: agents.length,
          agents,
        };
      }),
      // The reason this endpoint exists. Deactivating a supervisor now clears
      // their assignments, so orphans appear on their own and would otherwise
      // have to be hunted by hand — which is exactly how the stale CSO
      // assignments on this database were found.
      unassignedAgents: allAgents
        .filter((agent) => !coveredAgentIds.has(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: `${agent.firstName} ${agent.lastName}`.trim(),
          email: agent.email,
          phone: agent.phone,
        })),
    });
  } catch (error) {
    console.error('getClusterCoverage error:', error);
    res.status(500).json({ error: 'Failed to load cluster coverage' });
  }
}
