import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { ASSIGNABLE_AGENT_ROLES, CLUSTER_AGENT_ROLE } from '../constants/roles';

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
        where: { isActive: true, role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } } },
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

    if (uniqueAgentIds.includes(id)) {
      res.status(400).json({ error: 'A cluster agent cannot supervise themselves' });
      return;
    }

    if (uniqueAgentIds.length > 0) {
      const agents = await prisma.adminUser.findMany({
        where: { id: { in: uniqueAgentIds }, isActive: true, role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } } },
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
          error: 'One or more agents are invalid, inactive, or not an agent role',
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

    const agentIds = assignments.map((a) => a.agentId);

    const [pendingByAgent, activeContracts] = await Promise.all([
      agentIds.length
        ? prisma.hirePurchaseContract.groupBy({
            by: ['createdById'],
            where: { createdById: { in: agentIds }, status: 'PENDING_APPROVAL' },
            _count: { _all: true },
          })
        : Promise.resolve([] as { createdById: string; _count: { _all: number } }[]),
      agentIds.length
        ? prisma.hirePurchaseContract.findMany({
            where: { createdById: { in: agentIds }, status: 'ACTIVE' },
            select: {
              createdById: true,
              outstandingBalance: true,
              installments: { where: { status: 'OVERDUE' }, select: { id: true }, take: 1 },
            },
          })
        : Promise.resolve([] as { createdById: string; outstandingBalance: number; installments: { id: string }[] }[]),
    ]);

    const pendingMap = new Map(pendingByAgent.map((row) => [row.createdById, row._count._all]));

    // Portfolio at risk: the share of an agent's live book sitting on contracts
    // that already have an overdue installment.
    const riskMap = new Map<string, { overdueContracts: number; atRisk: number; total: number }>();
    for (const contract of activeContracts) {
      const entry = riskMap.get(contract.createdById) ?? { overdueContracts: 0, atRisk: 0, total: 0 };
      entry.total += contract.outstandingBalance;
      if (contract.installments.length > 0) {
        entry.overdueContracts += 1;
        entry.atRisk += contract.outstandingBalance;
      }
      riskMap.set(contract.createdById, entry);
    }

    const agents = assignments.map((a) => {
      const risk = riskMap.get(a.agentId) ?? { overdueContracts: 0, atRisk: 0, total: 0 };
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
        portfolioAtRisk: risk.total > 0 ? Math.round((risk.atRisk / risk.total) * 1000) / 10 : 0,
      };
    });

    const totalOutstanding = agents.reduce((sum, a) => sum + a.outstanding, 0);
    const totalAtRisk = agents.reduce((sum, a) => sum + a.amountAtRisk, 0);

    res.json({
      count: agents.length,
      summary: {
        agents: agents.length,
        customers: agents.reduce((sum, a) => sum + a.customers, 0),
        contractsOverdue: agents.reduce((sum, a) => sum + a.contractsOverdue, 0),
        pendingVerification: agents.reduce((sum, a) => sum + a.pendingVerification, 0),
        outstanding: Math.round(totalOutstanding * 100) / 100,
        amountAtRisk: Math.round(totalAtRisk * 100) / 100,
        portfolioAtRisk: totalOutstanding > 0 ? Math.round((totalAtRisk / totalOutstanding) * 1000) / 10 : 0,
      },
      agents,
    });
  } catch (error) {
    console.error('getMyClusterAgents error:', error);
    res.status(500).json({ error: 'Failed to fetch your agents' });
  }
}
