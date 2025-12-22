import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest } from '../types';

// Get all roles with their permissions
export async function getAllRoles(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const roles = await prisma.role.findMany({
      include: {
        permissions: {
          select: {
            id: true,
            name: true,
            description: true,
          },
        },
        _count: {
          select: {
            adminUsers: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json(roles);
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
}

// Get single role by ID
export async function getRoleById(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        permissions: true,
        adminUsers: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (!role) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }

    res.json(role);
  } catch (error) {
    console.error('Get role error:', error);
    res.status(500).json({ error: 'Failed to fetch role' });
  }
}

// Create a new role
export async function createRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { name, description, permissionIds } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Role name is required' });
      return;
    }

    // Check if role name already exists
    const existingRole = await prisma.role.findUnique({ where: { name } });
    if (existingRole) {
      res.status(400).json({ error: 'Role name already exists' });
      return;
    }

    // Create role with permissions
    const role = await prisma.role.create({
      data: {
        name,
        description: description || null,
        isSystem: false,
        permissions: permissionIds && permissionIds.length > 0 ? {
          connect: permissionIds.map((id: string) => ({ id })),
        } : undefined,
      },
      include: {
        permissions: true,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CREATE_ROLE',
      entity: 'Role',
      entityId: role.id,
      newValues: { name, description, permissionIds },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json(role);
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ error: 'Failed to create role' });
  }
}

// Update role
export async function updateRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, permissionIds } = req.body;

    const existingRole = await prisma.role.findUnique({
      where: { id },
      include: { permissions: true },
    });

    if (!existingRole) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }

    // Prevent modification of system roles' basic properties
    if (existingRole.isSystem && (name !== existingRole.name)) {
      res.status(400).json({ error: 'Cannot rename system roles' });
      return;
    }

    // Check if new name conflicts with existing role
    if (name && name !== existingRole.name) {
      const nameConflict = await prisma.role.findUnique({ where: { name } });
      if (nameConflict) {
        res.status(400).json({ error: 'Role name already exists' });
        return;
      }
    }

    const updateData: any = {};
    if (name && !existingRole.isSystem) updateData.name = name;
    if (description !== undefined) updateData.description = description;

    // Update permissions
    if (permissionIds !== undefined) {
      updateData.permissions = {
        set: [], // Clear all permissions
        connect: permissionIds.map((id: string) => ({ id })),
      };
    }

    const updatedRole = await prisma.role.update({
      where: { id },
      data: updateData,
      include: {
        permissions: true,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_ROLE',
      entity: 'Role',
      entityId: id,
      oldValues: {
        name: existingRole.name,
        description: existingRole.description,
        permissionIds: existingRole.permissions.map(p => p.id),
      },
      newValues: { name, description, permissionIds },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(updatedRole);
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
}

// Delete role
export async function deleteRole(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const role = await prisma.role.findUnique({
      where: { id },
      include: {
        _count: {
          select: { adminUsers: true },
        },
      },
    });

    if (!role) {
      res.status(404).json({ error: 'Role not found' });
      return;
    }

    // Prevent deletion of system roles
    if (role.isSystem) {
      res.status(400).json({ error: 'Cannot delete system roles' });
      return;
    }

    // Check if role is assigned to any users
    if (role._count.adminUsers > 0) {
      res.status(400).json({
        error: 'Cannot delete role that is assigned to users',
        usersCount: role._count.adminUsers,
      });
      return;
    }

    await prisma.role.delete({ where: { id } });

    await createAuditLog({
      userId: req.user!.id,
      action: 'DELETE_ROLE',
      entity: 'Role',
      entityId: id,
      oldValues: {
        name: role.name,
        description: role.description,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Role deleted successfully' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ error: 'Failed to delete role' });
  }
}

// Get all permissions
export async function getAllPermissions(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const permissions = await prisma.permission.findMany({
      orderBy: {
        name: 'asc',
      },
    });

    res.json(permissions);
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
}
