import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import {
  buildApprovalSnapshots,
  evaluateContractSubmissionGuardrails,
  getApprovalHistory,
  getLatestApprovalAssignments,
} from '../services/contractReviewService';
import {
  sendContractApprovedNotification,
  sendContractConfirmation,
  sendContractRevisionRequestedNotification,
} from '../services/notificationService';
import { enrollManagedDeviceForContract } from '../services/deviceControlPolicyService';
import { createAgentDepositLedgerEntry } from './agentDepositController';
import { AuthenticatedRequest, AdminUserPayload, PaymentFrequency } from '../types';
import { calculateInstallmentSchedule, calculateEndDate } from '../utils/helpers';

const PRIORITY_RANK: Record<string, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function normalizeSortOrder(value: unknown): 'asc' | 'desc' {
  return String(value).toLowerCase() === 'asc' ? 'asc' : 'desc';
}

function compareValues(a: string | number | Date, b: string | number | Date, order: 'asc' | 'desc'): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;

  if (left === right) return 0;
  const base = left > right ? 1 : -1;
  return order === 'asc' ? base : base * -1;
}

function buildAgentContractWhere(admin: AdminUserPayload, query: AuthenticatedRequest['query']): Record<string, unknown> {
  const where: Record<string, unknown> = { createdById: admin.id };
  const { status, search } = query;

  if (status) {
    where.status = status;
  }

  if (search) {
    where.OR = [
      { contractNumber: { contains: search as string, mode: 'insensitive' } },
      { customer: { firstName: { contains: search as string, mode: 'insensitive' } } },
      { customer: { lastName: { contains: search as string, mode: 'insensitive' } } },
      { customer: { membershipId: { contains: search as string, mode: 'insensitive' } } },
      { inventoryItem: { serialNumber: { contains: search as string, mode: 'insensitive' } } },
      { inventoryItem: { product: { name: { contains: search as string, mode: 'insensitive' } } } },
    ];
  }

  return where;
}

function buildPendingApprovalsWhere(query: AuthenticatedRequest['query']): Record<string, unknown> {
  const where: Record<string, unknown> = { status: 'PENDING_APPROVAL' };
  const { search, agentId, paymentMethod } = query;

  if (agentId) {
    where.createdById = agentId as string;
  }

  if (paymentMethod) {
    where.paymentMethod = paymentMethod as string;
  }

  if (search) {
    where.OR = [
      { contractNumber: { contains: search as string, mode: 'insensitive' } },
      { customer: { firstName: { contains: search as string, mode: 'insensitive' } } },
      { customer: { lastName: { contains: search as string, mode: 'insensitive' } } },
      { customer: { membershipId: { contains: search as string, mode: 'insensitive' } } },
      { customer: { phone: { contains: search as string, mode: 'insensitive' } } },
      { inventoryItem: { serialNumber: { contains: search as string, mode: 'insensitive' } } },
      { inventoryItem: { product: { name: { contains: search as string, mode: 'insensitive' } } } },
      { createdBy: { firstName: { contains: search as string, mode: 'insensitive' } } },
      { createdBy: { lastName: { contains: search as string, mode: 'insensitive' } } },
    ];
  }

  return where;
}

function sortPendingApprovals(contracts: any[], sortBy: string, sortOrder: 'asc' | 'desc'): any[] {
  return [...contracts].sort((left, right) => {
    const leftSnapshot = left.approvalSnapshot;
    const rightSnapshot = right.approvalSnapshot;

    if (sortBy === 'priority') {
      return compareValues(
        PRIORITY_RANK[leftSnapshot?.priority || 'LOW'],
        PRIORITY_RANK[rightSnapshot?.priority || 'LOW'],
        sortOrder === 'asc' ? 'asc' : 'desc'
      );
    }

    if (sortBy === 'submittedAt') {
      return compareValues(
        new Date(leftSnapshot?.lastSubmittedAt || left.createdAt),
        new Date(rightSnapshot?.lastSubmittedAt || right.createdAt),
        sortOrder
      );
    }

    if (sortBy === 'amount') {
      return compareValues(left.totalPrice, right.totalPrice, sortOrder);
    }

    if (sortBy === 'customer') {
      return compareValues(
        `${left.customer?.firstName || ''} ${left.customer?.lastName || ''}`.trim().toLowerCase(),
        `${right.customer?.firstName || ''} ${right.customer?.lastName || ''}`.trim().toLowerCase(),
        sortOrder
      );
    }

    if (sortBy === 'agent') {
      return compareValues(
        `${left.createdBy?.firstName || ''} ${left.createdBy?.lastName || ''}`.trim().toLowerCase(),
        `${right.createdBy?.firstName || ''} ${right.createdBy?.lastName || ''}`.trim().toLowerCase(),
        sortOrder
      );
    }

    return compareValues(leftSnapshot?.ageHours || 0, rightSnapshot?.ageHours || 0, sortOrder);
  });
}

// GET /contracts/agent/mine — agent sees only contracts they created
export async function getAgentContracts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const skip = (page - 1) * limit;
    const where = buildAgentContractWhere(admin, req.query);

    const [contracts, total] = await Promise.all([
      prisma.hirePurchaseContract.findMany({
        where,
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, membershipId: true, phone: true, photoUrl: true },
          },
          inventoryItem: {
            select: {
              serialNumber: true,
              status: true,
              productId: true,
              product: { select: { name: true } },
            },
          },
          _count: { select: { payments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.hirePurchaseContract.count({ where }),
    ]);

    const snapshots = await buildApprovalSnapshots(contracts);

    res.json({
      contracts: contracts.map((contract) => ({
        ...contract,
        approvalSnapshot: snapshots[contract.id] || null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('getAgentContracts error:', error);
    res.status(500).json({ error: 'Failed to fetch your contracts' });
  }
}

// GET /contracts/agent/mine/:id — agent views a single contract they created (with payments)
export async function getAgentContractById(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { id } = req.params;

    const contract = await prisma.hirePurchaseContract.findFirst({
      where: { id, createdById: admin.id },
      include: {
        customer: true,
        inventoryItem: {
          include: { product: { include: { category: true } } },
        },
        installments: { orderBy: { installmentNo: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            role: { select: { name: true } },
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found or not accessible' });
      return;
    }

    const [approvalHistory, snapshots] = await Promise.all([
      getApprovalHistory(id),
      buildApprovalSnapshots([contract]),
    ]);

    res.json({
      ...contract,
      approvalHistory,
      approvalSnapshot: snapshots[id] || null,
    });
  } catch (error) {
    console.error('getAgentContractById error:', error);
    res.status(500).json({ error: 'Failed to fetch contract' });
  }
}

// GET /contracts/approvals — list contracts with PENDING_APPROVAL status
export async function getPendingApprovals(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const page = parseInt(req.query.page as string, 10) || 1;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const priority = (req.query.priority as string | undefined)?.toUpperCase();
    const riskFlag = req.query.riskFlag as string | undefined;
    const assignedTo = req.query.assignedTo as string | undefined;
    const sortBy = (req.query.sortBy as string) || 'age';
    const sortOrder = normalizeSortOrder(req.query.sortOrder);

    const contracts = await prisma.hirePurchaseContract.findMany({
      where: buildPendingApprovalsWhere(req.query),
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            membershipId: true,
            phone: true,
            email: true,
            address: true,
            nationalId: true,
            dateOfBirth: true,
            photoUrl: true,
            guarantorName: true,
            guarantorPhone: true,
          },
        },
        inventoryItem: {
          select: {
            serialNumber: true,
            productId: true,
            lockStatus: true,
            product: { select: { name: true, category: { select: { name: true } } } },
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            role: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const snapshots = await buildApprovalSnapshots(contracts);
    let hydratedContracts = contracts.map((contract) => ({
      ...contract,
      approvalSnapshot: snapshots[contract.id] || null,
    }));

    if (priority) {
      hydratedContracts = hydratedContracts.filter((contract) => contract.approvalSnapshot?.priority === priority);
    }

    if (riskFlag) {
      hydratedContracts = hydratedContracts.filter((contract) =>
        contract.approvalSnapshot?.riskFlags?.includes(riskFlag)
      );
    }

    if (assignedTo) {
      hydratedContracts = hydratedContracts.filter((contract) => {
        const assignedApproverId = contract.approvalSnapshot?.currentAssignment?.assignedApproverId || null;

        if (assignedTo === 'me') {
          return assignedApproverId === admin.id;
        }

        if (assignedTo === 'unassigned') {
          return !assignedApproverId;
        }

        return assignedApproverId === assignedTo;
      });
    }

    const sortedContracts = sortPendingApprovals(hydratedContracts, sortBy, sortOrder);
    const total = sortedContracts.length;
    const paginatedContracts = sortedContracts.slice((page - 1) * limit, page * limit);

    res.json({
      contracts: paginatedContracts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      queueSummary: {
        total,
        highPriority: hydratedContracts.filter((contract) => contract.approvalSnapshot?.priority === 'HIGH').length,
        mediumPriority: hydratedContracts.filter((contract) => contract.approvalSnapshot?.priority === 'MEDIUM').length,
        breached: hydratedContracts.filter((contract) => contract.approvalSnapshot?.isBreached).length,
        unassigned: hydratedContracts.filter((contract) => !contract.approvalSnapshot?.currentAssignment?.assignedApproverId).length,
        mine: hydratedContracts.filter((contract) => contract.approvalSnapshot?.currentAssignment?.assignedApproverId === admin.id).length,
      },
    });
  } catch (error) {
    console.error('getPendingApprovals error:', error);
    res.status(500).json({ error: 'Failed to fetch pending approvals' });
  }
}

// GET /contracts/approvals/count — lightweight count for notification bell
export async function getPendingApprovalsCount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const count = await prisma.hirePurchaseContract.count({ where: { status: 'PENDING_APPROVAL' } });
    res.json({ count });
  } catch (error) {
    console.error('getPendingApprovalsCount error:', error);
    res.status(500).json({ error: 'Failed to fetch count' });
  }
}

// GET /contracts/:id/approval-history
export async function getContractApprovalHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        inventoryItem: {
          select: {
            productId: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const [history, snapshots] = await Promise.all([
      getApprovalHistory(id),
      buildApprovalSnapshots([contract]),
    ]);

    res.json({
      history,
      approvalSnapshot: snapshots[id] || null,
    });
  } catch (error) {
    console.error('getContractApprovalHistory error:', error);
    res.status(500).json({ error: 'Failed to fetch approval history' });
  }
}

// POST /contracts/:id/assign-approver
export async function assignContractApprover(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const admin = req.user as AdminUserPayload;
    const requestedApproverId = typeof req.body?.assignedApproverId === 'string'
      ? req.body.assignedApproverId.trim()
      : '';

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'PENDING_APPROVAL') {
      res.status(400).json({ error: `Only PENDING_APPROVAL contracts can be assigned (current: ${contract.status})` });
      return;
    }

    const currentAssignments = await getLatestApprovalAssignments([id]);
    const currentAssignment = currentAssignments[id];

    let assignedApprover: {
      id: string;
      firstName: string;
      lastName: string;
      isActive: boolean;
    } | null = null;
    if (requestedApproverId) {
      assignedApprover = await prisma.adminUser.findUnique({
        where: { id: requestedApproverId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          isActive: true,
        },
      });

      if (!assignedApprover || !assignedApprover.isActive) {
        res.status(400).json({ error: 'Selected approver could not be found or is inactive' });
        return;
      }
    }

    await createAuditLog({
      userId: admin.id,
      action: 'ASSIGN_CONTRACT_APPROVER',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: {
        assignedApproverId: currentAssignment?.assignedApproverId || null,
        assignedApproverName: currentAssignment?.assignedApproverName || null,
      },
      newValues: {
        assignedApproverId: assignedApprover?.id || null,
        assignedApproverName: assignedApprover ? `${assignedApprover.firstName} ${assignedApprover.lastName}`.trim() : null,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    const refreshedAssignments = await getLatestApprovalAssignments([id]);

    res.json({
      message: assignedApprover ? 'Approver assigned successfully' : 'Approver assignment cleared',
      assignment: refreshedAssignments[id] || null,
    });
  } catch (error) {
    console.error('assignContractApprover error:', error);
    res.status(500).json({ error: 'Failed to assign approver' });
  }
}

// POST /contracts/:id/approve
export async function approveContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const admin = req.user as AdminUserPayload;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        inventoryItem: {
          include: {
            product: true,
          },
        },
        customer: {
          select: {
            firstName: true,
            lastName: true,
            membershipId: true,
            phone: true,
            email: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'PENDING_APPROVAL') {
      res.status(400).json({ error: `Contract is not pending approval (current status: ${contract.status})` });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const approved = await tx.hirePurchaseContract.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          approvedById: admin.id,
          approvedAt: new Date(),
          rejectionReason: null,
        },
        include: {
          customer: {
            select: {
              firstName: true,
              lastName: true,
              membershipId: true,
              phone: true,
              email: true,
            },
          },
          inventoryItem: { include: { product: { select: { name: true } } } },
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
            },
          },
        },
      });

      if (contract.inventoryItem) {
        await tx.inventoryItem.update({
          where: { id: contract.inventoryItem.id },
          data: { status: 'SOLD' },
        });
      }

      return approved;
    });

    await createAuditLog({
      userId: admin.id,
      action: 'APPROVE_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: { status: 'PENDING_APPROVAL' },
      newValues: { status: 'ACTIVE', approvedById: admin.id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    sendContractApprovedNotification({
      recipient: {
        firstName: updated.createdBy.firstName,
        lastName: updated.createdBy.lastName,
        email: updated.createdBy.email,
        phone: updated.createdBy.phone,
      },
      contractNumber: updated.contractNumber,
      customerName: `${updated.customer.firstName} ${updated.customer.lastName}`,
    }).catch((error) => {
      console.error('Failed to send agent approval notification:', error);
    });

    sendContractConfirmation({
      customerFirstName: updated.customer.firstName,
      customerLastName: updated.customer.lastName,
      customerEmail: updated.customer.email || undefined,
      customerPhone: updated.customer.phone,
      contractNumber: updated.contractNumber,
      contractId: updated.id,
      productName: updated.inventoryItem?.product?.name || 'Product',
      totalPrice: updated.totalPrice,
      depositAmount: updated.depositAmount,
      installmentAmount: updated.installmentAmount,
      totalInstallments: updated.totalInstallments,
      paymentFrequency: updated.paymentFrequency,
      startDate: updated.startDate,
      endDate: updated.endDate,
    }).catch((error) => {
      console.error('Failed to send customer contract confirmation after approval:', error);
    });

    // Auto-enroll into Knox Guard now that contract is ACTIVE.
    // If the device was locked before the contract was created, keep it locked until
    // the agent has remitted the deposit amount — the callback will unlock it once paid.
    const deviceWasPreLocked = contract.inventoryItem?.lockStatus === 'LOCKED';
    enrollManagedDeviceForContract(updated.id, {
      desiredState: deviceWasPreLocked ? 'LOCKED' : 'UNLOCKED',
    }).catch((err) => {
      console.error(`Knox Guard auto-enroll failed for contract ${updated.contractNumber}:`, err);
    });

    // Create agent deposit ledger entry
    createAgentDepositLedgerEntry(updated.id).catch((err) => {
      console.error(`Agent deposit ledger creation failed for contract ${updated.contractNumber}:`, err);
    });

    res.json({ message: 'Contract approved successfully', contract: updated });
  } catch (error) {
    console.error('approveContract error:', error);
    res.status(500).json({ error: 'Failed to approve contract' });
  }
}

// POST /contracts/:id/request-revision
// Keep the contract and inventory reservation intact so the agent can fix
// the submission and resubmit it for approval.
export async function requestContractRevision(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const admin = req.user as AdminUserPayload;

    if (!reason || !reason.trim()) {
      res.status(400).json({ error: 'Revision note is required' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        inventoryItem: true,
        customer: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'PENDING_APPROVAL') {
      res.status(400).json({ error: `Contract is not pending approval (current status: ${contract.status})` });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (contract.inventoryItem) {
        await tx.inventoryItem.update({
          where: { id: contract.inventoryItem.id },
          data: { status: 'RESERVED', contractId: contract.id },
        });
      }

      return tx.hirePurchaseContract.update({
        where: { id },
        data: {
          status: 'REVISION_REQUESTED',
          rejectionReason: reason.trim(),
          approvedById: null,
          approvedAt: null,
        },
        include: {
          customer: { select: { firstName: true, lastName: true, membershipId: true } },
          inventoryItem: { include: { product: { select: { name: true } } } },
          createdBy: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: { select: { name: true } } } },
        },
      });
    });

    await createAuditLog({
      userId: admin.id,
      action: 'REQUEST_CONTRACT_REVISION',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: { status: 'PENDING_APPROVAL' },
      newValues: {
        status: 'REVISION_REQUESTED',
        revisionReason: reason.trim(),
        requestedBy: admin.id,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    sendContractRevisionRequestedNotification({
      recipient: {
        firstName: contract.createdBy.firstName,
        lastName: contract.createdBy.lastName,
        email: contract.createdBy.email,
        phone: contract.createdBy.phone,
      },
      contractNumber: contract.contractNumber,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      reason: reason.trim(),
    }).catch((error) => {
      console.error('Failed to send contract revision notification:', error);
    });

    res.json({
      message: 'Revision requested successfully. The contract remains reserved for the agent to update and resubmit.',
      reason: reason.trim(),
      contract: updated,
    });
  } catch (error) {
    console.error('requestContractRevision error:', error);
    res.status(500).json({ error: 'Failed to request revision' });
  }
}

// POST /contracts/agent/mine/:id/resubmit
export async function resubmitAgentContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { id } = req.params;

    const contract = await prisma.hirePurchaseContract.findFirst({
      where: { id, createdById: admin.id },
      include: {
        customer: {
          select: {
            id: true,
          },
        },
        inventoryItem: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found or not accessible' });
      return;
    }

    if (contract.status !== 'REVISION_REQUESTED') {
      res.status(400).json({
        error: `Only contracts with REVISION_REQUESTED status can be resubmitted (current: ${contract.status})`,
      });
      return;
    }

    const guardrails = await evaluateContractSubmissionGuardrails({
      customerId: contract.customer.id,
      inventoryItemId: contract.inventoryItem?.id || '',
      totalPrice: contract.totalPrice,
      depositAmount: contract.depositAmount,
      totalInstallments: contract.totalInstallments,
      startDate: contract.startDate,
      paymentMethod: contract.paymentMethod,
      mobileMoneyNumber: contract.mobileMoneyNumber,
      excludeContractId: contract.id,
    });

    if (guardrails.blockers.length > 0) {
      res.status(400).json({
        error: 'This contract still has submission blockers. Resolve them before resubmitting.',
        guardrails,
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (contract.inventoryItem) {
        await tx.inventoryItem.update({
          where: { id: contract.inventoryItem.id },
          data: { status: 'RESERVED', contractId: contract.id },
        });
      }

      return tx.hirePurchaseContract.update({
        where: { id },
        data: {
          status: 'PENDING_APPROVAL',
          approvedById: null,
          approvedAt: null,
        },
        include: {
          customer: true,
          inventoryItem: {
            include: { product: { include: { category: true } } },
          },
          installments: { orderBy: { installmentNo: 'asc' } },
          payments: { orderBy: { createdAt: 'desc' } },
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              role: { select: { name: true } },
            },
          },
        },
      });
    });

    await createAuditLog({
      userId: admin.id,
      action: 'RESUBMIT_CONTRACT_FOR_APPROVAL',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: { status: 'REVISION_REQUESTED' },
      newValues: {
        status: 'PENDING_APPROVAL',
        resubmittedBy: admin.id,
        priority: guardrails.priority,
        riskFlags: guardrails.riskFlags,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    const snapshots = await buildApprovalSnapshots([updated]);

    res.json({
      message: 'Contract resubmitted for approval successfully',
      contract: {
        ...updated,
        approvalSnapshot: snapshots[id] || null,
      },
    });
  } catch (error) {
    console.error('resubmitAgentContract error:', error);
    res.status(500).json({ error: 'Failed to resubmit contract for approval' });
  }
}

// PATCH /contracts/agent/mine/:id/revision-edit
export async function editRevisionRequestedContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { id } = req.params;
    const {
      totalPrice,
      depositAmount,
      paymentFrequency,
      totalInstallments,
      gracePeriodDays,
      penaltyPercentage,
      startDate,
    } = req.body;

    const contract = await prisma.hirePurchaseContract.findFirst({
      where: { id, createdById: admin.id },
      include: {
        _count: { select: { payments: true } },
        inventoryItem: {
          select: {
            productId: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found or not accessible' });
      return;
    }

    if (contract.status !== 'REVISION_REQUESTED') {
      res.status(400).json({
        error: `Only contracts with REVISION_REQUESTED status can be edited here (current: ${contract.status})`,
      });
      return;
    }

    if (contract._count.payments > 0) {
      res.status(400).json({
        error: 'This contract already has recorded payments. Resolve the payments before editing it for resubmission.',
      });
      return;
    }

    const newTotalPrice = totalPrice !== undefined ? Number(totalPrice) : contract.totalPrice;
    const newDepositAmount = depositAmount !== undefined ? Number(depositAmount) : contract.depositAmount;
    const newFrequency = (paymentFrequency ?? contract.paymentFrequency) as PaymentFrequency;
    const newTotalInstallments = totalInstallments !== undefined ? Number(totalInstallments) : contract.totalInstallments;
    const newGracePeriod = gracePeriodDays !== undefined ? Number(gracePeriodDays) : contract.gracePeriodDays;
    const newPenaltyPct = penaltyPercentage !== undefined ? Number(penaltyPercentage) : contract.penaltyPercentage;
    const newStartDate = startDate ? new Date(startDate) : contract.startDate;

    if (newTotalPrice <= 0) {
      res.status(400).json({ error: 'Total price must be greater than zero' });
      return;
    }

    if (newDepositAmount < 0) {
      res.status(400).json({ error: 'Deposit amount cannot be negative' });
      return;
    }

    if (newDepositAmount >= newTotalPrice) {
      res.status(400).json({ error: 'Deposit must be less than total price' });
      return;
    }

    if (newTotalInstallments < 1) {
      res.status(400).json({ error: 'Total installments must be at least 1' });
      return;
    }

    const newFinanceAmount = newTotalPrice - newDepositAmount;
    const newInstallmentAmount = Math.ceil((newFinanceAmount / newTotalInstallments) * 100) / 100;
    const newEndDate = calculateEndDate(newStartDate, newFrequency, newTotalInstallments);
    const newSchedule = calculateInstallmentSchedule(newFinanceAmount, newFrequency, newTotalInstallments, newStartDate);

    const oldValues = {
      totalPrice: contract.totalPrice,
      depositAmount: contract.depositAmount,
      paymentFrequency: contract.paymentFrequency,
      totalInstallments: contract.totalInstallments,
      gracePeriodDays: contract.gracePeriodDays,
      penaltyPercentage: contract.penaltyPercentage,
      startDate: contract.startDate,
    };

    const updated = await prisma.$transaction(async (tx) => {
      await tx.installmentSchedule.deleteMany({ where: { contractId: id } });
      await tx.installmentSchedule.createMany({
        data: newSchedule.map((schedule) => ({
          contractId: id,
          installmentNo: schedule.installmentNo,
          dueDate: schedule.dueDate,
          amount: schedule.amount,
          paidAmount: 0,
          status: 'PENDING' as const,
        })),
      });

      return tx.hirePurchaseContract.update({
        where: { id },
        data: {
          totalPrice: newTotalPrice,
          depositAmount: newDepositAmount,
          financeAmount: newFinanceAmount,
          installmentAmount: newInstallmentAmount,
          paymentFrequency: newFrequency,
          totalInstallments: newTotalInstallments,
          gracePeriodDays: newGracePeriod,
          penaltyPercentage: newPenaltyPct,
          startDate: newStartDate,
          endDate: newEndDate,
          totalPaid: newDepositAmount,
          outstandingBalance: newFinanceAmount,
        },
        include: {
          customer: true,
          inventoryItem: {
            include: { product: { include: { category: true } } },
          },
          installments: { orderBy: { installmentNo: 'asc' } },
          payments: { orderBy: { createdAt: 'desc' } },
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              role: { select: { name: true } },
            },
          },
        },
      });
    });

    await createAuditLog({
      userId: admin.id,
      action: 'EDIT_REVISION_REQUESTED_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues,
      newValues: {
        totalPrice: newTotalPrice,
        depositAmount: newDepositAmount,
        paymentFrequency: newFrequency,
        totalInstallments: newTotalInstallments,
        gracePeriodDays: newGracePeriod,
        penaltyPercentage: newPenaltyPct,
        startDate: newStartDate,
        editedBy: admin.id,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    const snapshots = await buildApprovalSnapshots([updated]);

    res.json({
      message: 'Contract updated successfully',
      contract: {
        ...updated,
        approvalSnapshot: snapshots[id] || null,
      },
    });
  } catch (error) {
    console.error('editRevisionRequestedContract error:', error);
    res.status(500).json({ error: 'Failed to update contract' });
  }
}

// PATCH /contracts/:id/pending-edit — admin edits a PENDING_APPROVAL contract before approving
export async function editPendingContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const admin = req.user as AdminUserPayload;
    const {
      totalPrice,
      depositAmount,
      paymentFrequency,
      totalInstallments,
      gracePeriodDays,
      penaltyPercentage,
      startDate,
    } = req.body;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        _count: { select: { payments: true } },
        inventoryItem: {
          select: {
            productId: true,
          },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'PENDING_APPROVAL') {
      res.status(400).json({ error: `Only PENDING_APPROVAL contracts can be edited here (current: ${contract.status})` });
      return;
    }

    if (contract._count.payments > 0) {
      res.status(400).json({
        error: 'This contract already has recorded payments. Resolve the payments before editing pending approval terms.',
      });
      return;
    }

    const newTotalPrice = totalPrice !== undefined ? Number(totalPrice) : contract.totalPrice;
    const newDepositAmount = depositAmount !== undefined ? Number(depositAmount) : contract.depositAmount;
    const newFrequency = (paymentFrequency ?? contract.paymentFrequency) as PaymentFrequency;
    const newTotalInstallments = totalInstallments !== undefined ? Number(totalInstallments) : contract.totalInstallments;
    const newGracePeriod = gracePeriodDays !== undefined ? Number(gracePeriodDays) : contract.gracePeriodDays;
    const newPenaltyPct = penaltyPercentage !== undefined ? Number(penaltyPercentage) : contract.penaltyPercentage;
    const newStartDate = startDate ? new Date(startDate) : contract.startDate;

    if (newTotalPrice <= 0) {
      res.status(400).json({ error: 'Total price must be greater than zero' });
      return;
    }

    if (newDepositAmount < 0) {
      res.status(400).json({ error: 'Deposit amount cannot be negative' });
      return;
    }

    if (newDepositAmount >= newTotalPrice) {
      res.status(400).json({ error: 'Deposit must be less than total price' });
      return;
    }

    if (newTotalInstallments < 1) {
      res.status(400).json({ error: 'Total installments must be at least 1' });
      return;
    }

    const newFinanceAmount = newTotalPrice - newDepositAmount;
    const newInstallmentAmount = Math.ceil((newFinanceAmount / newTotalInstallments) * 100) / 100;
    const newEndDate = calculateEndDate(newStartDate, newFrequency, newTotalInstallments);
    const newSchedule = calculateInstallmentSchedule(newFinanceAmount, newFrequency, newTotalInstallments, newStartDate);

    const oldValues = {
      totalPrice: contract.totalPrice,
      depositAmount: contract.depositAmount,
      paymentFrequency: contract.paymentFrequency,
      totalInstallments: contract.totalInstallments,
      gracePeriodDays: contract.gracePeriodDays,
      penaltyPercentage: contract.penaltyPercentage,
      startDate: contract.startDate,
    };

    const updated = await prisma.$transaction(async (tx) => {
      await tx.installmentSchedule.deleteMany({ where: { contractId: id } });
      await tx.installmentSchedule.createMany({
        data: newSchedule.map((schedule) => ({
          contractId: id,
          installmentNo: schedule.installmentNo,
          dueDate: schedule.dueDate,
          amount: schedule.amount,
          paidAmount: 0,
          status: 'PENDING' as const,
        })),
      });

      return tx.hirePurchaseContract.update({
        where: { id },
        data: {
          totalPrice: newTotalPrice,
          depositAmount: newDepositAmount,
          financeAmount: newFinanceAmount,
          installmentAmount: newInstallmentAmount,
          paymentFrequency: newFrequency,
          totalInstallments: newTotalInstallments,
          gracePeriodDays: newGracePeriod,
          penaltyPercentage: newPenaltyPct,
          startDate: newStartDate,
          endDate: newEndDate,
          totalPaid: newDepositAmount,
          outstandingBalance: newFinanceAmount,
        },
        include: {
          customer: { select: { firstName: true, lastName: true, membershipId: true } },
          inventoryItem: {
            include: {
              product: {
                select: {
                  name: true,
                },
              },
            },
          },
          createdBy: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: { select: { name: true } } } },
        },
      });
    });

    await createAuditLog({
      userId: admin.id,
      action: 'EDIT_PENDING_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues,
      newValues: {
        totalPrice: newTotalPrice,
        depositAmount: newDepositAmount,
        paymentFrequency: newFrequency,
        totalInstallments: newTotalInstallments,
        gracePeriodDays: newGracePeriod,
        penaltyPercentage: newPenaltyPct,
        startDate: newStartDate,
        editedBy: admin.id,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    const snapshots = await buildApprovalSnapshots([updated]);

    res.json({
      message: 'Contract updated successfully',
      contract: {
        ...updated,
        approvalSnapshot: snapshots[id] || null,
      },
    });
  } catch (error) {
    console.error('editPendingContract error:', error);
    res.status(500).json({ error: 'Failed to update contract' });
  }
}
