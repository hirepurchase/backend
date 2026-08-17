import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { buildApprovalSnapshots } from '../services/contractReviewService';
import {
  resolveContractScope,
  resolveCustomerScope,
  applyCreatorScope,
} from '../services/scopeService';

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

    const where: Record<string, unknown> = { status: 'PENDING_APPROVAL' };
    applyCreatorScope(where, await resolveContractScope(admin));

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

    res.json({
      count: rows.length,
      awaitingVerification: rows.filter((row) => !row.isVerified).length,
      readyToApprove: rows.filter((row) => row.isVerified).length,
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
    const now = new Date();

    const where: Record<string, unknown> = { status: 'ACTIVE' };
    applyCreatorScope(where, await resolveContractScope(admin));

    const contracts = await prisma.hirePurchaseContract.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, membershipId: true, phone: true } },
        inventoryItem: { include: { product: { select: { name: true } } } },
        createdBy: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        installments: { where: { status: 'OVERDUE' }, orderBy: { dueDate: 'asc' } },
        payments: {
          where: { status: 'SUCCESS' },
          orderBy: { paymentDate: 'desc' },
          take: 1,
          select: { paymentDate: true, amount: true },
        },
        contactAttempts: {
          where: { purpose: { in: ['COLLECTION', 'FOLLOW_UP'] } },
          orderBy: { contactedAt: 'desc' },
          take: 1,
          select: { contactedAt: true, outcome: true, promiseToPayDate: true },
        },
      },
    });

    // One row per customer, not per overdue installment. A customer 5 payments
    // behind is still one phone call; listing them 5 times made the queue look
    // 4x longer than the work in it.
    const byCustomer = new Map<string, any>();

    for (const contract of contracts) {
      if (contract.installments.length === 0) continue;

      const key = contract.customer.id;
      let row = byCustomer.get(key);

      if (!row) {
        row = {
          customer: {
            id: contract.customer.id,
            name: `${contract.customer.firstName} ${contract.customer.lastName}`.trim(),
            phone: contract.customer.phone,
            membershipId: contract.customer.membershipId,
          },
          agent: contract.createdBy
            ? {
                id: contract.createdBy.id,
                name: `${contract.createdBy.firstName} ${contract.createdBy.lastName}`.trim(),
                phone: contract.createdBy.phone,
                email: contract.createdBy.email,
              }
            : null,
          overdueCount: 0,
          amountOverdue: 0,
          daysOverdue: 0,
          oldestDueDate: null as Date | null,
          lastPaymentDate: null as Date | null,
          lastPaymentAmount: null as number | null,
          lastCallAt: null as Date | null,
          lastCallOutcome: null as string | null,
          promiseToPayDate: null as Date | null,
          contracts: [] as any[],
        };
        byCustomer.set(key, row);
      }

      const contractOverdue = contract.installments.reduce(
        (sum, i) => sum + (i.amount - i.paidAmount),
        0
      );
      const oldest = contract.installments[0];
      const daysOverdue = Math.max(
        0,
        Math.floor((now.getTime() - new Date(oldest.dueDate).getTime()) / 86400000)
      );

      row.overdueCount += contract.installments.length;
      row.amountOverdue = Math.round((row.amountOverdue + contractOverdue) * 100) / 100;
      row.daysOverdue = Math.max(row.daysOverdue, daysOverdue);
      if (!row.oldestDueDate || new Date(oldest.dueDate) < new Date(row.oldestDueDate)) {
        row.oldestDueDate = oldest.dueDate;
      }

      // Most recent across all of the customer's contracts.
      const lastPayment = contract.payments[0] ?? null;
      if (lastPayment?.paymentDate && (!row.lastPaymentDate || lastPayment.paymentDate > row.lastPaymentDate)) {
        row.lastPaymentDate = lastPayment.paymentDate;
        row.lastPaymentAmount = lastPayment.amount;
      }
      const lastCall = contract.contactAttempts[0] ?? null;
      if (lastCall?.contactedAt && (!row.lastCallAt || lastCall.contactedAt > row.lastCallAt)) {
        row.lastCallAt = lastCall.contactedAt;
        row.lastCallOutcome = lastCall.outcome;
        row.promiseToPayDate = lastCall.promiseToPayDate;
      }

      row.contracts.push({
        contractId: contract.id,
        contractNumber: contract.contractNumber,
        product: contract.inventoryItem?.product?.name ?? null,
        overdueCount: contract.installments.length,
        amountOverdue: Math.round(contractOverdue * 100) / 100,
        daysOverdue,
        installments: contract.installments.map((i) => ({
          installmentId: i.id,
          installmentNo: i.installmentNo,
          dueDate: i.dueDate,
          amountOverdue: Math.round((i.amount - i.paidAmount) * 100) / 100,
        })),
      });
    }

    const rows = Array.from(byCustomer.values()).sort((a, b) => b.daysOverdue - a.daysOverdue);

    res.json({
      count: rows.length,
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

    const attempts = await prisma.contactAttempt.findMany({
      where: {
        ...(Object.keys(customerWhere).length > 0 ? { customer: customerWhere } : {}),
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

    const pendingWhere: Record<string, unknown> = { status: 'PENDING_APPROVAL' };
    applyCreatorScope(pendingWhere, contractScope);

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

    const verified = pendingContracts.filter((c) => c.contactAttempts.length > 0).length;
    const overdueAmount = overdueContracts.reduce(
      (sum, contract) =>
        sum + contract.installments.reduce((s, i) => s + (i.amount - i.paidAmount), 0),
      0
    );

    res.json({
      assignedAgents,
      customers: customerCount,
      verification: {
        pending: pendingContracts.length,
        awaitingCall: pendingContracts.length - verified,
        readyToApprove: verified,
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
