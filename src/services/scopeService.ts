import prisma from '../config/database';
import { AdminUserPayload } from '../types';
import { hasPermission, PERMISSIONS, PermissionName } from '../constants/permissions';

/**
 * Who a staff user is allowed to see records for, expressed as a filter on the
 * record's `createdById`.
 *
 * `assigned` is the customer-service case: an officer sees the records created
 * by the agents assigned to them. Its `agentIds` is guaranteed non-empty —
 * an officer with no assignments resolves to `none`, never to `all`.
 *
 * `none` means "match nothing". It is the only fallthrough, so an unrecognised
 * permission combination fails closed rather than leaking the whole table.
 */
export type CreatorScope =
  | { mode: 'all' }
  | { mode: 'own'; userId: string }
  | { mode: 'assigned'; agentIds: string[] }
  | { mode: 'none' };

/** Agent ids assigned to a customer service officer. Empty when none are assigned. */
export async function getAssignedAgentIds(csoId: string): Promise<string[]> {
  const rows = await prisma.csoAgentAssignment.findMany({
    where: { csoId },
    select: { agentId: true },
  });
  return rows.map((row) => row.agentId);
}

async function resolveScope(
  admin: AdminUserPayload | undefined,
  viewAll: PermissionName,
  viewAssigned: PermissionName,
  viewOwn: PermissionName
): Promise<CreatorScope> {
  if (!admin) {
    return { mode: 'none' };
  }

  // Mirrors the bypass in requireAnyPermission. Super admins hold every
  // permission by seeding, but relying on that would silently reduce them to
  // seeing nothing if the role were ever edited.
  if (admin.role === 'SUPER_ADMIN') {
    return { mode: 'all' };
  }

  const permissions = admin.permissions ?? [];

  if (hasPermission(permissions, viewAll)) {
    return { mode: 'all' };
  }

  if (hasPermission(permissions, viewAssigned)) {
    const agentIds = await getAssignedAgentIds(admin.id);
    // An officer with no assigned agents must see nothing, not everything.
    return agentIds.length > 0 ? { mode: 'assigned', agentIds } : { mode: 'none' };
  }

  if (hasPermission(permissions, viewOwn)) {
    return { mode: 'own', userId: admin.id };
  }

  return { mode: 'none' };
}

export function resolveCustomerScope(admin: AdminUserPayload | undefined): Promise<CreatorScope> {
  return resolveScope(
    admin,
    PERMISSIONS.VIEW_CUSTOMERS,
    PERMISSIONS.VIEW_ASSIGNED_CUSTOMERS,
    PERMISSIONS.VIEW_OWN_CUSTOMERS
  );
}

export function resolveContractScope(admin: AdminUserPayload | undefined): Promise<CreatorScope> {
  return resolveScope(
    admin,
    PERMISSIONS.VIEW_CONTRACTS,
    PERMISSIONS.VIEW_ASSIGNED_CONTRACTS,
    PERMISSIONS.VIEW_OWN_CONTRACTS
  );
}

/**
 * Narrow a Prisma `where` object in place.
 *
 * `field` is the path to the creator column — pass a nested object instead when
 * the filter lives under a relation (see getAllPendingInstallments).
 *
 * For `none` this writes an impossible predicate rather than leaving `where`
 * untouched; a no-op there would silently widen the query to everything.
 */
export function applyCreatorScope(
  where: Record<string, unknown>,
  scope: CreatorScope,
  field = 'createdById'
): void {
  switch (scope.mode) {
    case 'all':
      return;
    case 'own':
      where[field] = scope.userId;
      return;
    case 'assigned':
      where[field] = { in: scope.agentIds };
      return;
    case 'none':
      where[field] = { in: [] };
      return;
  }
}

/** Single-record guard: may this scope see a record created by `createdById`? */
export function scopeAllows(scope: CreatorScope, createdById: string | null | undefined): boolean {
  switch (scope.mode) {
    case 'all':
      return true;
    case 'own':
      return createdById === scope.userId;
    case 'assigned':
      return !!createdById && scope.agentIds.includes(createdById);
    case 'none':
      return false;
  }
}
