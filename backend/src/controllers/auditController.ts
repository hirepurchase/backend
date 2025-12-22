import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types';

// Get audit logs with filtering and pagination
export async function getAuditLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      page = 1,
      limit = 50,
      action,
      entity,
      userId,
      startDate,
      endDate,
    } = req.query;

    const where: Record<string, any> = {};

    if (action) where.action = action;
    if (entity) where.entity = entity;
    if (userId) where.userId = userId;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Parse JSON strings for old and new values
    const logsWithParsedValues = logs.map(log => ({
      ...log,
      oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
      newValues: log.newValues ? JSON.parse(log.newValues) : null,
    }));

    res.json({
      logs: logsWithParsedValues,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
}

// Get audit log statistics
export async function getAuditLogStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { startDate, endDate } = req.query;

    const where: Record<string, any> = {};

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }

    // Get action counts
    const actionCounts = await prisma.auditLog.groupBy({
      by: ['action'],
      where,
      _count: {
        action: true,
      },
      orderBy: {
        _count: {
          action: 'desc',
        },
      },
    });

    // Get entity counts
    const entityCounts = await prisma.auditLog.groupBy({
      by: ['entity'],
      where,
      _count: {
        entity: true,
      },
      orderBy: {
        _count: {
          entity: 'desc',
        },
      },
    });

    // Get user activity
    const userActivity = await prisma.auditLog.groupBy({
      by: ['userId'],
      where: {
        ...where,
        userId: { not: null },
      },
      _count: {
        userId: true,
      },
      orderBy: {
        _count: {
          userId: 'desc',
        },
      },
      take: 10,
    });

    // Get user details for top users
    const userIds = userActivity.map(u => u.userId).filter((id): id is string => id !== null);
    const users = await prisma.adminUser.findMany({
      where: {
        id: { in: userIds },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    });

    const userActivityWithDetails = userActivity.map(activity => ({
      ...activity,
      user: users.find(u => u.id === activity.userId),
    }));

    res.json({
      actionCounts,
      entityCounts,
      userActivity: userActivityWithDetails,
      totalLogs: await prisma.auditLog.count({ where }),
    });
  } catch (error) {
    console.error('Get audit log stats error:', error);
    res.status(500).json({ error: 'Failed to fetch audit log statistics' });
  }
}

// Get distinct actions for filtering
export async function getAuditActions(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const actions = await prisma.auditLog.findMany({
      select: {
        action: true,
      },
      distinct: ['action'],
      orderBy: {
        action: 'asc',
      },
    });

    res.json(actions.map(a => a.action));
  } catch (error) {
    console.error('Get audit actions error:', error);
    res.status(500).json({ error: 'Failed to fetch audit actions' });
  }
}

// Get distinct entities for filtering
export async function getAuditEntities(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const entities = await prisma.auditLog.findMany({
      select: {
        entity: true,
      },
      distinct: ['entity'],
      orderBy: {
        entity: 'asc',
      },
    });

    res.json(entities.map(e => e.entity));
  } catch (error) {
    console.error('Get audit entities error:', error);
    res.status(500).json({ error: 'Failed to fetch audit entities' });
  }
}
