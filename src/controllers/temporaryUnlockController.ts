import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { PERMISSIONS, hasPermission } from '../constants/permissions';
import { isOverdue } from '../utils/helpers';
import {
  TEMPORARY_UNLOCK_STATUS,
  DEFAULT_MAX_TEMPORARY_UNLOCK_WEEKS,
  computeExpiry,
} from '../services/temporaryUnlockService';
import { evaluateManagedDeviceForContract } from '../services/deviceControlPolicyService';

const prismaAny = prisma as any;

function getCaller(req: AuthenticatedRequest): AdminUserPayload {
  return req.user as AdminUserPayload;
}

function callerCan(req: AuthenticatedRequest, permission: string): boolean {
  const caller = getCaller(req);
  if (!caller) return false;
  if (caller.role === 'SUPER_ADMIN') return true;
  return hasPermission(caller.permissions as any, permission as any);
}

/** The arrears figure the decision is being made against. */
function computeOverdue(contract: any): { overdueAmount: number; overdueCount: number; maxDaysOverdue: number } {
  let overdueAmount = 0;
  let overdueCount = 0;
  let maxDaysOverdue = 0;
  const now = Date.now();

  for (const installment of contract.installments ?? []) {
    if (installment.status === 'PAID') continue;
    if (!isOverdue(installment.dueDate)) continue;
    const outstanding = Math.max(0, (installment.amount ?? 0) - (installment.paidAmount ?? 0));
    if (outstanding <= 0) continue;
    overdueAmount += outstanding;
    overdueCount += 1;
    const days = Math.floor((now - new Date(installment.dueDate).getTime()) / (1000 * 60 * 60 * 24));
    if (days > maxDaysOverdue) maxDaysOverdue = days;
  }

  return { overdueAmount: Number(overdueAmount.toFixed(2)), overdueCount, maxDaysOverdue };
}

async function getMaxWeeks(): Promise<number> {
  const settings = await prismaAny.knoxGuardSettings.findFirst({
    select: { temporaryUnlockMaxWeeks: true },
  });
  return settings?.temporaryUnlockMaxWeeks ?? DEFAULT_MAX_TEMPORARY_UNLOCK_WEEKS;
}

/**
 * The agents a cluster agent supervises. Only their customers may be
 * vouched for — the whole mechanism rests on the supervisor knowing the
 * customer well enough to stand behind the promise.
 */
async function getSupervisedAgentIds(clusterAgentId: string): Promise<string[]> {
  const rows = await prismaAny.clusterAgentAssignment.findMany({
    where: { clusterAgentId },
    select: { agentId: true },
  });
  return rows.map((row: { agentId: string }) => row.agentId);
}

function serialize(row: any) {
  return {
    id: row.id,
    contractId: row.contractId,
    contractNumber: row.contract?.contractNumber ?? null,
    customerName: row.contract?.customer
      ? `${row.contract.customer.firstName} ${row.contract.customer.lastName}`.trim()
      : null,
    customerPhone: row.contract?.customer?.phone ?? null,
    membershipId: row.contract?.customer?.membershipId ?? null,
    agentId: row.agentId,
    agentName: row.agent ? `${row.agent.firstName} ${row.agent.lastName}`.trim() : null,
    requestedById: row.requestedById,
    requestedByName: row.requestedBy
      ? `${row.requestedBy.firstName} ${row.requestedBy.lastName}`.trim()
      : null,
    requestedWeeks: row.requestedWeeks,
    approvedWeeks: row.approvedWeeks,
    reason: row.reason,
    status: row.status,
    expiresAt: row.expiresAt,
    arrearsAtApproval: row.arrearsAtApproval,
    reviewedByName: row.reviewedBy
      ? `${row.reviewedBy.firstName} ${row.reviewedBy.lastName}`.trim()
      : null,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    daysRemaining:
      row.status === TEMPORARY_UNLOCK_STATUS.APPROVED && row.expiresAt
        ? Math.max(0, Math.ceil((new Date(row.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null,
  };
}

const LIST_INCLUDE = {
  contract: {
    select: {
      contractNumber: true,
      totalPrice: true,
      outstandingBalance: true,
      customer: { select: { firstName: true, lastName: true, phone: true, membershipId: true } },
    },
  },
  agent: { select: { firstName: true, lastName: true } },
  requestedBy: { select: { firstName: true, lastName: true } },
  reviewedBy: { select: { firstName: true, lastName: true } },
};

// POST /temporary-unlocks
export async function createTemporaryUnlockRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const caller = getCaller(req);
    if (!caller) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { contractId, requestedWeeks, reason } = req.body ?? {};

    if (!contractId || typeof contractId !== 'string') {
      res.status(400).json({ error: 'A contract must be selected' });
      return;
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
      res.status(400).json({ error: 'Give a reason of at least 10 characters — an admin has to judge this on what you write' });
      return;
    }

    const maxWeeks = await getMaxWeeks();
    const weeks = Number(requestedWeeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > maxWeeks) {
      res.status(400).json({ error: `Requested period must be a whole number of weeks between 1 and ${maxWeeks}` });
      return;
    }

    const contract = await prismaAny.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        installments: true,
        customer: { select: { firstName: true, lastName: true } },
        managedDevice: { select: { id: true } },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }
    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Only active contracts can be granted a temporary unlock' });
      return;
    }

    // Super admins can raise one for anybody; a cluster agent only for the
    // agents they supervise.
    if (caller.role !== 'SUPER_ADMIN') {
      const supervised = await getSupervisedAgentIds(caller.id);
      if (!contract.createdById || !supervised.includes(contract.createdById)) {
        res.status(403).json({ error: 'You can only request an unlock for customers of agents you supervise' });
        return;
      }
    }

    const arrears = computeOverdue(contract);
    if (arrears.overdueAmount <= 0) {
      res.status(400).json({ error: 'This customer has nothing overdue — there is nothing to unlock for' });
      return;
    }

    const existing = await prismaAny.temporaryUnlockRequest.findFirst({
      where: {
        contractId,
        status: { in: [TEMPORARY_UNLOCK_STATUS.PENDING, TEMPORARY_UNLOCK_STATUS.APPROVED] },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      res.status(400).json({
        error:
          existing.status === TEMPORARY_UNLOCK_STATUS.PENDING
            ? 'A request for this contract is already awaiting approval'
            : 'This contract already has a live unlock window',
      });
      return;
    }

    // A cluster agent who has already defaulted on a guarantee for this agent
    // should be settling that before asking for another.
    const defaulted = await prismaAny.temporaryUnlockRequest.count({
      where: { agentId: contract.createdById, status: TEMPORARY_UNLOCK_STATUS.DEFAULTED },
    });
    if (defaulted > 0 && caller.role !== 'SUPER_ADMIN') {
      res.status(400).json({
        error: 'This agent already has a defaulted unlock guarantee outstanding. Clear that customer first.',
      });
      return;
    }

    const created = await prismaAny.temporaryUnlockRequest.create({
      data: {
        contractId,
        agentId: contract.createdById,
        requestedById: caller.id,
        requestedWeeks: weeks,
        reason: reason.trim(),
        status: TEMPORARY_UNLOCK_STATUS.PENDING,
      },
      include: LIST_INCLUDE,
    });

    await createAuditLog({
      userId: caller.id,
      action: 'REQUEST_TEMPORARY_UNLOCK',
      entity: 'TemporaryUnlockRequest',
      entityId: created.id,
      newValues: {
        contractNumber: contract.contractNumber,
        requestedWeeks: weeks,
        overdueAmount: arrears.overdueAmount,
        reason: reason.trim(),
      },
    });

    res.status(201).json({ request: serialize(created), arrears });
  } catch (error) {
    console.error('Create temporary unlock request error:', error);
    res.status(500).json({ error: 'Failed to create the request' });
  }
}

// POST /temporary-unlocks/:id/approve
export async function approveTemporaryUnlockRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const caller = getCaller(req);
    const { id } = req.params;
    const { approvedWeeks, note } = req.body ?? {};

    const request = await prismaAny.temporaryUnlockRequest.findUnique({
      where: { id },
      include: {
        contract: {
          include: {
            installments: true,
            customer: { select: { firstName: true, lastName: true } },
            managedDevice: { select: { id: true } },
          },
        },
      },
    });

    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== TEMPORARY_UNLOCK_STATUS.PENDING) {
      res.status(400).json({ error: `This request is already ${request.status.toLowerCase()}` });
      return;
    }
    if (request.contract?.status !== 'ACTIVE') {
      res.status(400).json({ error: 'The contract is no longer active' });
      return;
    }

    const maxWeeks = await getMaxWeeks();
    // An approver may grant less than was asked for, never more.
    const weeks = approvedWeeks === undefined || approvedWeeks === null
      ? request.requestedWeeks
      : Number(approvedWeeks);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > Math.min(maxWeeks, request.requestedWeeks)) {
      res.status(400).json({
        error: `Approved period must be between 1 and ${Math.min(maxWeeks, request.requestedWeeks)} weeks`,
      });
      return;
    }

    const arrears = computeOverdue(request.contract);
    const expiresAt = computeExpiry(weeks);

    const updated = await prismaAny.temporaryUnlockRequest.update({
      where: { id },
      data: {
        status: TEMPORARY_UNLOCK_STATUS.APPROVED,
        approvedWeeks: weeks,
        expiresAt,
        // Recorded at approval so the expiry job can tell whether the customer
        // actually used the window, regardless of later schedule edits.
        arrearsAtApproval: arrears.overdueAmount,
        reviewedById: caller.id,
        reviewedAt: new Date(),
        reviewNote: typeof note === 'string' && note.trim() ? note.trim() : null,
      },
      include: LIST_INCLUDE,
    });

    // Cancel any lock still sitting in the retry queue for this device, then
    // let the evaluator recompute — it will see the live override and unlock.
    if (request.contract.managedDevice?.id) {
      await prismaAny.managedDeviceCommand.updateMany({
        where: {
          managedDeviceId: request.contract.managedDevice.id,
          type: 'LOCK_DEVICE',
          status: { in: ['QUEUED', 'PENDING', 'FAILED'] },
        },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          nextAttemptAt: null,
          errorMessage: 'Cancelled — temporary unlock approved.',
        },
      });
    }

    let deviceResult: { action: string | null; success: boolean } | null = null;
    try {
      const evaluation: any = await evaluateManagedDeviceForContract(request.contractId);
      deviceResult = {
        action: evaluation?.actionType ?? evaluation?.action ?? null,
        success: Boolean(evaluation?.actionSuccess ?? evaluation?.success ?? evaluation?.actionDryRun),
      };
    } catch (error: any) {
      // The approval itself stands — the five-minute scheduler will pick the
      // device up. Surfaced so the approver is not told the phone is open when
      // it may not be yet.
      console.error('Temporary unlock approved but device evaluation failed:', error?.message);
      deviceResult = { action: null, success: false };
    }

    await createAuditLog({
      userId: caller.id,
      action: 'APPROVE_TEMPORARY_UNLOCK',
      entity: 'TemporaryUnlockRequest',
      entityId: id,
      newValues: {
        contractNumber: request.contract.contractNumber,
        approvedWeeks: weeks,
        expiresAt,
        arrearsAtApproval: arrears.overdueAmount,
        deviceAction: deviceResult?.action,
      },
    });

    res.json({ request: serialize(updated), device: deviceResult });
  } catch (error) {
    console.error('Approve temporary unlock error:', error);
    res.status(500).json({ error: 'Failed to approve the request' });
  }
}

// POST /temporary-unlocks/:id/reject
export async function rejectTemporaryUnlockRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const caller = getCaller(req);
    const { id } = req.params;
    const { note } = req.body ?? {};

    const request = await prismaAny.temporaryUnlockRequest.findUnique({
      where: { id },
      include: { contract: { select: { contractNumber: true } } },
    });
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== TEMPORARY_UNLOCK_STATUS.PENDING) {
      res.status(400).json({ error: `This request is already ${request.status.toLowerCase()}` });
      return;
    }

    const updated = await prismaAny.temporaryUnlockRequest.update({
      where: { id },
      data: {
        status: TEMPORARY_UNLOCK_STATUS.REJECTED,
        reviewedById: caller.id,
        reviewedAt: new Date(),
        reviewNote: typeof note === 'string' && note.trim() ? note.trim() : null,
        resolvedAt: new Date(),
      },
      include: LIST_INCLUDE,
    });

    await createAuditLog({
      userId: caller.id,
      action: 'REJECT_TEMPORARY_UNLOCK',
      entity: 'TemporaryUnlockRequest',
      entityId: id,
      newValues: { contractNumber: request.contract?.contractNumber, note: note ?? null },
    });

    res.json({ request: serialize(updated) });
  } catch (error) {
    console.error('Reject temporary unlock error:', error);
    res.status(500).json({ error: 'Failed to reject the request' });
  }
}

// POST /temporary-unlocks/:id/cancel — the requester withdrawing their own ask
export async function cancelTemporaryUnlockRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const caller = getCaller(req);
    const { id } = req.params;

    const request = await prismaAny.temporaryUnlockRequest.findUnique({
      where: { id },
      include: { contract: { select: { contractNumber: true } } },
    });
    if (!request) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    if (request.status !== TEMPORARY_UNLOCK_STATUS.PENDING) {
      res.status(400).json({ error: 'Only a request still awaiting approval can be withdrawn' });
      return;
    }
    if (request.requestedById !== caller.id && caller.role !== 'SUPER_ADMIN') {
      res.status(403).json({ error: 'You can only withdraw your own request' });
      return;
    }

    const updated = await prismaAny.temporaryUnlockRequest.update({
      where: { id },
      data: { status: TEMPORARY_UNLOCK_STATUS.CANCELLED, resolvedAt: new Date() },
      include: LIST_INCLUDE,
    });

    await createAuditLog({
      userId: caller.id,
      action: 'CANCEL_TEMPORARY_UNLOCK',
      entity: 'TemporaryUnlockRequest',
      entityId: id,
      newValues: { contractNumber: request.contract?.contractNumber },
    });

    res.json({ request: serialize(updated) });
  } catch (error) {
    console.error('Cancel temporary unlock error:', error);
    res.status(500).json({ error: 'Failed to withdraw the request' });
  }
}

// GET /temporary-unlocks
export async function listTemporaryUnlockRequests(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const caller = getCaller(req);
    const { status } = req.query as { status?: string };

    const where: any = {};
    if (status && status !== 'ALL') {
      where.status = String(status).toUpperCase();
    }

    // Approvers and viewers see everything; a cluster agent sees only what
    // concerns the agents they supervise, plus anything they raised.
    const canSeeAll =
      caller.role === 'SUPER_ADMIN' ||
      callerCan(req, PERMISSIONS.APPROVE_TEMPORARY_UNLOCK) ||
      callerCan(req, PERMISSIONS.VIEW_TEMPORARY_UNLOCKS);

    if (!canSeeAll) {
      const supervised = await getSupervisedAgentIds(caller.id);
      where.OR = [{ agentId: { in: supervised } }, { requestedById: caller.id }];
    }

    const rows = await prismaAny.temporaryUnlockRequest.findMany({
      where,
      include: LIST_INCLUDE,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 300,
    });

    const counts = await prismaAny.temporaryUnlockRequest.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: canSeeAll ? {} : where,
    });

    res.json({
      requests: rows.map(serialize),
      counts: counts.reduce((acc: Record<string, number>, row: any) => {
        acc[row.status] = row._count._all;
        return acc;
      }, {}),
    });
  } catch (error) {
    console.error('List temporary unlocks error:', error);
    res.status(500).json({ error: 'Failed to load requests' });
  }
}

// GET /temporary-unlocks/pending-count — for the approver bell
export async function getPendingTemporaryUnlockCount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const count = await prismaAny.temporaryUnlockRequest.count({
      where: { status: TEMPORARY_UNLOCK_STATUS.PENDING },
    });
    res.json({ count });
  } catch (error) {
    console.error('Pending temporary unlock count error:', error);
    res.status(500).json({ error: 'Failed to load count' });
  }
}

// GET /temporary-unlocks/eligible-contracts — the picker for a new request
export async function getEligibleContracts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const caller = getCaller(req);

    const agentIds =
      caller.role === 'SUPER_ADMIN' ? null : await getSupervisedAgentIds(caller.id);
    if (agentIds !== null && agentIds.length === 0) {
      res.json({ contracts: [] });
      return;
    }

    const contracts = await prismaAny.hirePurchaseContract.findMany({
      where: {
        status: 'ACTIVE',
        ...(agentIds ? { createdById: { in: agentIds } } : {}),
        installments: { some: { status: { in: ['OVERDUE', 'PARTIAL', 'PENDING'] }, dueDate: { lt: new Date() } } },
      },
      include: {
        installments: true,
        customer: { select: { firstName: true, lastName: true, phone: true, membershipId: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        managedDevice: { select: { actualState: true } },
        temporaryUnlocks: {
          where: { status: { in: [TEMPORARY_UNLOCK_STATUS.PENDING, TEMPORARY_UNLOCK_STATUS.APPROVED] } },
          select: { id: true, status: true },
        },
      },
      take: 500,
    });

    const rows = contracts
      .map((contract: any) => {
        const arrears = computeOverdue(contract);
        return {
          id: contract.id,
          contractNumber: contract.contractNumber,
          customerName: `${contract.customer.firstName} ${contract.customer.lastName}`.trim(),
          customerPhone: contract.customer.phone,
          membershipId: contract.customer.membershipId,
          agentName: contract.createdBy
            ? `${contract.createdBy.firstName} ${contract.createdBy.lastName}`.trim()
            : null,
          outstandingBalance: contract.outstandingBalance,
          deviceState: contract.managedDevice?.actualState ?? null,
          hasOpenRequest: (contract.temporaryUnlocks ?? []).length > 0,
          ...arrears,
        };
      })
      .filter((row: any) => row.overdueAmount > 0)
      .sort((a: any, b: any) => b.maxDaysOverdue - a.maxDaysOverdue);

    res.json({ contracts: rows });
  } catch (error) {
    console.error('Eligible contracts error:', error);
    res.status(500).json({ error: 'Failed to load contracts' });
  }
}
