import prisma from '../config/database';
import { PERMISSIONS, PermissionName, toPermissionNames } from '../constants/permissions';

/**
 * Permissions given to one user on top of their role's.
 *
 * Kept to a short list on purpose: a role is still where most access comes
 * from, and a grant is for one capability that does not follow job titles —
 * welcome (activation) calls, which any member of staff may be asked to make.
 */
export const GRANTABLE_PERMISSIONS: readonly PermissionName[] = [PERMISSIONS.VERIFY_CUSTOMER];

export const GRANTABLE_LABELS: Record<string, string> = {
  [PERMISSIONS.VERIFY_CUSTOMER]: 'Welcome / activation calls',
};

/** The user's individual grants. Empty on any error, so a login never fails over them. */
export async function grantedPermissions(adminUserId: string): Promise<PermissionName[]> {
  try {
    const rows = await prisma.adminUserPermission.findMany({ where: { adminUserId }, select: { permission: true } });
    return rows.map((r) => r.permission).filter((p): p is PermissionName => (GRANTABLE_PERMISSIONS as readonly string[]).includes(p));
  } catch {
    return [];
  }
}

/** Role permissions plus the user's own grants — what every check sees. */
export async function effectivePermissions(admin: { id: string; role: { permissions: Array<{ name: string }> } }): Promise<PermissionName[]> {
  const fromRole = toPermissionNames(admin.role.permissions.map((p) => p.name));
  const granted = await grantedPermissions(admin.id);
  return Array.from(new Set([...fromRole, ...granted]));
}

/** Replace a user's grants with `permissions` (only grantable ones are accepted). */
export async function setGrantedPermissions(adminUserId: string, permissions: string[], actorId: string): Promise<PermissionName[]> {
  const unknown = permissions.filter((p) => !(GRANTABLE_PERMISSIONS as readonly string[]).includes(p));
  if (unknown.length) throw new Error(`These cannot be given to a single user: ${unknown.join(', ')}`);
  const wanted = Array.from(new Set(permissions));
  await prisma.$transaction([
    prisma.adminUserPermission.deleteMany({ where: { adminUserId, permission: { notIn: wanted } } }),
    ...wanted.map((permission) =>
      prisma.adminUserPermission.upsert({
        where: { adminUserId_permission: { adminUserId, permission } },
        create: { adminUserId, permission, grantedById: actorId },
        update: {},
      }),
    ),
  ]);
  return grantedPermissions(adminUserId);
}
