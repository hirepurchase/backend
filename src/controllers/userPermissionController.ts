import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types';
import { createAuditLog } from '../services/auditService';
import { GRANTABLE_LABELS, GRANTABLE_PERMISSIONS, grantedPermissions, setGrantedPermissions } from '../services/userPermissionService';

/** GET /admin-users/:id/extra-permissions — what this user has been given on top of their role. */
export async function getExtraPermissions(req: AuthenticatedRequest, res: Response) {
  try {
    const user = await prisma.adminUser.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, role: { select: { name: true, permissions: { select: { name: true } } } } },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const fromRole = new Set(user.role.permissions.map((p) => p.name));
    res.json({
      granted: await grantedPermissions(user.id),
      available: GRANTABLE_PERMISSIONS.map((p) => ({ permission: p, label: GRANTABLE_LABELS[p] ?? p, fromRole: fromRole.has(p) })),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to load permissions' });
  }
}

/** PUT /admin-users/:id/extra-permissions { permissions: string[] } */
export async function putExtraPermissions(req: AuthenticatedRequest, res: Response) {
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String) : null;
  if (!permissions) return res.status(400).json({ error: 'permissions must be a list' });
  try {
    const user = await prisma.adminUser.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const before = await grantedPermissions(user.id);
    const after = await setGrantedPermissions(user.id, permissions, req.user!.id);
    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_USER_EXTRA_PERMISSIONS',
      entity: 'AdminUser',
      entityId: user.id,
      oldValues: { permissions: before },
      newValues: { permissions: after },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
    res.json({ granted: after });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to save permissions' });
  }
}
