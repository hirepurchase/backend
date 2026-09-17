import prisma from '../config/database';

interface AuditLogInput {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Actions that are not written to the audit trail.
 *
 * The trail is read to answer "who changed this, and when". These three answer
 * nothing of the sort: LOGIN alone reached 15,956 rows — 40% of the table —
 * and automated Knox evaluate/notify chatter is now recorded properly in
 * KnoxActionLog, with the device, the state either side and the transaction id.
 * Drowning the real entries in them made the trail worse at its one job.
 *
 * Suppressed centrally rather than by deleting the call sites, so this is one
 * obvious list to change your mind about rather than four scattered edits to
 * rediscover.
 *
 * Worth knowing what this costs: login history is what answers "was this
 * account used by someone who should not have it". That question can no longer
 * be answered from this table. If you need it, take LOGIN out of this list, or
 * record sign-ins somewhere built for them rather than here.
 */
const UNAUDITED_ACTIONS = new Set([
  'LOGIN',
  'EVALUATE_KNOX_GUARD_DEVICE',
  'NOTIFY_KNOX_GUARD_DEVICE',
]);

export async function createAuditLog(input: AuditLogInput): Promise<void> {
  if (UNAUDITED_ACTIONS.has(input.action)) {
    return;
  }

  try {
    await prisma.auditLog.create({
      data: {
        userId: input.userId,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId,
        oldValues: input.oldValues ? JSON.stringify(input.oldValues) : null,
        newValues: input.newValues ? JSON.stringify(input.newValues) : null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  } catch (error) {
    console.error('Failed to create audit log:', error);
    // Don't throw - audit logging should not break main operations
  }
}

export async function getAuditLogs(filters: {
  userId?: string;
  entity?: string;
  entityId?: string;
  action?: string;
  startDate?: Date;
  endDate?: Date;
  page?: number;
  limit?: number;
}) {
  const {
    userId,
    entity,
    entityId,
    action,
    startDate,
    endDate,
    page = 1,
    limit = 50,
  } = filters;

  const where: Record<string, unknown> = {};

  if (userId) where.userId = userId;
  if (entity) where.entity = entity;
  if (entityId) where.entityId = entityId;
  if (action) where.action = { contains: action };

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) (where.createdAt as Record<string, Date>).gte = startDate;
    if (endDate) (where.createdAt as Record<string, Date>).lte = endDate;
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
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    logs,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}
