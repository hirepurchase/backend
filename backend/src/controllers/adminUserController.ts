import { Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';

// Get all admin users
export async function getAllAdminUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { page = 1, limit = 20, search, roleId, isActive } = req.query;

    const where: Record<string, unknown> = {};

    if (search) {
      where.OR = [
        { email: { contains: search as string } },
        { firstName: { contains: search as string } },
        { lastName: { contains: search as string } },
      ];
    }

    if (roleId) where.roleId = roleId;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const [users, total] = await Promise.all([
      prisma.adminUser.findMany({
        where,
        include: {
          role: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.adminUser.count({ where }),
    ]);

    res.json({
      users: users.map(u => ({
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        isActive: u.isActive,
        role: u.role,
        createdAt: u.createdAt,
      })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({ error: 'Failed to fetch admin users' });
  }
}

// Create admin user (Super Admin only)
export async function createAdminUser(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { email, password, firstName, lastName, phone, roleId } = req.body;

    if (!email || !password || !firstName || !lastName || !roleId) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Check if email exists
    const existingUser = await prisma.adminUser.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      res.status(400).json({ error: 'Email already exists' });
      return;
    }

    // Verify role exists
    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      res.status(400).json({ error: 'Invalid role' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const newUser = await prisma.adminUser.create({
      data: {
        email: email.toLowerCase(),
        password: hashedPassword,
        firstName,
        lastName,
        phone,
        roleId,
      },
      include: {
        role: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CREATE_ADMIN_USER',
      entity: 'AdminUser',
      entityId: newUser.id,
      newValues: { email: newUser.email, firstName, lastName, roleId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      id: newUser.id,
      email: newUser.email,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      phone: newUser.phone,
      isActive: newUser.isActive,
      role: newUser.role,
      createdAt: newUser.createdAt,
    });
  } catch (error) {
    console.error('Create admin user error:', error);
    res.status(500).json({ error: 'Failed to create admin user' });
  }
}

// Update admin user
export async function updateAdminUser(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { firstName, lastName, phone, roleId, isActive } = req.body;
    const currentUser = req.user as AdminUserPayload;

    const existingUser = await prisma.adminUser.findUnique({
      where: { id },
      include: { role: true },
    });

    if (!existingUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Prevent non-super admins from modifying other users
    if (currentUser.role !== 'SUPER_ADMIN' && currentUser.id !== id) {
      res.status(403).json({ error: 'Cannot modify other users' });
      return;
    }

    // Prevent changing own role or active status
    if (currentUser.id === id && (roleId || isActive !== undefined)) {
      res.status(403).json({ error: 'Cannot change own role or status' });
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (phone !== undefined) updateData.phone = phone;
    if (roleId && currentUser.role === 'SUPER_ADMIN') updateData.roleId = roleId;
    if (isActive !== undefined && currentUser.role === 'SUPER_ADMIN') updateData.isActive = isActive;

    const updatedUser = await prisma.adminUser.update({
      where: { id },
      data: updateData,
      include: {
        role: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_ADMIN_USER',
      entity: 'AdminUser',
      entityId: id,
      oldValues: {
        firstName: existingUser.firstName,
        lastName: existingUser.lastName,
        phone: existingUser.phone,
        roleId: existingUser.roleId,
        isActive: existingUser.isActive,
      },
      newValues: updateData,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      id: updatedUser.id,
      email: updatedUser.email,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      phone: updatedUser.phone,
      isActive: updatedUser.isActive,
      role: updatedUser.role,
      updatedAt: updatedUser.updatedAt,
    });
  } catch (error) {
    console.error('Update admin user error:', error);
    res.status(500).json({ error: 'Failed to update admin user' });
  }
}

// Change password
export async function changePassword(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Current and new passwords are required' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }

    const user = await prisma.adminUser.findUnique({
      where: { id: req.user!.id },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const isValidPassword = await bcrypt.compare(currentPassword, user.password);

    if (!isValidPassword) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.adminUser.update({
      where: { id: req.user!.id },
      data: { password: hashedPassword },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CHANGE_PASSWORD',
      entity: 'AdminUser',
      entityId: req.user!.id,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
}

// Get all roles
export async function getRoles(req: AuthenticatedRequest, res: Response): Promise<void> {
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
      },
      orderBy: { name: 'asc' },
    });

    res.json(roles);
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
}

// Get all permissions
export async function getPermissions(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const permissions = await prisma.permission.findMany({
      orderBy: { name: 'asc' },
    });

    res.json(permissions);
  } catch (error) {
    console.error('Get permissions error:', error);
    res.status(500).json({ error: 'Failed to fetch permissions' });
  }
}
