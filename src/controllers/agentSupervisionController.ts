import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import {
  ASSIGNABLE_AGENT_ROLES,
  CLUSTER_SUPERVISABLE_ROLES,
  CLUSTER_AGENT_ROLE,
  CUSTOMER_SERVICE_ROLE,
} from '../constants/roles';
import { getSupervisionSettings } from '../services/supervisionService';

const prismaAny = prisma as any;

// GET /admin-users/agent-supervision
//
// Every sellable agent alongside who supervises them, in one place. The
// existing screens either assign one agent at a time from a user's profile or
// show coverage read-only, neither of which is usable for linking ninety-six
// agents.
export async function getAgentSupervision(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const [agents, clusterAgents, csos, settings] = await Promise.all([
      prismaAny.adminUser.findMany({
        where: { isActive: true, role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } } },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          area: true,
          district: true,
          role: { select: { name: true } },
          agentCluster: {
            select: { clusterAgentId: true, clusterAgent: { select: { firstName: true, lastName: true } } },
          },
          agentAssignedCsos: {
            select: { csoId: true, cso: { select: { firstName: true, lastName: true } } },
          },
          _count: { select: { customersCreated: true, contractsCreated: true } },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prismaAny.adminUser.findMany({
        where: { isActive: true, role: { name: CLUSTER_AGENT_ROLE } },
        select: { id: true, firstName: true, lastName: true, email: true, area: true, district: true },
        orderBy: [{ firstName: 'asc' }],
      }),
      prismaAny.adminUser.findMany({
        where: { isActive: true, role: { name: CUSTOMER_SERVICE_ROLE } },
        select: { id: true, firstName: true, lastName: true, email: true },
        orderBy: [{ firstName: 'asc' }],
      }),
      getSupervisionSettings(),
    ]);

    const rows = agents.map((agent: any) => ({
      id: agent.id,
      name: `${agent.firstName} ${agent.lastName}`.trim(),
      email: agent.email,
      phone: agent.phone,
      area: agent.area,
      district: agent.district,
      role: agent.role.name,
      // Cluster agents sell but are not themselves supervised by a cluster
      // agent — the tier is flat. The UI uses this to disable that column.
      canHaveClusterAgent: (CLUSTER_SUPERVISABLE_ROLES as readonly string[]).includes(agent.role.name),
      clusterAgentId: agent.agentCluster?.clusterAgentId ?? null,
      clusterAgentName: agent.agentCluster?.clusterAgent
        ? `${agent.agentCluster.clusterAgent.firstName} ${agent.agentCluster.clusterAgent.lastName}`.trim()
        : null,
      csoIds: agent.agentAssignedCsos.map((row: any) => row.csoId),
      csoNames: agent.agentAssignedCsos.map((row: any) =>
        `${row.cso.firstName} ${row.cso.lastName}`.trim()
      ),
      customers: agent._count.customersCreated,
      contracts: agent._count.contractsCreated,
    }));

    res.json({
      agents: rows,
      clusterAgents: clusterAgents.map((c: any) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim(),
        email: c.email,
        // Shown in the picker so an agent is grouped with a supervisor near
        // them rather than whoever is alphabetically first.
        area: c.area,
        district: c.district,
      })),
      customerServiceOfficers: csos.map((c: any) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim(),
        email: c.email,
      })),
      settings,
      summary: {
        total: rows.length,
        withoutClusterAgent: rows.filter((r: any) => r.canHaveClusterAgent && !r.clusterAgentId).length,
        withoutCso: rows.filter((r: any) => r.csoIds.length === 0).length,
        withoutLocation: rows.filter((r: any) => !r.area && !r.district).length,
      },
    });
  } catch (error) {
    console.error('getAgentSupervision error:', error);
    res.status(500).json({ error: 'Failed to load agent supervision' });
  }
}

// PUT /admin-users/agent-supervision
//
// Sets one agent's cluster agent and/or officer. Kept per-agent rather than a
// bulk submit so a mistake affects one row, and so the response can say what
// actually changed.
export async function setAgentSupervision(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { agentId, clusterAgentId, csoIds, area, district } = req.body ?? {};

    if (!agentId || typeof agentId !== 'string') {
      res.status(400).json({ error: 'An agent must be given' });
      return;
    }

    const agent = await prismaAny.adminUser.findUnique({
      where: { id: agentId },
      include: {
        role: { select: { name: true } },
        agentCluster: { select: { clusterAgentId: true } },
        agentAssignedCsos: { select: { csoId: true } },
      },
    });
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (!(ASSIGNABLE_AGENT_ROLES as readonly string[]).includes(agent.role.name)) {
      res.status(400).json({ error: 'This user is not in a role that can be supervised' });
      return;
    }

    const before = {
      clusterAgentId: agent.agentCluster?.clusterAgentId ?? null,
      csoIds: agent.agentAssignedCsos.map((r: any) => r.csoId),
      area: agent.area,
      district: agent.district,
    };

    // Recorded here because this is the screen where the details agents are
    // submitting get entered, and grouping by area is the reason they were
    // asked for.
    if (area !== undefined || district !== undefined) {
      await prismaAny.adminUser.update({
        where: { id: agentId },
        data: {
          ...(area !== undefined ? { area: area ? String(area).trim() : null } : {}),
          ...(district !== undefined ? { district: district ? String(district).trim() : null } : {}),
        },
      });
    }

    // --- cluster agent ---
    if (clusterAgentId !== undefined) {
      if (!(CLUSTER_SUPERVISABLE_ROLES as readonly string[]).includes(agent.role.name) && clusterAgentId) {
        res.status(400).json({ error: 'Cluster agents are not supervised by other cluster agents' });
        return;
      }
      if (clusterAgentId) {
        const supervisor = await prismaAny.adminUser.findUnique({
          where: { id: clusterAgentId },
          include: { role: { select: { name: true } } },
        });
        if (!supervisor || supervisor.role.name !== CLUSTER_AGENT_ROLE) {
          res.status(400).json({ error: 'The chosen supervisor is not a cluster agent' });
          return;
        }
        if (!supervisor.isActive) {
          res.status(400).json({ error: 'That cluster agent is deactivated' });
          return;
        }
        if (supervisor.id === agentId) {
          res.status(400).json({ error: 'An agent cannot supervise themselves' });
          return;
        }
        await prismaAny.clusterAgentAssignment.upsert({
          where: { agentId },
          update: { clusterAgentId, assignedById: admin.id },
          create: { agentId, clusterAgentId, assignedById: admin.id },
        });
      } else {
        await prismaAny.clusterAgentAssignment.deleteMany({ where: { agentId } });
      }
    }

    // --- customer service officers ---
    if (csoIds !== undefined) {
      if (!Array.isArray(csoIds)) {
        res.status(400).json({ error: 'csoIds must be an array' });
        return;
      }
      const unique = Array.from(new Set(csoIds.map((v: unknown) => String(v)))).filter(Boolean);
      if (unique.length > 0) {
        const officers = await prismaAny.adminUser.findMany({
          where: { id: { in: unique }, isActive: true, role: { name: CUSTOMER_SERVICE_ROLE } },
          select: { id: true },
        });
        if (officers.length !== unique.length) {
          res.status(400).json({ error: 'One or more officers are invalid, inactive, or not customer service' });
          return;
        }
      }
      await prismaAny.csoAgentAssignment.deleteMany({ where: { agentId } });
      if (unique.length > 0) {
        await prismaAny.csoAgentAssignment.createMany({
          data: unique.map((csoId) => ({ agentId, csoId, assignedById: admin.id })),
        });
      }
    }

    const after = await prismaAny.adminUser.findUnique({
      where: { id: agentId },
      select: {
        area: true,
        district: true,
        agentCluster: { select: { clusterAgentId: true } },
        agentAssignedCsos: { select: { csoId: true } },
      },
    });

    await createAuditLog({
      userId: admin.id,
      action: 'SET_AGENT_SUPERVISION',
      entity: 'AdminUser',
      entityId: agentId,
      oldValues: before,
      newValues: {
        clusterAgentId: after?.agentCluster?.clusterAgentId ?? null,
        csoIds: after?.agentAssignedCsos.map((r: any) => r.csoId) ?? [],
        area: after?.area ?? null,
        district: after?.district ?? null,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    res.json({
      message: 'Supervision updated',
      clusterAgentId: after?.agentCluster?.clusterAgentId ?? null,
      csoIds: after?.agentAssignedCsos.map((r: any) => r.csoId) ?? [],
      area: after?.area ?? null,
      district: after?.district ?? null,
    });
  } catch (error) {
    console.error('setAgentSupervision error:', error);
    res.status(500).json({ error: 'Failed to update supervision' });
  }
}

// PUT /admin-users/agent-supervision/settings
export async function updateSupervisionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { requireClusterAgent, requireCso } = req.body ?? {};
    const current = await getSupervisionSettings();

    // Turning the rule on while agents are uncovered stops them selling the
    // moment it saves. Refused with the count rather than discovered by ninety
    // agents at once.
    if (requireClusterAgent === true && !current.requireClusterAgent) {
      const uncovered = await prismaAny.adminUser.count({
        where: {
          isActive: true,
          role: { name: { in: [...CLUSTER_SUPERVISABLE_ROLES] } },
          agentCluster: null,
        },
      });
      if (uncovered > 0) {
        res.status(400).json({
          error: `${uncovered} active agent${uncovered === 1 ? ' is' : 's are'} not assigned to a cluster agent. Assign them first, or they will be blocked from creating contracts the moment this is switched on.`,
          uncovered,
        });
        return;
      }
    }
    if (requireCso === true && !current.requireCso) {
      const uncovered = await prismaAny.adminUser.count({
        where: {
          isActive: true,
          role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } },
          agentAssignedCsos: { none: {} },
        },
      });
      if (uncovered > 0) {
        res.status(400).json({
          error: `${uncovered} active agent${uncovered === 1 ? ' is' : 's are'} not assigned to a customer service officer. Assign them first.`,
          uncovered,
        });
        return;
      }
    }

    const updated = await prismaAny.supervisionSettings.update({
      where: { id: current.id },
      data: {
        ...(requireClusterAgent !== undefined ? { requireClusterAgent: Boolean(requireClusterAgent) } : {}),
        ...(requireCso !== undefined ? { requireCso: Boolean(requireCso) } : {}),
        updatedById: admin.id,
      },
    });

    await createAuditLog({
      userId: admin.id,
      action: 'UPDATE_SUPERVISION_SETTINGS',
      entity: 'SupervisionSettings',
      entityId: updated.id,
      oldValues: { requireClusterAgent: current.requireClusterAgent, requireCso: current.requireCso },
      newValues: { requireClusterAgent: updated.requireClusterAgent, requireCso: updated.requireCso },
    });

    res.json({ settings: updated });
  } catch (error) {
    console.error('updateSupervisionSettings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
}

// PUT /admin-users/agent-supervision/bulk
//
// Assigns many agents at once.
//
// There are three officers and ninety-odd agents, so doing this one row at a
// time is ninety saves for what is really one decision — "these people are
// LOVINA's". Per-agent saves stay for corrections; this is for the initial
// distribution.
export async function bulkSetAgentSupervision(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { agentIds, clusterAgentId, csoId } = req.body ?? {};

    if (!Array.isArray(agentIds) || agentIds.length === 0) {
      res.status(400).json({ error: 'Select at least one agent' });
      return;
    }
    if (clusterAgentId === undefined && csoId === undefined) {
      res.status(400).json({ error: 'Choose a cluster agent or an officer to assign' });
      return;
    }

    const ids = Array.from(new Set(agentIds.map((v: unknown) => String(v))));
    const agents = await prismaAny.adminUser.findMany({
      where: { id: { in: ids } },
      include: { role: { select: { name: true } } },
    });
    if (agents.length !== ids.length) {
      res.status(400).json({ error: 'One or more agents were not found' });
      return;
    }

    const notAssignable = agents.filter(
      (a: any) => !(ASSIGNABLE_AGENT_ROLES as readonly string[]).includes(a.role.name)
    );
    if (notAssignable.length > 0) {
      res.status(400).json({
        error: 'Some of those users are not in a role that can be supervised',
        names: notAssignable.map((a: any) => `${a.firstName} ${a.lastName}`.trim()),
      });
      return;
    }

    // --- cluster agent ---
    let clusterApplied = 0;
    let clusterSkipped: string[] = [];
    if (clusterAgentId !== undefined) {
      if (clusterAgentId) {
        const supervisor = await prismaAny.adminUser.findUnique({
          where: { id: clusterAgentId },
          include: { role: { select: { name: true } } },
        });
        if (!supervisor || supervisor.role.name !== CLUSTER_AGENT_ROLE) {
          res.status(400).json({ error: 'The chosen supervisor is not a cluster agent' });
          return;
        }
        if (!supervisor.isActive) {
          res.status(400).json({ error: 'That cluster agent is deactivated' });
          return;
        }

        // A cluster agent is not supervised by another, and nobody supervises
        // themselves. Skipped rather than refusing the whole batch, so one bad
        // pick does not discard fifty good ones.
        for (const agent of agents) {
          const eligible =
            (CLUSTER_SUPERVISABLE_ROLES as readonly string[]).includes(agent.role.name) &&
            agent.id !== clusterAgentId;
          if (!eligible) {
            clusterSkipped.push(`${agent.firstName} ${agent.lastName}`.trim());
            continue;
          }
          await prismaAny.clusterAgentAssignment.upsert({
            where: { agentId: agent.id },
            update: { clusterAgentId, assignedById: admin.id },
            create: { agentId: agent.id, clusterAgentId, assignedById: admin.id },
          });
          clusterApplied++;
        }
      } else {
        const cleared = await prismaAny.clusterAgentAssignment.deleteMany({
          where: { agentId: { in: ids } },
        });
        clusterApplied = cleared.count;
      }
    }

    // --- customer service officer ---
    let csoApplied = 0;
    if (csoId !== undefined) {
      if (csoId) {
        const officer = await prismaAny.adminUser.findUnique({
          where: { id: csoId },
          include: { role: { select: { name: true } } },
        });
        if (!officer || officer.role.name !== CUSTOMER_SERVICE_ROLE || !officer.isActive) {
          res.status(400).json({ error: 'The chosen officer is not an active customer service user' });
          return;
        }
        await prismaAny.csoAgentAssignment.deleteMany({ where: { agentId: { in: ids } } });
        await prismaAny.csoAgentAssignment.createMany({
          data: ids.map((agentId) => ({ agentId, csoId, assignedById: admin.id })),
        });
        csoApplied = ids.length;
      } else {
        const cleared = await prismaAny.csoAgentAssignment.deleteMany({ where: { agentId: { in: ids } } });
        csoApplied = cleared.count;
      }
    }

    await createAuditLog({
      userId: admin.id,
      action: 'BULK_SET_AGENT_SUPERVISION',
      entity: 'AdminUser',
      newValues: {
        agentCount: ids.length,
        clusterAgentId: clusterAgentId ?? null,
        csoId: csoId ?? null,
        clusterApplied,
        csoApplied,
        skipped: clusterSkipped,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    res.json({
      message: `${ids.length} agent${ids.length === 1 ? '' : 's'} updated`,
      clusterApplied,
      csoApplied,
      skipped: clusterSkipped,
    });
  } catch (error) {
    console.error('bulkSetAgentSupervision error:', error);
    res.status(500).json({ error: 'Failed to update supervision' });
  }
}
