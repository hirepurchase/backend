import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { initiateHubtelReceiveMoney, formatPhoneForHubtel } from '../services/hubtelService';
import { generateTransactionRef } from '../utils/helpers';
import { requestManagedDeviceUnlock } from '../services/deviceControlPolicyService';

// Create an AgentDepositLedger entry for a contract that just became ACTIVE.
// Called from contractController (direct ACTIVE) and contractApprovalController (approval flow).
export async function createAgentDepositLedgerEntry(contractId: string): Promise<void> {
  try {
    // Avoid duplicate if already exists
    const existing = await prisma.agentDepositLedger.findUnique({ where: { contractId } });
    if (existing) return;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        customer: { select: { firstName: true, lastName: true } },
      },
    });

    if (!contract) return;

    const commissionSettings = await prisma.commissionSettings.findFirst({
      where: { effectiveDate: { lte: new Date() } },
      orderBy: { effectiveDate: 'desc' },
    });
    const commissionAmount = commissionSettings?.fixedAmount ?? 0;
    const amountDueCompany = Math.max(0, contract.depositAmount - commissionAmount);

    await prisma.agentDepositLedger.create({
      data: {
        contractId: contract.id,
        agentId: contract.createdById,
        contractNumber: contract.contractNumber,
        customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
        depositAmount: contract.depositAmount,
        commissionAmount,
        amountDueCompany,
        outstandingBalance: amountDueCompany,
        status: 'PENDING',
      },
    });
  } catch (error) {
    console.error(`Failed to create agent deposit ledger entry for contract ${contractId}:`, error);
  }
}

// GET /agent-deposits/my-ledger
export async function getMyLedger(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { startDate, endDate, contractNumber, customerName, status, page = '1', limit = '20' } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { agentId: admin.id };
    if (status && status !== 'ALL') where.status = status;
    if (contractNumber) where.contractNumber = { contains: contractNumber, mode: 'insensitive' };
    if (customerName) where.customerName = { contains: customerName, mode: 'insensitive' };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    const [total, entries] = await Promise.all([
      prisma.agentDepositLedger.count({ where }),
      prisma.agentDepositLedger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
        include: {
          payments: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      }),
    ]);

    res.json({
      entries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('getMyLedger error:', error);
    res.status(500).json({ error: 'Failed to fetch ledger' });
  }
}

// GET /agent-deposits/my-summary
export async function getMySummary(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;

    const entries = await prisma.agentDepositLedger.findMany({
      where: { agentId: admin.id },
      select: { depositAmount: true, commissionAmount: true, amountPaid: true, outstandingBalance: true },
    });

    const summary = entries.reduce(
      (acc, e) => ({
        totalDeposits: acc.totalDeposits + e.depositAmount,
        totalCommission: acc.totalCommission + e.commissionAmount,
        totalPaid: acc.totalPaid + e.amountPaid,
        totalOutstanding: acc.totalOutstanding + e.outstandingBalance,
      }),
      { totalDeposits: 0, totalCommission: 0, totalPaid: 0, totalOutstanding: 0 }
    );

    res.json(summary);
  } catch (error) {
    console.error('getMySummary error:', error);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
}

// POST /agent-deposits/:id/pay
export async function payDeposit(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { amount, phoneNumber, network } = req.body;
    const admin = req.user as AdminUserPayload;

    if (!amount || !phoneNumber || !network) {
      res.status(400).json({ error: 'amount, phoneNumber, and network are required' });
      return;
    }

    const validNetworks = ['MTN', 'VODAFONE', 'TELECEL', 'AIRTELTIGO'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network' });
      return;
    }

    const ledgerEntry = await prisma.agentDepositLedger.findUnique({
      where: { id },
    });

    if (!ledgerEntry) {
      res.status(404).json({ error: 'Ledger entry not found' });
      return;
    }

    if (ledgerEntry.agentId !== admin.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (ledgerEntry.status === 'PAID') {
      res.status(400).json({ error: 'This ledger entry is already fully paid' });
      return;
    }

    const payAmount = Number(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    if (payAmount > ledgerEntry.outstandingBalance) {
      res.status(400).json({ error: `Amount exceeds outstanding balance of GHS ${ledgerEntry.outstandingBalance.toFixed(2)}` });
      return;
    }

    // No duplicate pending payments
    const pendingPayment = await prisma.agentDepositPayment.findFirst({
      where: { ledgerEntryId: id, status: 'PENDING' },
    });
    if (pendingPayment) {
      res.status(409).json({ error: 'A payment is already pending for this entry. Please wait for it to complete.' });
      return;
    }

    // Generate unique transaction ref
    let transactionRef = generateTransactionRef();
    while (await prisma.agentDepositPayment.findUnique({ where: { transactionRef } })) {
      transactionRef = generateTransactionRef();
    }

    const formattedPhone = formatPhoneForHubtel(phoneNumber);

    // Create payment record
    const payment = await prisma.agentDepositPayment.create({
      data: {
        ledgerEntryId: id,
        agentId: admin.id,
        transactionRef,
        amount: payAmount,
        phoneNumber: formattedPhone,
        network: network.toUpperCase(),
        status: 'PENDING',
      },
    });

    // Fetch agent name for Hubtel description
    const agentUser = await prisma.adminUser.findUnique({
      where: { id: admin.id },
      select: { firstName: true, lastName: true },
    });
    const agentName = agentUser ? `${agentUser.firstName} ${agentUser.lastName}` : 'Agent';

    let hubtelResponse: { transactionId: string };
    try {
      hubtelResponse = await initiateHubtelReceiveMoney({
        amount: payAmount,
        customerName: agentName,
        customerPhone: formattedPhone,
        network: network.toUpperCase(),
        description: `Agent deposit remittance - Contract ${ledgerEntry.contractNumber}`,
        transactionRef,
      });
    } catch (hubtelError: any) {
      await prisma.agentDepositPayment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: hubtelError.message || 'Hubtel initiation failed' },
      });
      throw hubtelError;
    }

    await prisma.agentDepositPayment.update({
      where: { id: payment.id },
      data: { hubtelRef: hubtelResponse.transactionId },
    });

    res.status(200).json({
      message: 'Payment initiated. You will receive a prompt on your phone.',
      transactionRef,
      transactionId: hubtelResponse.transactionId,
      amount: payAmount,
      status: 'PENDING',
    });
  } catch (error: any) {
    console.error('payDeposit error:', error);
    res.status(500).json({ error: error.message || 'Failed to initiate payment' });
  }
}

// POST /agent-deposits/hubtel/callback  (no auth — called by Hubtel)
export async function handleAgentPaymentCallback(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const body = req.body;
    const transactionRef = body?.Data?.ClientReference || body?.ClientReference;
    const responseCode = body?.Data?.ResponseCode || body?.ResponseCode;
    const externalRef = body?.Data?.TransactionId || body?.TransactionId;

    if (!transactionRef) {
      res.status(400).json({ error: 'Missing transaction reference' });
      return;
    }

    const payment = await prisma.agentDepositPayment.findUnique({
      where: { transactionRef },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (payment.status !== 'PENDING') {
      res.json({ message: 'Already processed' });
      return;
    }

    const isSuccess = responseCode === '0000';

    await prisma.$transaction(async (tx) => {
      await tx.agentDepositPayment.update({
        where: { id: payment.id },
        data: {
          status: isSuccess ? 'SUCCESS' : 'FAILED',
          hubtelRef: externalRef || payment.hubtelRef,
          paidAt: isSuccess ? new Date() : null,
          failureReason: isSuccess ? null : (body?.Data?.ResponseMessage || body?.ResponseMessage || 'Payment failed'),
        },
      });

      if (isSuccess) {
        const ledger = await tx.agentDepositLedger.findUnique({ where: { id: payment.ledgerEntryId } });
        if (ledger) {
          const newAmountPaid = ledger.amountPaid + payment.amount;
          const newOutstanding = Math.max(0, ledger.amountDueCompany - newAmountPaid);
          const newStatus = newOutstanding <= 0 ? 'PAID' : 'PENDING';
          await tx.agentDepositLedger.update({
            where: { id: ledger.id },
            data: {
              amountPaid: newAmountPaid,
              outstandingBalance: newOutstanding,
              status: newStatus,
            },
          });

          if (newStatus === 'PAID') {
            // Check if the contract's device was kept locked pending deposit remittance
            const contract = await prisma.hirePurchaseContract.findUnique({
              where: { id: ledger.contractId },
              include: {
                managedDevice: { select: { id: true, desiredState: true } },
                inventoryItem: { select: { lockStatus: true } },
              },
            });
            const deviceIsKeptLocked =
              contract?.managedDevice?.desiredState === 'LOCKED' &&
              contract?.inventoryItem?.lockStatus === 'LOCKED';
            if (deviceIsKeptLocked && contract?.id) {
              // Non-blocking — unlock after the transaction commits
              setImmediate(() => {
                requestManagedDeviceUnlock(contract.id, 'Agent deposit fully remitted — device unlocked.').catch((err) => {
                  console.error(`[AgentDeposit] Failed to unlock device after deposit paid for contract ${contract.id}:`, err);
                });
              });
            }
          }
        }
      }
    });

    res.json({ message: 'Callback processed' });
  } catch (error) {
    console.error('handleAgentPaymentCallback error:', error);
    res.status(500).json({ error: 'Callback processing failed' });
  }
}

// POST /agent-deposits/:id/admin-pay  — admin records a cash/manual deposit payment
export async function adminManualPay(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { amount, note } = req.body;
    const admin = req.user as AdminUserPayload;

    if (!amount) {
      res.status(400).json({ error: 'amount is required' });
      return;
    }

    const payAmount = Number(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
      res.status(400).json({ error: 'Invalid amount' });
      return;
    }

    const ledgerEntry = await prisma.agentDepositLedger.findUnique({ where: { id } });

    if (!ledgerEntry) {
      res.status(404).json({ error: 'Ledger entry not found' });
      return;
    }

    if (ledgerEntry.status === 'PAID') {
      res.status(400).json({ error: 'This ledger entry is already fully paid' });
      return;
    }

    if (ledgerEntry.status === 'CANCELLED') {
      res.status(400).json({ error: 'Cannot record payment against a cancelled ledger entry' });
      return;
    }

    if (payAmount > ledgerEntry.outstandingBalance) {
      res.status(400).json({ error: `Amount exceeds outstanding balance of GHS ${ledgerEntry.outstandingBalance.toFixed(2)}` });
      return;
    }

    const transactionRef = `MANUAL-${generateTransactionRef()}`;

    let contractId: string | null = null;

    await prisma.$transaction(async (tx) => {
      await tx.agentDepositPayment.create({
        data: {
          ledgerEntryId: id,
          agentId: ledgerEntry.agentId,
          transactionRef,
          amount: payAmount,
          phoneNumber: 'CASH',
          network: 'MANUAL',
          status: 'SUCCESS',
          failureReason: null,
          paidAt: new Date(),
          hubtelRef: note ? `NOTE:${note}` : null,
        },
      });

      const newAmountPaid = ledgerEntry.amountPaid + payAmount;
      const newOutstanding = Math.max(0, ledgerEntry.amountDueCompany - newAmountPaid);
      const newStatus = newOutstanding <= 0 ? 'PAID' : 'PENDING';

      await tx.agentDepositLedger.update({
        where: { id },
        data: {
          amountPaid: newAmountPaid,
          outstandingBalance: newOutstanding,
          status: newStatus,
        },
      });

      if (newStatus === 'PAID') {
        contractId = ledgerEntry.contractId;
      }
    });

    // If fully paid, trigger device unlock if applicable (non-blocking)
    if (contractId) {
      const contract = await prisma.hirePurchaseContract.findUnique({
        where: { id: contractId },
        include: {
          managedDevice: { select: { id: true, desiredState: true } },
          inventoryItem: { select: { lockStatus: true } },
        },
      });
      const deviceIsKeptLocked =
        contract?.managedDevice?.desiredState === 'LOCKED' &&
        contract?.inventoryItem?.lockStatus === 'LOCKED';
      if (deviceIsKeptLocked && contract?.id) {
        setImmediate(() => {
          requestManagedDeviceUnlock(contract.id, 'Agent deposit fully remitted (manual) — device unlocked.').catch((err) => {
            console.error(`[AdminManualPay] Failed to unlock device for contract ${contract.id}:`, err);
          });
        });
      }
    }

    res.json({
      message: 'Manual payment recorded successfully',
      transactionRef,
      amount: payAmount,
    });
  } catch (error) {
    console.error('adminManualPay error:', error);
    res.status(500).json({ error: 'Failed to record manual payment' });
  }
}

// GET /agent-deposits/admin/all-ledgers
export async function getAllAgentLedgers(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { agentId, status, startDate, endDate, page = '1', limit = '20' } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (agentId) where.agentId = agentId;
    if (status && status !== 'ALL') where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    const [total, entries] = await Promise.all([
      prisma.agentDepositLedger.count({ where }),
      prisma.agentDepositLedger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
        include: {
          agent: { select: { id: true, firstName: true, lastName: true, email: true } },
          payments: { orderBy: { createdAt: 'desc' }, take: 3 },
        },
      }),
    ]);

    res.json({
      entries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('getAllAgentLedgers error:', error);
    res.status(500).json({ error: 'Failed to fetch agent ledgers' });
  }
}

// GET /agent-deposits/admin/summary
export async function getAdminSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { agentId } = req.query as Record<string, string>;

    const where: any = {};
    if (agentId) where.agentId = agentId;

    const entries = await prisma.agentDepositLedger.findMany({
      where,
      select: { depositAmount: true, commissionAmount: true, amountPaid: true, outstandingBalance: true },
    });

    const summary = entries.reduce(
      (acc, e) => ({
        totalDeposits: acc.totalDeposits + e.depositAmount,
        totalCommission: acc.totalCommission + e.commissionAmount,
        totalPaid: acc.totalPaid + e.amountPaid,
        totalOutstanding: acc.totalOutstanding + e.outstandingBalance,
      }),
      { totalDeposits: 0, totalCommission: 0, totalPaid: 0, totalOutstanding: 0 }
    );

    // Get list of agents for filter
    const agents = await prisma.adminUser.findMany({
      where: { role: { name: 'AGENT' } },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { firstName: 'asc' },
    });

    res.json({ summary, agents });
  } catch (error) {
    console.error('getAdminSummary error:', error);
    res.status(500).json({ error: 'Failed to fetch admin summary' });
  }
}
