import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types';

const DEFAULT_DURATION_DAYS = 7;

// Admin-only: create a new announcement targeted at one or more roles.
export async function createAnnouncement(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { message, targetRoleIds, durationDays } = req.body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    if (!Array.isArray(targetRoleIds) || targetRoleIds.length === 0) {
      res.status(400).json({ error: 'targetRoleIds must be a non-empty array' });
      return;
    }

    const roles = await prisma.role.findMany({
      where: { id: { in: targetRoleIds } },
      select: { id: true },
    });
    if (roles.length !== targetRoleIds.length) {
      res.status(400).json({ error: 'One or more targetRoleIds do not exist' });
      return;
    }

    const days = durationDays !== undefined ? Number(durationDays) : DEFAULT_DURATION_DAYS;
    if (!Number.isFinite(days) || days <= 0) {
      res.status(400).json({ error: 'durationDays must be a positive number' });
      return;
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + days);

    const announcement = await prisma.staffAnnouncement.create({
      data: {
        message: message.trim(),
        targetRoleIds,
        createdById: req.user!.id,
        expiresAt,
      },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    res.status(201).json(announcement);
  } catch (error) {
    console.error('Create announcement error:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
}

// Admin-only: list all announcements (most recent first) for the management page.
export async function listAnnouncements(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const announcements = await prisma.staffAnnouncement.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { firstName: true, lastName: true } },
      },
      take: 100,
    });

    const roleIds = Array.from(new Set(announcements.flatMap((a) => a.targetRoleIds)));
    const roles = await prisma.role.findMany({
      where: { id: { in: roleIds } },
      select: { id: true, name: true },
    });
    const roleNameById = new Map(roles.map((r) => [r.id, r.name]));

    res.json(
      announcements.map((a) => ({
        ...a,
        targetRoleNames: a.targetRoleIds.map((id) => roleNameById.get(id) || 'Unknown role'),
      }))
    );
  } catch (error) {
    console.error('List announcements error:', error);
    res.status(500).json({ error: 'Failed to list announcements' });
  }
}

// Admin-only: deactivate an announcement early, before it naturally expires.
export async function deactivateAnnouncement(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const announcement = await prisma.staffAnnouncement.findUnique({ where: { id } });
    if (!announcement) {
      res.status(404).json({ error: 'Announcement not found' });
      return;
    }

    const updated = await prisma.staffAnnouncement.update({
      where: { id },
      data: { isActive: false },
    });

    res.json(updated);
  } catch (error) {
    console.error('Deactivate announcement error:', error);
    res.status(500).json({ error: 'Failed to deactivate announcement' });
  }
}

// Any authenticated staff member: the announcements currently active for their role.
export async function getMyActiveAnnouncements(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.user!.id },
      select: { roleId: true },
    });
    if (!admin) {
      res.status(404).json({ error: 'Admin user not found' });
      return;
    }

    const announcements = await prisma.staffAnnouncement.findMany({
      where: {
        isActive: true,
        expiresAt: { gt: new Date() },
        targetRoleIds: { has: admin.roleId },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        message: true,
        createdAt: true,
        expiresAt: true,
        createdBy: { select: { firstName: true, lastName: true } },
      },
    });

    res.json(announcements);
  } catch (error) {
    console.error('Get my announcements error:', error);
    res.status(500).json({ error: 'Failed to load announcements' });
  }
}
