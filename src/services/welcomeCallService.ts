import prisma from '../config/database';
import { PERMISSIONS } from '../constants/permissions';
import { AdminUserPayload } from '../types';

/**
 * Welcome (activation) calls.
 *
 * Whoever holds VERIFY_CUSTOMER — through their role or as a permission given
 * to them alone — can be assigned agents. They call each new customer of those
 * agents, verify them and approve the contract. CsoAgentAssignment is the
 * assignment (it already held one customer service officer per agent when
 * this was introduced, so they simply carried on); an agent has at most one
 * welcome-call person.
 *
 * Collections no longer follow this assignment: recovery and reminder calls
 * are shared out among customer service each morning (callAllocationService).
 */

const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);

export function isAdminRole(role: string | undefined | null): boolean {
  return !!role && ADMIN_ROLES.has(role);
}

/** Active users who may be given agents for welcome calls. */
export async function eligibleOfficers() {
  const [byRole, granted] = await Promise.all([
    prisma.adminUser.findMany({
      where: { isActive: true, role: { permissions: { some: { name: PERMISSIONS.VERIFY_CUSTOMER } } } },
      select: { id: true },
    }),
    prisma.adminUserPermission
      .findMany({ where: { permission: PERMISSIONS.VERIFY_CUSTOMER }, select: { adminUserId: true } })
      .catch(() => [] as Array<{ adminUserId: string }>),
  ]);
  const ids = new Set([...byRole.map((u) => u.id), ...granted.map((g) => g.adminUserId)]);
  return prisma.adminUser.findMany({
    where: { id: { in: [...ids] }, isActive: true },
    select: { id: true, firstName: true, lastName: true, phone: true, role: { select: { name: true } } },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
}

export async function holdsWelcomeCalls(userId: string): Promise<boolean> {
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { isActive: true, role: { select: { permissions: { where: { name: PERMISSIONS.VERIFY_CUSTOMER }, select: { name: true } } } } },
  });
  if (!user?.isActive) return false;
  if (user.role.permissions.length > 0) return true;
  const grant = await prisma.adminUserPermission
    .findUnique({ where: { adminUserId_permission: { adminUserId: userId, permission: PERMISSIONS.VERIFY_CUSTOMER } } })
    .catch(() => null);
  return !!grant;
}

/** The agents this person makes welcome calls for. */
export async function welcomeCallAgentIds(officerId: string): Promise<string[]> {
  const rows = await prisma.csoAgentAssignment.findMany({ where: { csoId: officerId }, select: { agentId: true } });
  return rows.map((r) => r.agentId);
}

/** Who makes this agent's welcome calls, or null. */
export async function welcomeCallOfficerFor(agentId: string): Promise<string | null> {
  const row = await prisma.csoAgentAssignment.findFirst({ where: { agentId }, orderBy: { createdAt: 'desc' }, select: { csoId: true } });
  return row?.csoId ?? null;
}

/**
 * May this user review (verify, approve, send back, edit, cancel) a pending
 * contract sold by this agent? Administrators may review any; anyone else
 * only the contracts of agents assigned to them for welcome calls.
 */
export async function canReviewContract(user: AdminUserPayload, agentId: string): Promise<boolean> {
  if (isAdminRole(user.role)) return true;
  return (await welcomeCallOfficerFor(agentId)) === user.id;
}

/**
 * The `createdById` filter for pending contracts a user reviews: everything
 * for administrators, their welcome-call agents for anyone else (an empty
 * list matches nothing).
 */
export async function reviewFilter(user: AdminUserPayload): Promise<{ createdById?: { in: string[] } }> {
  if (isAdminRole(user.role)) return {};
  return { createdById: { in: await welcomeCallAgentIds(user.id) } };
}

/**
 * Give these agents to one person for welcome calls, taking them from whoever
 * had them. Returns the moves made, for the caller to record.
 */
export async function assignWelcomeCalls(agentIds: string[], toOfficerId: string, actorId: string) {
  const current = await prisma.csoAgentAssignment.findMany({ where: { agentId: { in: agentIds } }, select: { agentId: true, csoId: true } });
  const fromByAgent = new Map<string, string | null>(agentIds.map((id) => [id, null]));
  for (const row of current) fromByAgent.set(row.agentId, row.csoId);
  const moves = agentIds.filter((id) => fromByAgent.get(id) !== toOfficerId).map((agentId) => ({ agentId, fromOfficerId: fromByAgent.get(agentId) ?? null }));
  if (!moves.length) return moves;
  await prisma.$transaction([
    prisma.csoAgentAssignment.deleteMany({ where: { agentId: { in: moves.map((m) => m.agentId) } } }),
    prisma.csoAgentAssignment.createMany({ data: moves.map((m) => ({ agentId: m.agentId, csoId: toOfficerId, assignedById: actorId })) }),
  ]);
  return moves;
}
