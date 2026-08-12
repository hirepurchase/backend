import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';

/** Roles whose created records a customer service officer can be assigned to. */
const ASSIGNABLE_AGENT_ROLES = ['AGENT', 'SALES_AGENT'];
const CSO_ROLE = 'CUSTOMER_SERVICE';

// GET /admin-users/:id/assigned-agents
export async function getAssignedAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const officer = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
    });

    if (!officer) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const [assignments, available] = await Promise.all([
      prisma.csoAgentAssignment.findMany({
        where: { csoId: id },
        include: {
          agent: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              isActive: true,
              role: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.adminUser.findMany({
        where: { isActive: true, role: { name: { in: ASSIGNABLE_AGENT_ROLES } } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          role: { select: { name: true } },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
    ]);

    res.json({
      officer: {
        id: officer.id,
        firstName: officer.firstName,
        lastName: officer.lastName,
        role: officer.role.name,
        isCustomerService: officer.role.name === CSO_ROLE,
      },
      assignedAgentIds: assignments.map((a) => a.agentId),
      assignedAgents: assignments.map((a) => ({
        id: a.agent.id,
        firstName: a.agent.firstName,
        lastName: a.agent.lastName,
        email: a.agent.email,
        role: a.agent.role.name,
        isActive: a.agent.isActive,
        assignedAt: a.createdAt,
      })),
      availableAgents: available.map((a) => ({
        id: a.id,
        firstName: a.firstName,
        lastName: a.lastName,
        email: a.email,
        role: a.role.name,
      })),
    });
  } catch (error) {
    console.error('getAssignedAgents error:', error);
    res.status(500).json({ error: 'Failed to fetch assigned agents' });
  }
}

// PUT /admin-users/:id/assigned-agents — replaces the whole set
export async function setAssignedAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { agentIds } = req.body;
    const admin = req.user as AdminUserPayload;

    if (!Array.isArray(agentIds)) {
      res.status(400).json({ error: 'agentIds must be an array' });
      return;
    }

    const uniqueAgentIds = Array.from(new Set(agentIds.map((value) => String(value))));

    const officer = await prisma.adminUser.findUnique({
      where: { id },
      include: { role: { select: { name: true } } },
    });

    if (!officer) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (officer.role.name !== CSO_ROLE) {
      res.status(400).json({ error: 'Only customer service officers can be assigned agents' });
      return;
    }

    if (uniqueAgentIds.includes(id)) {
      res.status(400).json({ error: 'An officer cannot be assigned to themselves' });
      return;
    }

    // Every id must resolve to an active agent, or the officer would silently
    // end up with a narrower portfolio than whoever set it intended.
    if (uniqueAgentIds.length > 0) {
      const agents = await prisma.adminUser.findMany({
        where: { id: { in: uniqueAgentIds }, isActive: true, role: { name: { in: ASSIGNABLE_AGENT_ROLES } } },
        select: { id: true },
      });

      if (agents.length !== uniqueAgentIds.length) {
        const found = new Set(agents.map((a) => a.id));
        res.status(400).json({
          error: 'One or more agents are invalid, inactive, or not an agent role',
          invalidAgentIds: uniqueAgentIds.filter((agentId) => !found.has(agentId)),
        });
        return;
      }
    }

    const previous = await prisma.csoAgentAssignment.findMany({
      where: { csoId: id },
      select: { agentId: true },
    });
    const previousIds = previous.map((p) => p.agentId);

    await prisma.$transaction(async (tx) => {
      await tx.csoAgentAssignment.deleteMany({ where: { csoId: id } });
      if (uniqueAgentIds.length > 0) {
        await tx.csoAgentAssignment.createMany({
          data: uniqueAgentIds.map((agentId) => ({
            csoId: id,
            agentId,
            assignedById: admin.id,
          })),
        });
      }
    });

    await createAuditLog({
      userId: admin.id,
      action: 'SET_CSO_ASSIGNMENTS',
      entity: 'AdminUser',
      entityId: id,
      oldValues: { assignedAgentIds: previousIds },
      newValues: { assignedAgentIds: uniqueAgentIds },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    res.json({
      message: 'Assigned agents updated',
      assignedAgentIds: uniqueAgentIds,
      count: uniqueAgentIds.length,
    });
  } catch (error) {
    console.error('setAssignedAgents error:', error);
    res.status(500).json({ error: 'Failed to update assigned agents' });
  }
}

// GET /customer-service/my-agents — the signed-in officer's own portfolio,
// with each agent's current workload so the officer can see where the
// verification and collection pressure sits.
export async function getMyAssignedAgents(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;

    const assignments = await prisma.csoAgentAssignment.findMany({
      where: { csoId: admin.id },
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

    const [pendingByAgent, overdueContracts] = await Promise.all([
      agentIds.length
        ? prisma.hirePurchaseContract.groupBy({
            by: ['createdById'],
            where: { createdById: { in: agentIds }, status: 'PENDING_APPROVAL' },
            _count: { _all: true },
          })
        : Promise.resolve([] as { createdById: string; _count: { _all: number } }[]),
      agentIds.length
        ? prisma.hirePurchaseContract.findMany({
            where: {
              createdById: { in: agentIds },
              status: 'ACTIVE',
              installments: { some: { status: 'OVERDUE' } },
            },
            select: { createdById: true },
          })
        : Promise.resolve([] as { createdById: string }[]),
    ]);

    const pendingMap = new Map(pendingByAgent.map((row) => [row.createdById, row._count._all]));
    const overdueMap = new Map<string, number>();
    for (const row of overdueContracts) {
      overdueMap.set(row.createdById, (overdueMap.get(row.createdById) ?? 0) + 1);
    }

    res.json({
      count: assignments.length,
      agents: assignments.map((a) => ({
        id: a.agent.id,
        name: `${a.agent.firstName} ${a.agent.lastName}`.trim(),
        email: a.agent.email,
        phone: a.agent.phone,
        isActive: a.agent.isActive,
        assignedAt: a.createdAt,
        customers: a.agent._count.customersCreated,
        contracts: a.agent._count.contractsCreated,
        pendingVerification: pendingMap.get(a.agentId) ?? 0,
        contractsOverdue: overdueMap.get(a.agentId) ?? 0,
      })),
    });
  } catch (error) {
    console.error('getMyAssignedAgents error:', error);
    res.status(500).json({ error: 'Failed to fetch assigned agents' });
  }
}

// GET /admin-users/customer-service-chart — every officer with the agents they
// cover, plus any agents nobody covers yet. Readable by all staff: it is a
// directory of who to contact, containing no customer data.
export async function getCustomerServiceChart(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const [officers, assignments, allAgents] = await Promise.all([
      prisma.adminUser.findMany({
        where: { isActive: true, role: { name: CSO_ROLE } },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.csoAgentAssignment.findMany({
        include: {
          agent: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true, isActive: true },
          },
        },
      }),
      prisma.adminUser.findMany({
        where: { isActive: true, role: { name: { in: ASSIGNABLE_AGENT_ROLES } } },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
    ]);

    const byOfficer = new Map<string, typeof assignments>();
    const coveredAgentIds = new Set<string>();
    for (const assignment of assignments) {
      if (!assignment.agent.isActive) continue;
      coveredAgentIds.add(assignment.agentId);
      const list = byOfficer.get(assignment.csoId) ?? [];
      list.push(assignment);
      byOfficer.set(assignment.csoId, list);
    }

    res.json({
      officers: officers.map((officer) => {
        const agents = (byOfficer.get(officer.id) ?? [])
          .map((a) => ({
            id: a.agent.id,
            name: `${a.agent.firstName} ${a.agent.lastName}`.trim(),
            email: a.agent.email,
            phone: a.agent.phone,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        return {
          id: officer.id,
          name: `${officer.firstName} ${officer.lastName}`.trim(),
          email: officer.email,
          phone: officer.phone,
          agentCount: agents.length,
          agents,
        };
      }),
      // Surfaced deliberately: an uncovered agent's contracts sit in a
      // verification queue no officer can see.
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
    console.error('getCustomerServiceChart error:', error);
    res.status(500).json({ error: 'Failed to fetch customer service chart' });
  }
}

// GET /admin-users/me/customer-service — the officers responsible for the
// signed-in agent. Any authenticated staff member may call this; it only ever
// returns their own supervisors.
export async function getMyCustomerServiceOfficers(
  req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;

    const assignments = await prisma.csoAgentAssignment.findMany({
      where: { agentId: admin.id },
      include: {
        cso: {
          select: { id: true, firstName: true, lastName: true, email: true, phone: true, isActive: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({
      count: assignments.length,
      officers: assignments
        .filter((a) => a.cso.isActive)
        .map((a) => ({
          id: a.cso.id,
          name: `${a.cso.firstName} ${a.cso.lastName}`.trim(),
          email: a.cso.email,
          phone: a.cso.phone,
          assignedAt: a.createdAt,
        })),
    });
  } catch (error) {
    console.error('getMyCustomerServiceOfficers error:', error);
    res.status(500).json({ error: 'Failed to fetch customer service contact' });
  }
}
