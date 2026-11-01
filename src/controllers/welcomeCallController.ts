import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import { ASSIGNABLE_AGENT_ROLES } from '../constants/roles';
import { assignWelcomeCalls, eligibleOfficers, holdsWelcomeCalls } from '../services/welcomeCallService';

/**
 * Welcome-call assignments, mounted at /api/welcome-calls (MANAGE_CSO_ASSIGNMENTS).
 *
 * Moves some or all of one person's agents to another person who has the
 * welcome / activation calls permission — chosen, never random — and keeps a
 * history of every move.
 */

const user = (req: AuthenticatedRequest) => req.user as AdminUserPayload;
const name = (u: { firstName: string; lastName: string } | null | undefined) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

/** GET /officers — everyone who can be given agents, with how many they have, plus agents with nobody. */
export async function getOfficers(_req: AuthenticatedRequest, res: Response) {
  try {
    const [officers, counts, agents] = await Promise.all([
      eligibleOfficers(),
      prisma.csoAgentAssignment.groupBy({ by: ['csoId'], _count: { _all: true } }),
      prisma.adminUser.findMany({
        where: { isActive: true, role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } } },
        select: { id: true, agentAssignedCsos: { select: { csoId: true }, take: 1 } },
      }),
    ]);
    const countBy = new Map(counts.map((c) => [c.csoId, c._count._all]));
    // People who still hold agents but have lost the permission or been deactivated.
    const eligibleIds = new Set(officers.map((o) => o.id));
    const strandedIds = counts.map((c) => c.csoId).filter((id) => !eligibleIds.has(id));
    const stranded = strandedIds.length
      ? await prisma.adminUser.findMany({ where: { id: { in: strandedIds } }, select: { id: true, firstName: true, lastName: true, phone: true, isActive: true, role: { select: { name: true } } } })
      : [];
    res.json({
      officers: [
        ...officers.map((o) => ({ id: o.id, name: name(o), phone: o.phone, role: o.role.name, agentCount: countBy.get(o.id) ?? 0, eligible: true })),
        ...stranded.map((o) => ({ id: o.id, name: name(o), phone: o.phone, role: o.role.name, agentCount: countBy.get(o.id) ?? 0, eligible: false, isActive: o.isActive })),
      ].sort((a, b) => b.agentCount - a.agentCount || String(a.name).localeCompare(String(b.name))),
      unassignedCount: agents.filter((a) => a.agentAssignedCsos.length === 0).length,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to load welcome-call officers' });
  }
}

/** GET /officers/:id/agents — that person's agents ("none" for agents nobody has). */
export async function getOfficerAgents(req: AuthenticatedRequest, res: Response) {
  try {
    const id = String(req.params.id);
    const where =
      id === 'none'
        ? { isActive: true, role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } }, agentAssignedCsos: { none: {} } }
        : { agentAssignedCsos: { some: { csoId: id } } };
    const agents = await prisma.adminUser.findMany({
      where,
      select: {
        id: true, firstName: true, lastName: true, phone: true, area: true, district: true, isActive: true,
        role: { select: { name: true } },
        _count: { select: { contractsCreated: { where: { status: 'PENDING_APPROVAL' } } } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    res.json({
      agents: agents.map((a) => ({
        id: a.id,
        name: name(a),
        phone: a.phone,
        area: a.area,
        district: a.district,
        role: a.role.name,
        isActive: a.isActive,
        pendingContracts: a._count.contractsCreated,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to load agents' });
  }
}

/** POST /transfer { fromOfficerId, agentIds | all: true, toOfficerId, reason } */
export async function transferWelcomeCalls(req: AuthenticatedRequest, res: Response) {
  try {
    const actor = user(req);
    const { fromOfficerId, agentIds, all, toOfficerId, reason } = req.body ?? {};
    if (!toOfficerId || typeof toOfficerId !== 'string') return res.status(400).json({ error: 'Choose who will take these agents' });
    if (fromOfficerId && fromOfficerId === toOfficerId) return res.status(400).json({ error: 'Choose a different person to move these agents to' });
    if (!(await holdsWelcomeCalls(toOfficerId))) {
      return res.status(400).json({ error: 'That person is inactive or does not have the welcome / activation calls permission' });
    }

    // Which agents: all of the source's, or the ones picked (which must be the source's).
    let ids: string[];
    if (all === true) {
      if (fromOfficerId) {
        ids = (await prisma.csoAgentAssignment.findMany({ where: { csoId: fromOfficerId }, select: { agentId: true } })).map((r) => r.agentId);
      } else {
        ids = (
          await prisma.adminUser.findMany({
            where: { isActive: true, role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } }, agentAssignedCsos: { none: {} } },
            select: { id: true },
          })
        ).map((a) => a.id);
      }
    } else {
      if (!Array.isArray(agentIds) || agentIds.length === 0) return res.status(400).json({ error: 'Select at least one agent' });
      ids = Array.from(new Set(agentIds.map((v: unknown) => String(v))));
      const rows = await prisma.csoAgentAssignment.findMany({ where: { agentId: { in: ids } }, select: { agentId: true, csoId: true } });
      const holder = new Map(rows.map((r) => [r.agentId, r.csoId]));
      const wrong = ids.filter((id) => (fromOfficerId ? holder.get(id) !== fromOfficerId : holder.has(id)));
      if (wrong.length) return res.status(400).json({ error: 'Some of those agents are no longer with that person. Reload and try again.' });
    }
    if (!ids.length) return res.status(400).json({ error: 'There are no agents to move' });
    if (ids.includes(toOfficerId)) return res.status(400).json({ error: 'Nobody can be given their own welcome calls' });

    const moves = await assignWelcomeCalls(ids, toOfficerId, actor.id);
    const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null;
    if (moves.length) {
      await prisma.welcomeCallTransfer.createMany({
        data: moves.map((m) => ({ agentId: m.agentId, fromOfficerId: m.fromOfficerId, toOfficerId, transferredById: actor.id, reason: note })),
      });
    }
    const [from, to] = await Promise.all([
      fromOfficerId ? prisma.adminUser.findUnique({ where: { id: fromOfficerId }, select: { firstName: true, lastName: true } }) : null,
      prisma.adminUser.findUnique({ where: { id: toOfficerId }, select: { firstName: true, lastName: true } }),
    ]);
    await createAuditLog({
      userId: actor.id,
      action: 'TRANSFER_WELCOME_CALLS',
      entity: 'AdminUser',
      entityId: toOfficerId,
      newValues: { from: name(from) ?? 'Not assigned', fromOfficerId: fromOfficerId ?? null, to: name(to), toOfficerId, agentIds: moves.map((m) => m.agentId), count: moves.length, reason: note },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
    res.json({ moved: moves.length, message: `${moves.length} agent${moves.length === 1 ? '' : 's'} moved to ${name(to)}` });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to move agents' });
  }
}

/** GET /history — the latest moves. */
export async function getTransferHistory(_req: AuthenticatedRequest, res: Response) {
  try {
    const rows = await prisma.welcomeCallTransfer.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    const ids = [...new Set(rows.flatMap((r) => [r.agentId, r.fromOfficerId, r.toOfficerId, r.transferredById].filter(Boolean) as string[]))];
    const people = new Map(
      (await prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } })).map((p) => [p.id, name(p)]),
    );
    res.json({
      transfers: rows.map((r) => ({
        id: r.id,
        agent: people.get(r.agentId) ?? '—',
        from: r.fromOfficerId ? people.get(r.fromOfficerId) ?? '—' : 'Not assigned',
        to: people.get(r.toOfficerId) ?? '—',
        by: people.get(r.transferredById) ?? '—',
        reason: r.reason,
        at: r.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to load history' });
  }
}
