import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { buildApprovalSnapshots } from '../services/contractReviewService';
import {
  resolveContractScope,
  resolveCustomerScope,
  applyCreatorScope,
  scopeAllows,
} from '../services/scopeService';
import { buildCallRows } from '../services/callQueueService';
import { officerAllocations } from '../services/callAllocationService';
import { reviewFilter } from '../services/welcomeCallService';
import { CUSTOMER_SERVICE_ROLE } from '../constants/roles';

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function endOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

// GET /customer-service/verification-queue
// Contracts awaiting approval from this officer's agents, annotated with
// whether the verification call has happened yet.
export async function getVerificationQueue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const search = req.query.search as string | undefined;

    // New customers are called by their agent's welcome-call person.
    const where: Record<string, unknown> = { status: 'PENDING_APPROVAL', ...(await reviewFilter(admin)) };

    if (search) {
      where.OR = [
        { contractNumber: { contains: search, mode: 'insensitive' } },
        { customer: { firstName: { contains: search, mode: 'insensitive' } } },
        { customer: { lastName: { contains: search, mode: 'insensitive' } } },
        { customer: { phone: { contains: search, mode: 'insensitive' } } },
        { customer: { membershipId: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const contracts = await prisma.hirePurchaseContract.findMany({
      where,
      include: {
        customer: {
          select: { id: true, firstName: true, lastName: true, membershipId: true, phone: true },
        },
        inventoryItem: { include: { product: { select: { name: true } } } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        contactAttempts: {
          where: { purpose: 'VERIFICATION' },
          orderBy: { contactedAt: 'desc' },
          take: 1,
          select: { verificationResult: true, outcome: true, contactedAt: true, notes: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const snapshots = await buildApprovalSnapshots(contracts as never);

    const rows = contracts.map((contract, index) => {
      const latest = contract.contactAttempts[0] ?? null;
      return {
        id: contract.id,
        contractNumber: contract.contractNumber,
        totalPrice: contract.totalPrice,
        depositAmount: contract.depositAmount,
        totalInstallments: contract.totalInstallments,
        paymentFrequency: contract.paymentFrequency,
        mobileMoneyNumber: contract.mobileMoneyNumber,
        createdAt: contract.createdAt,
        customer: {
          id: contract.customer.id,
          name: `${contract.customer.firstName} ${contract.customer.lastName}`.trim(),
          phone: contract.customer.phone,
          membershipId: contract.customer.membershipId,
        },
        product: contract.inventoryItem?.product?.name ?? null,
        agent: contract.createdBy
          ? `${contract.createdBy.firstName} ${contract.createdBy.lastName}`.trim()
          : null,
        verification: latest
          ? {
              result: latest.verificationResult,
              outcome: latest.outcome,
              contactedAt: latest.contactedAt,
              notes: latest.notes,
            }
          : null,
        isVerified: latest?.verificationResult === 'VERIFIED',
        approvalSnapshot: (snapshots as Record<string, unknown>)[contract.id] ?? null,
        _index: index,
      };
    });

    // A customer is most reachable shortly after signing, and the contract
    // cannot go live until the call is made — so waiting time is the number
    // that matters here, not queue length.
    const awaiting = rows.filter((row) => !row.isVerified);
    const hoursWaiting = (row: { createdAt: Date }) =>
      (Date.now() - new Date(row.createdAt).getTime()) / 3600000;

    res.json({
      count: rows.length,
      awaitingVerification: awaiting.length,
      readyToApprove: rows.filter((row) => row.isVerified).length,
      overdueForCall: awaiting.filter((row) => hoursWaiting(row) > 6).length,
      oldestWaitingHours: awaiting.length
        ? Math.round(Math.max(...awaiting.map(hoursWaiting)) * 10) / 10
        : 0,
      contracts: rows,
    });
  } catch (error) {
    console.error('getVerificationQueue error:', error);
    res.status(500).json({ error: 'Failed to fetch verification queue' });
  }
}

// GET /customer-service/call-queue
// Scoped clone of getAgentOverdueInstallments — one row per overdue
// installment, worst first, with the last call so the officer can see who
// has already been chased today.
export async function getCsoCallQueue(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;

    // Customer service work from the calls shared to them this morning;
    // everyone else (administrators, leaders) sees the calls in their scope.
    if (admin.role === CUSTOMER_SERVICE_ROLE) {
      const { day, allocations } = await officerAllocations(admin.id);
      const uuids = allocations.map((a) => a.customerUuid);
      const built = uuids.length
        ? await buildCallRows({ customerId_uuid: { in: uuids } }, () => false)
        : [];
      const byUuid = new Map(built.map((r) => [r.customer.uuid, r]));
      // Reminders, and promises from customers not behind, are not on the
      // arrears list: give them a plain row.
      const missing = uuids.filter((u) => !byUuid.has(u));
      const plain = missing.length
        ? await prisma.customer.findMany({ where: { id_uuid: { in: missing } }, select: { id: true, id_uuid: true, firstName: true, lastName: true, phone: true, membershipId: true } })
        : [];
      for (const c of plain) {
        byUuid.set(c.id_uuid, {
          customer: { id: c.id, uuid: c.id_uuid, name: `${c.firstName} ${c.lastName}`.trim(), phone: c.phone, membershipId: c.membershipId },
          agent: null, overdueCount: 0, amountOverdue: 0, daysOverdue: 0, oldestDueDate: null,
          lastPaymentDate: null, lastPaymentAmount: null, lastCallAt: null, lastCallOutcome: null, promiseToPayDate: null,
          isUrgent: false, urgentReason: null, temporaryUnlock: null, contracts: [],
        });
      }
      const rows = allocations
        .map((a) => {
          const row = byUuid.get(a.customerUuid);
          return row ? { ...row, allocation: { kind: a.kind, reason: a.reason, called: a.called } } : null;
        })
        .filter(Boolean) as any[];
      res.json({
        mode: 'SHARED',
        day,
        count: rows.length,
        calledCount: rows.filter((r) => r.allocation.called).length,
        urgentCount: rows.filter((row) => row.isUrgent).length,
        temporaryUnlockCount: rows.filter((row) => row.temporaryUnlock).length,
        overdueInstallmentCount: rows.reduce((sum, row) => sum + row.overdueCount, 0),
        totalOverdueAmount: Math.round(rows.reduce((sum, row) => sum + row.amountOverdue, 0) * 100) / 100,
        customers: rows,
        installments: rows,
      });
      return;
    }

    const scope = await resolveContractScope(admin);
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    applyCreatorScope(where, scope);

    const rows = await buildCallRows(where, (issue) => scopeAllows(scope, issue.createdById));

    res.json({
      count: rows.length,
      urgentCount: rows.filter((row) => row.isUrgent).length,
      temporaryUnlockCount: rows.filter((row) => row.temporaryUnlock).length,
      overdueInstallmentCount: rows.reduce((sum, row) => sum + row.overdueCount, 0),
      totalOverdueAmount: Math.round(rows.reduce((sum, row) => sum + row.amountOverdue, 0) * 100) / 100,
      customers: rows,
      // Retained so an older client keeps working until it is updated.
      installments: rows,
    });
  } catch (error) {
    console.error('getCsoCallQueue error:', error);
    res.status(500).json({ error: 'Failed to fetch call queue' });
  }
}

// GET /customer-service/follow-ups
// Promises to pay and scheduled callbacks that are due.
export async function getDueFollowUps(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const scope = await resolveCustomerScope(admin);
    const endToday = endOfToday();

    const customerWhere: Record<string, unknown> = {};
    applyCreatorScope(customerWhere, scope);

    // Customer service: the follow-ups they arranged, and those of the
    // customers shared to them today — not a portfolio of agents.
    let whose: Record<string, unknown> = Object.keys(customerWhere).length > 0 ? { customer: customerWhere } : {};
    if (admin.role === CUSTOMER_SERVICE_ROLE) {
      const { allocations } = await officerAllocations(admin.id);
      whose = { OR: [{ officerId: admin.id }, { customerId_uuid: { in: allocations.map((a) => a.customerUuid) } }] };
    }

    const attempts = await prisma.contactAttempt.findMany({
      where: {
        AND: [whose],
        OR: [
          { nextFollowUpAt: { lte: endToday } },
          { promiseToPayDate: { lte: endToday } },
        ],
      },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, membershipId: true } },
        contract: { select: { id: true, contractNumber: true, outstandingBalance: true, status: true } },
        officer: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { contactedAt: 'desc' },
      take: 200,
    });

    // One row per customer/contract — the most recent call wins, so a promise
    // already followed up doesn't keep resurfacing.
    const seen = new Set<string>();
    const rows: Record<string, unknown>[] = [];
    for (const attempt of attempts) {
      const key = `${attempt.customerId_uuid}:${attempt.contractId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        id: attempt.id,
        customer: {
          id: attempt.customer.id,
          name: `${attempt.customer.firstName} ${attempt.customer.lastName}`.trim(),
          phone: attempt.customer.phone,
          membershipId: attempt.customer.membershipId,
        },
        contract: attempt.contract,
        purpose: attempt.purpose,
        outcome: attempt.outcome,
        notes: attempt.notes,
        promiseToPayDate: attempt.promiseToPayDate,
        promiseToPayAmount: attempt.promiseToPayAmount,
        nextFollowUpAt: attempt.nextFollowUpAt,
        contactedAt: attempt.contactedAt,
        loggedBy: attempt.officer
          ? `${attempt.officer.firstName} ${attempt.officer.lastName}`.trim()
          : null,
      });
    }

    res.json({ count: rows.length, followUps: rows });
  } catch (error) {
    console.error('getDueFollowUps error:', error);
    res.status(500).json({ error: 'Failed to fetch follow-ups' });
  }
}

// GET /customer-service/dashboard
export async function getCsoDashboard(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const contractScope = await resolveContractScope(admin);
    const customerScope = await resolveCustomerScope(admin);

    const pendingWhere: Record<string, unknown> = { status: 'PENDING_APPROVAL', ...(await reviewFilter(admin)) };

    const activeWhere: Record<string, unknown> = { status: 'ACTIVE' };
    applyCreatorScope(activeWhere, contractScope);

    const customerWhere: Record<string, unknown> = {};
    applyCreatorScope(customerWhere, customerScope);

    const scopedCustomer = Object.keys(customerWhere).length > 0 ? { customer: customerWhere } : {};

    const [
      pendingContracts,
      assignedAgents,
      customerCount,
      overdueContracts,
      callsToday,
      promisesDue,
    ] = await Promise.all([
      prisma.hirePurchaseContract.findMany({
        where: pendingWhere,
        select: {
          id: true,
          createdAt: true,
          contactAttempts: {
            where: { purpose: 'VERIFICATION', verificationResult: 'VERIFIED' },
            select: { id: true },
            take: 1,
          },
        },
      }),
      prisma.csoAgentAssignment.count({ where: { csoId: admin.id } }),
      prisma.customer.count({ where: customerWhere }),
      prisma.hirePurchaseContract.findMany({
        where: { ...activeWhere, installments: { some: { status: 'OVERDUE' } } },
        select: {
          id: true,
          installments: { where: { status: 'OVERDUE' }, select: { amount: true, paidAmount: true } },
        },
      }),
      prisma.contactAttempt.count({
        where: { officerId: admin.id, contactedAt: { gte: startOfToday(), lte: endOfToday() } },
      }),
      prisma.contactAttempt.count({
        where: { ...scopedCustomer, promiseToPayDate: { gte: startOfToday(), lte: endOfToday() } },
      }),
    ]);

    const awaitingCallContracts = pendingContracts.filter((c) => c.contactAttempts.length === 0);
    const verified = pendingContracts.length - awaitingCallContracts.length;
    const hoursWaiting = (c: { createdAt: Date }) =>
      (Date.now() - new Date(c.createdAt).getTime()) / 3600000;
    const overdueAmount = overdueContracts.reduce(
      (sum, contract) =>
        sum + contract.installments.reduce((s, i) => s + (i.amount - i.paidAmount), 0),
      0
    );

    // Customer service work from this morning's shared calls.
    let todaysCalls: { day: string | null; total: number; called: number; byKind: Record<string, number> } | null = null;
    if (admin.role === CUSTOMER_SERVICE_ROLE) {
      const { day, allocations } = await officerAllocations(admin.id);
      const byKind: Record<string, number> = {};
      for (const a of allocations) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
      todaysCalls = { day, total: allocations.length, called: allocations.filter((a) => a.called).length, byKind };
    }

    res.json({
      todaysCalls,
      assignedAgents,
      customers: customerCount,
      verification: {
        pending: pendingContracts.length,
        awaitingCall: awaitingCallContracts.length,
        readyToApprove: verified,
        // Waiting time, not queue length, is what an officer needs to act on.
        overdueForCall: awaitingCallContracts.filter((c) => hoursWaiting(c) > 6).length,
        oldestWaitingHours: awaitingCallContracts.length
          ? Math.round(Math.max(...awaitingCallContracts.map(hoursWaiting)) * 10) / 10
          : 0,
      },
      collections: {
        contractsOverdue: overdueContracts.length,
        totalOverdueAmount: Math.round(overdueAmount * 100) / 100,
      },
      activity: {
        callsLoggedToday: callsToday,
        promisesDueToday: promisesDue,
      },
    });
  } catch (error) {
    console.error('getCsoDashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
}
