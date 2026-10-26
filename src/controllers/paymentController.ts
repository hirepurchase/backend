import { Request, Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { initiatePayment, checkPaymentStatus, validateProvider, getProviderFromPhone } from '../services/mobileMoneyService';
import {
  initiateHubtelReceiveMoney,
  initiateDirectDebitCharge,
  initiatePreapproval,
  verifyPreapprovalOTP,
  checkPreapprovalStatus,
  checkHubtelPaymentStatus,
  processHubtelCallback,
  processPreapprovalCallback,
  formatPhoneForHubtel,
} from '../services/hubtelService';
import { AdminUserPayload, AuthenticatedRequest, WebhookPayload } from '../types';
import { validateWebhookRequest } from '../utils/callbackSecurity';
import { generateTransactionRef, sanitizePhoneNumber, validatePhoneNumber, roundMoney, isMoneyGte } from '../utils/helpers';
import { allocatePaymentAcrossContract } from '../services/paymentAllocationService';
import { rebuildPenaltyAllocation, OWED_PENALTY_WHERE } from '../services/penaltyService';

/**
 * The most a customer can pay on a contract: the remaining price plus any
 * unpaid late charges.
 *
 * Capping at outstandingBalance alone rejected a payment from a customer whose
 * installments were settled but whose charges were not — the exact state that
 * keeps a contract open and a device locked. They could neither clear it nor
 * be told why.
 */
function payableCeiling(contract: { outstandingBalance: number; penaltyOutstanding?: number | null }): number {
  return roundMoney(contract.outstandingBalance + (contract.penaltyOutstanding ?? 0));
}
import { hasPermission, PERMISSIONS } from '../constants/permissions';
import { safelyEvaluateManagedDeviceForContract } from '../services/deviceControlPolicyService';
import { settleTemporaryUnlockOnPayment } from '../services/temporaryUnlockService';
import { notifyPayTrigger } from '../services/payTrigger/events';

/**
 * What Hubtel's transaction status service says happened to a payment, from
 * the transaction's own status ("Paid", "Unpaid", "Refunded", ...). Null while
 * it is undecided. Never from the top-level responseCode, which only reports
 * whether the lookup itself worked.
 */
export function hubtelTransactionOutcome(rawStatus: string): 'SUCCESS' | 'FAILED' | null {
  const status = String(rawStatus || '').trim().toUpperCase();
  if (['PAID', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED'].includes(status)) return 'SUCCESS';
  if (['FAILED', 'FAIL', 'REJECTED', 'DECLINED', 'CANCELLED', 'EXPIRED'].includes(status)) return 'FAILED';
  return null;
}

function ensureContractCanAcceptPayments(status: string, res: Response): boolean {
  if (status === 'ACTIVE') {
    return true;
  }

  if (status === 'PENDING_APPROVAL') {
    res.status(400).json({ error: 'Contract is awaiting approval and cannot receive payments yet.' });
    return false;
  }

  if (status === 'REVISION_REQUESTED') {
    res.status(400).json({ error: 'Contract has been sent back for revision and cannot receive payments yet.' });
    return false;
  }

  res.status(400).json({ error: `Contract is not active. Current status: ${status}.` });
  return false;
}

// Initiate payment (Customer)
export async function initiateCustomerPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerUuid = req.user!.id;
    const { contractId, amount, phoneNumber, provider } = req.body;

    // Validate required fields
    if (!contractId || !amount || !phoneNumber) {
      res.status(400).json({ error: 'Contract ID, amount, and phone number are required' });
      return;
    }

    // Validate phone number
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
    if (!validatePhoneNumber(sanitizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number' });
      return;
    }

    // Determine provider from phone if not provided
    const paymentProvider = provider?.toUpperCase() || getProviderFromPhone(sanitizedPhone);
    if (!paymentProvider || !validateProvider(paymentProvider)) {
      res.status(400).json({ error: 'Unable to determine mobile money provider. Please specify provider.' });
      return;
    }

    // Validate contract belongs to customer and is active
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        customer: true,
        installments: {
          where: {
            status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
          },
          orderBy: { installmentNo: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (!contract.customer?.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    if (contract.customerId_uuid !== customerUuid) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (!ensureContractCanAcceptPayments(contract.status, res)) {
      return;
    }

    // Validate amount
    const paymentAmount = roundMoney(Number(amount));
    if (paymentAmount <= 0) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    if (!isMoneyGte(payableCeiling(contract), paymentAmount)) {
      res.status(400).json({ error: 'Payment amount exceeds the total due on this contract' });
      return;
    }

    // Generate transaction reference
    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

    // Create payment record
    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef,
        contractId,
        customerId_uuid: contract.customerId_uuid,
        amount: paymentAmount,
        paymentMethod: 'MOBILE_MONEY',
        mobileMoneyProvider: paymentProvider,
        mobileMoneyNumber: sanitizedPhone,
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
        }),
      },
    });

    // Initiate mobile money payment
    const momoResponse = await initiatePayment({
      amount: paymentAmount,
      phoneNumber: sanitizedPhone,
      provider: paymentProvider as 'MTN' | 'VODAFONE' | 'AIRTELTIGO',
      contractId,
      customerId: customerUuid,
      reference: transactionRef,
    });

    if (!momoResponse.success) {
      // Update payment as failed
      await prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          metadata: JSON.stringify({
            initiatedAt: new Date().toISOString(),
            error: momoResponse.message,
          }),
        },
      });

      res.status(400).json({ error: momoResponse.message });
      return;
    }

    // Update payment with external reference
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: momoResponse.externalRef,
      },
    });

    await createAuditLog({
      action: 'INITIATE_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        transactionRef,
        amount: paymentAmount,
        provider: paymentProvider,
        contractId,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: momoResponse.message,
      transactionRef,
      status: 'PENDING',
    });
  } catch (error) {
    console.error('Initiate payment error:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
}

// Check payment status
export async function getPaymentStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { transactionRef } = req.params;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef },
      include: {
        contract: {
          select: {
            id: true,
            contractNumber: true,
            outstandingBalance: true,
          },
        },
      },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Check ownership for customers
    if (req.userType === 'customer' && payment.customerId_uuid !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // If still pending, check with provider
    if (payment.status === 'PENDING') {
      const statusCheck = await checkPaymentStatus(transactionRef);

      if (statusCheck.status !== 'PENDING') {
        // Update payment status
        await prisma.paymentTransaction.update({
          where: { id: payment.id },
          data: {
            status: statusCheck.status,
            paymentDate: statusCheck.status === 'SUCCESS' ? new Date() : null,
          },
        });

        // If successful, process the payment
        if (statusCheck.status === 'SUCCESS') {
          await processSuccessfulPayment(payment.id);
        }

        payment.status = statusCheck.status;
      }
    }

    res.json({
      transactionRef: payment.transactionRef,
      amount: payment.amount,
      status: payment.status,
      provider: payment.mobileMoneyProvider,
      paymentDate: payment.paymentDate,
      contract: payment.contract,
    });
  } catch (error) {
    console.error('Get payment status error:', error);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
}

// Mobile Money webhook handler
export async function handlePaymentWebhook(req: Request, res: Response): Promise<void> {
  try {
    const webhookError = validateWebhookRequest(req);
    if (webhookError) {
      res.status(401).json({ error: webhookError });
      return;
    }

    const payload: WebhookPayload = req.body;
    if (!payload?.transactionRef || !payload?.status || !['SUCCESS', 'FAILED'].includes(payload.status)) {
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }

    // Validate webhook signature (implementation depends on provider)
    // const isValid = validateWebhookSignature(req);
    // if (!isValid) {
    //   res.status(401).json({ error: 'Invalid signature' });
    //   return;
    // }

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef: payload.transactionRef },
    });

    if (!payment) {
      console.error('Payment not found for webhook:', payload.transactionRef);
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (typeof payload.amount !== 'number' || payload.amount <= 0) {
      res.status(400).json({ error: 'Invalid webhook amount' });
      return;
    }

    if (Math.abs(payment.amount - payload.amount) > 0.01) {
      res.status(400).json({ error: 'Webhook amount mismatch' });
      return;
    }

    if (payment.status === 'SUCCESS' || payment.status === payload.status) {
      res.json({ received: true, duplicate: true });
      return;
    }

    const metadata = (() => {
      try {
        return JSON.parse(payment.metadata || '{}');
      } catch {
        return {};
      }
    })();

    const updatedPayment = await prisma.paymentTransaction.updateMany({
      where: {
        id: payment.id,
        status: {
          not: 'SUCCESS',
        },
      },
      data: {
        status: payload.status,
        externalRef: payload.externalRef || payment.externalRef,
        paymentDate: payload.status === 'SUCCESS' ? new Date() : null,
        metadata: JSON.stringify({
          ...metadata,
          webhookReceived: new Date().toISOString(),
          webhookPayload: payload,
        }),
      },
    });

    if (updatedPayment.count === 0) {
      res.json({ received: true, duplicate: true });
      return;
    }

    // Process successful payment
    if (payload.status === 'SUCCESS') {
      await processSuccessfulPayment(payment.id);
    }

    await createAuditLog({
      action: 'PAYMENT_WEBHOOK',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        status: payload.status,
        externalRef: payload.externalRef,
      },
    });

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// Process successful payment
// Exported so the allocation order can be tested against a real contract
// rather than a reimplementation of it — the order is what strands customers
// behind a lock screen when it is wrong.
export async function processSuccessfulPaymentForTest(paymentId: string): Promise<void> {
  return processSuccessfulPayment(paymentId);
}

async function processSuccessfulPayment(paymentId: string): Promise<void> {
  const payment = await prisma.paymentTransaction.findUnique({
    where: { id: paymentId },
    include: {
      contract: {
        include: {
          installments: {
            where: {
              status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
            },
            orderBy: { installmentNo: 'asc' },
          },
          penalties: {
            where: OWED_PENALTY_WHERE,
          },
        },
      },
    },
  });

  if (!payment || !payment.contract) return;

  let remainingAmount = roundMoney(payment.amount);
  const contract = payment.contract;

  await prisma.$transaction(async (tx) => {
    const allocation = await allocatePaymentAcrossContract({
      contractId: contract.id,
      installments: contract.installments,
      amount: remainingAmount,
      tx,
    });
    remainingAmount = allocation.remaining;

    // Update contract totals
    // CORRECTED LOGIC: totalPaid = deposit + sum of all successful payments
    const allSuccessfulPayments = await tx.paymentTransaction.findMany({
      where: {
        contractId: contract.id,
        status: 'SUCCESS',
      },
    });

    const paymentsSum = allSuccessfulPayments.reduce((sum, p) => sum + p.amount, 0);
    const newTotalPaid = roundMoney(contract.depositAmount + paymentsSum);
    const newOutstandingBalance = roundMoney(contract.totalPrice - newTotalPaid);

    const contractUpdate: Record<string, unknown> = {
      totalPaid: newTotalPaid,
      outstandingBalance: Math.max(0, newOutstandingBalance),
    };

    // Penalties are part of what the customer owes, but they are not part of
    // totalPrice, so a contract could reach a zero balance and complete with
    // them still unpaid — releasing the device and transferring ownership,
    // which is the only leverage to collect them. Read after allocation, which
    // may have just cleared them.
    const penaltyOutstanding = (await tx.hirePurchaseContract.findUnique({
      where: { id: contract.id },
      select: { penaltyOutstanding: true },
    }))?.penaltyOutstanding ?? 0;

    // Check if fully paid (within half a cent, to absorb rounding drift)
    if (newOutstandingBalance <= 0.005 && penaltyOutstanding <= 0.005) {
      contractUpdate.status = 'COMPLETED';
      contractUpdate.outstandingBalance = 0;
      // Keep the original completion date if it was already completed
      contractUpdate.completedAt = contract.completedAt ?? new Date();
    }

    await tx.hirePurchaseContract.update({
      where: { id: contract.id },
      data: contractUpdate,
    });
  });

  // Close any unlock window or agent bar this payment has just settled,
  // before the device is judged — otherwise both wait for tomorrow's cron.
  await settleTemporaryUnlockOnPayment(contract.id);
  await safelyEvaluateManagedDeviceForContract(contract.id);
  notifyPayTrigger(contract.id, 'PAYMENT');
}

// Get payment history for contract
export async function getContractPayments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (req.userType === 'admin') {
      const adminUser = req.user as AdminUserPayload;
      const canViewAll = hasPermission(adminUser.permissions, PERMISSIONS.VIEW_CONTRACTS);
      const canViewOwn = hasPermission(adminUser.permissions, PERMISSIONS.VIEW_OWN_CONTRACTS);

      if (!canViewAll && (!canViewOwn || contract.createdById !== adminUser.id)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    // Check ownership for customers
    if (req.userType === 'customer' && contract.customerId_uuid !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const payments = await prisma.paymentTransaction.findMany({
      where: { contractId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(payments);
  } catch (error) {
    console.error('Get contract payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
}

// Admin: Record manual payment
export async function recordManualPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, amount, paymentMethod, reference, notes } = req.body;

    if (!contractId || !amount) {
      res.status(400).json({ error: 'Contract ID and amount are required' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (!contract.customerId_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    if (!ensureContractCanAcceptPayments(contract.status, res)) {
      return;
    }

    const customer = await prisma.customer.findUnique({
      where: { id_uuid: contract.customerId_uuid },
      select: { id_uuid: true },
    });
    if (!customer?.id_uuid) {
      res.status(500).json({ error: 'Customer not found for contract. Please contact support.' });
      return;
    }

    const paymentAmount = roundMoney(Number(amount));
    if (!isMoneyGte(payableCeiling(contract), paymentAmount)) {
      res.status(400).json({ error: 'Payment amount exceeds the total due on this contract' });
      return;
    }

    // Generate transaction reference
    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef,
        contractId,
        customerId_uuid: customer.id_uuid,
        amount: paymentAmount,
        paymentMethod: paymentMethod || 'CASH',
        externalRef: reference,
        status: 'SUCCESS',
        paymentDate: new Date(),
        metadata: JSON.stringify({
          recordedBy: req.user!.id,
          notes,
          isManual: true,
        }),
      },
    });

    // Process the payment
    await processSuccessfulPayment(payment.id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'RECORD_MANUAL_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        transactionRef,
        amount: paymentAmount,
        contractId,
        paymentMethod,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json({
      message: 'Payment recorded successfully',
      transactionRef,
      amount: paymentAmount,
    });
  } catch (error) {
    console.error('Record manual payment error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  }
}

// Update a manual payment entry (Admin only)
export async function updateManualPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { amount, paymentMethod, reference, notes } = req.body;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { id },
      include: { contract: true },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Only allow editing manually recorded payments
    const metadata = JSON.parse(payment.metadata || '{}');
    if (!metadata.isManual) {
      res.status(403).json({ error: 'Only manually recorded payments can be edited' });
      return;
    }

    const oldAmount = payment.amount;
    const newAmount = amount !== undefined ? Number(amount) : oldAmount;
    const amountDiff = newAmount - oldAmount;

    await prisma.$transaction(async (tx) => {
      // Update the payment record
      await tx.paymentTransaction.update({
        where: { id },
        data: {
          amount: newAmount,
          paymentMethod: paymentMethod || payment.paymentMethod,
          externalRef: reference !== undefined ? reference : payment.externalRef,
          metadata: JSON.stringify({
            ...metadata,
            notes: notes !== undefined ? notes : metadata.notes,
            lastEditedBy: req.user!.id,
            lastEditedAt: new Date().toISOString(),
          }),
        },
      });

      if (amountDiff !== 0) {
        // Recalculate contract totals from all successful payments
        const allPayments = await tx.paymentTransaction.findMany({
          where: { contractId: payment.contractId, status: 'SUCCESS' },
        });
        const paymentsSum = allPayments.reduce((sum, p) => sum + p.amount, 0);
        const contract = payment.contract;
        const newTotalPaid = roundMoney(contract.depositAmount + paymentsSum);
        const newOutstandingBalance = roundMoney(contract.totalPrice - newTotalPaid);
        const penaltyDue = (await tx.hirePurchaseContract.findUnique({
          where: { id: payment.contractId },
          select: { penaltyOutstanding: true },
        }))?.penaltyOutstanding ?? 0;
        const isFullyPaid = newOutstandingBalance <= 0.005 && penaltyDue <= 0.005;

        await tx.hirePurchaseContract.update({
          where: { id: payment.contractId },
          data: {
            totalPaid: newTotalPaid,
            outstandingBalance: Math.max(0, isFullyPaid ? 0 : newOutstandingBalance),
            status: isFullyPaid ? 'COMPLETED' : 'ACTIVE',
            // Cleared again by an edit that drops it below the total, so the
            // month's completion count stays honest.
            completedAt: isFullyPaid ? (payment.contract.completedAt ?? new Date()) : null,
          },
        });

        // Reprocess installments from scratch using remaining amount
        // Reset affected installments then re-apply all payments in order
        const installments = await tx.installmentSchedule.findMany({
          where: { contractId: payment.contractId },
          orderBy: { installmentNo: 'asc' },
        });

        // Reset all non-paid installments to recalculate
        for (const inst of installments) {
          if (inst.status !== 'PAID' || inst.paidAmount < inst.amount) {
            await tx.installmentSchedule.update({
              where: { id: inst.id },
              data: { paidAmount: 0, status: 'PENDING', paidAt: null },
            });
          }
        }

        // Re-apply total payments sum across installments
        let remaining = roundMoney(paymentsSum);
        for (const inst of installments) {
          if (remaining <= 0) break;
          const owed = inst.amount;
          if (isMoneyGte(remaining, owed)) {
            await tx.installmentSchedule.update({
              where: { id: inst.id },
              data: { paidAmount: owed, status: 'PAID', paidAt: new Date() },
            });
            remaining = roundMoney(remaining - owed);
          } else {
            await tx.installmentSchedule.update({
              where: { id: inst.id },
              data: { paidAmount: remaining, status: 'PARTIAL', paidAt: null },
            });
            remaining = 0;
          }
        }

        // Penalties are credited from whatever survives the installments, so a
        // reduced payment has to give them back too.
        const penaltyNowDue = await rebuildPenaltyAllocation(payment.contractId, remaining, tx);

        // The completion decision above was taken before penalties were
        // rebuilt; a revived penalty must be able to reopen the contract.
        if (isFullyPaid && penaltyNowDue > 0.005) {
          await tx.hirePurchaseContract.update({
            where: { id: payment.contractId },
            data: { status: 'ACTIVE', completedAt: null },
          });
        }
      }
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_MANUAL_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: id,
      oldValues: { amount: oldAmount },
      newValues: { amount: newAmount, paymentMethod, reference, notes },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Editing an amount can clear the last of a balance, or reopen one that was
    // settled — either way the device state must be re-evaluated.
    // Close any unlock window or agent bar this payment has just settled,
    // before the device is judged — otherwise both wait for tomorrow's cron.
    await settleTemporaryUnlockOnPayment(payment.contractId);
    await safelyEvaluateManagedDeviceForContract(payment.contractId);
    notifyPayTrigger(payment.contractId, 'PAYMENT');

    res.status(200).json({ message: 'Payment updated successfully' });
  } catch (error) {
    console.error('Update manual payment error:', error);
    res.status(500).json({ error: 'Failed to update payment' });
  }
}

// Delete a manual payment entry (Admin only)
export async function deleteManualPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { id },
      include: { contract: true },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    const metadata = JSON.parse(payment.metadata || '{}');
    if (!metadata.isManual) {
      res.status(403).json({ error: 'Only manually recorded payments can be deleted' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.delete({ where: { id } });

      // Recalculate contract totals
      const allPayments = await tx.paymentTransaction.findMany({
        where: { contractId: payment.contractId, status: 'SUCCESS' },
      });
      const paymentsSum = allPayments.reduce((sum, p) => sum + p.amount, 0);
      const contract = payment.contract;
      const newTotalPaid = roundMoney(contract.depositAmount + paymentsSum);
      const newOutstandingBalance = roundMoney(contract.totalPrice - newTotalPaid);
      const penaltyDue = (await tx.hirePurchaseContract.findUnique({
        where: { id: payment.contractId },
        select: { penaltyOutstanding: true },
      }))?.penaltyOutstanding ?? 0;
      const isFullyPaid = newOutstandingBalance <= 0.005 && penaltyDue <= 0.005;

      await tx.hirePurchaseContract.update({
        where: { id: payment.contractId },
        data: {
          totalPaid: newTotalPaid,
          outstandingBalance: Math.max(0, isFullyPaid ? 0 : newOutstandingBalance),
          status: isFullyPaid ? 'COMPLETED' : 'ACTIVE',
          completedAt: isFullyPaid ? (payment.contract.completedAt ?? new Date()) : null,
        },
      });

      // Reset and re-apply installments
      const installments = await tx.installmentSchedule.findMany({
        where: { contractId: payment.contractId },
        orderBy: { installmentNo: 'asc' },
      });

      for (const inst of installments) {
        await tx.installmentSchedule.update({
          where: { id: inst.id },
          data: { paidAmount: 0, status: 'PENDING', paidAt: null },
        });
      }

      let remaining = roundMoney(paymentsSum);
      for (const inst of installments) {
        if (remaining <= 0) break;
        const owed = inst.amount;
        if (isMoneyGte(remaining, owed)) {
          await tx.installmentSchedule.update({
            where: { id: inst.id },
            data: { paidAmount: owed, status: 'PAID', paidAt: new Date() },
          });
          remaining = roundMoney(remaining - owed);
        } else {
          await tx.installmentSchedule.update({
            where: { id: inst.id },
            data: { paidAmount: remaining, status: 'PARTIAL', paidAt: null },
          });
          remaining = 0;
        }
      }

      const penaltyNowDue = await rebuildPenaltyAllocation(payment.contractId, remaining, tx);
      if (isFullyPaid && penaltyNowDue > 0.005) {
        await tx.hirePurchaseContract.update({
          where: { id: payment.contractId },
          data: { status: 'ACTIVE', completedAt: null },
        });
      }
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'DELETE_MANUAL_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: id,
      oldValues: { amount: payment.amount, transactionRef: payment.transactionRef },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Removing a payment can reopen a balance that was settled, which should
    // put the device back under management.
    // Close any unlock window or agent bar this payment has just settled,
    // before the device is judged — otherwise both wait for tomorrow's cron.
    await settleTemporaryUnlockOnPayment(payment.contractId);
    await safelyEvaluateManagedDeviceForContract(payment.contractId);
    notifyPayTrigger(payment.contractId, 'PAYMENT_REVERSED');

    res.status(200).json({ message: 'Payment deleted successfully' });
  } catch (error) {
    console.error('Delete manual payment error:', error);
    res.status(500).json({ error: 'Failed to delete payment' });
  }
}

// Initiate Hubtel payment (Customer)
export async function initiateHubtelPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerUuid = req.user!.id;
    const { contractId, amount, phoneNumber, network } = req.body;

    // Validate required fields
    if (!contractId || !amount || !phoneNumber || !network) {
      res.status(400).json({ error: 'Contract ID, amount, phone number, and network are required' });
      return;
    }

    // Validate network
    const validNetworks = ['MTN', 'VODAFONE', 'AIRTELTIGO'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network. Must be MTN, VODAFONE, or AIRTELTIGO' });
      return;
    }

    // Validate phone number
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
    if (!validatePhoneNumber(sanitizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number' });
      return;
    }

    // Validate contract belongs to customer and is active
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        customer: true,
        installments: {
          where: {
            status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
          },
          orderBy: { installmentNo: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (!contract.customer?.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    if (contract.customerId_uuid !== customerUuid) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (!ensureContractCanAcceptPayments(contract.status, res)) {
      return;
    }

    // Validate amount
    const paymentAmount = roundMoney(Number(amount));
    if (paymentAmount <= 0) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    if (!isMoneyGte(payableCeiling(contract), paymentAmount)) {
      res.status(400).json({ error: 'Payment amount exceeds the total due on this contract' });
      return;
    }

    // Generate transaction reference
    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

    // Create payment record
    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef,
        contractId,
        customerId_uuid: contract.customerId_uuid,
        amount: paymentAmount,
        paymentMethod: 'HUBTEL_MOMO',
        mobileMoneyProvider: network.toUpperCase(),
        mobileMoneyNumber: sanitizedPhone,
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL',
        }),
      },
    });

    // Initiate Hubtel receive money
    const hubtelResponse = await initiateHubtelReceiveMoney({
      amount: paymentAmount,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      customerPhone: sanitizedPhone,
      network: network.toUpperCase(),
      description: `Payment for contract ${contract.contractNumber}`,
      transactionRef,
    });

    // Update payment with Hubtel transaction ID
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: hubtelResponse.transactionId,
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL',
          hubtelTransactionId: hubtelResponse.transactionId,
          hubtelStatus: hubtelResponse.status,
        }),
      },
    });

    res.status(200).json({
      message: 'Payment initiated successfully. Please approve on your phone.',
      transactionRef,
      transactionId: hubtelResponse.transactionId,
      amount: paymentAmount,
      status: 'PENDING',
    });
  } catch (error: any) {
    console.error('Initiate Hubtel payment error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate payment',
      details: error.response?.data || null,
    });
  }
}

// Check Hubtel payment status
export async function checkHubtelStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { transactionRef } = req.params;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef },
      include: {
        contract: {
          select: {
            contractNumber: true,
            customerId_uuid: true,
          },
        },
      },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Check if user has access
    if (req.userType === 'customer' && payment.contract.customerId_uuid !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // If already successful or failed, return current status
    if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
      res.json({
        transactionRef: payment.transactionRef,
        status: payment.status,
        amount: payment.amount,
        paymentDate: payment.paymentDate,
      });
      return;
    }

    // Check status with Hubtel if pending. The status API looks payments up
    // by OUR ClientReference (transactionRef) — Hubtel's own TransactionId in
    // that field always came back "payment record not found". A payment the
    // customer has not approved yet can also be unknown to it for a while:
    // that is "still pending", not an error, since the app polls every few
    // seconds. The callback completes the payment either way.
    if (payment.externalRef) {
      let hubtelStatus: any;
      try {
        hubtelStatus = await checkHubtelPaymentStatus(payment.transactionRef);
      } catch {
        res.json({ transactionRef: payment.transactionRef, status: payment.status, amount: payment.amount });
        return;
      }

      // Normalize Hubtel status — check both data.status and top-level ResponseCode
      const rawHubtelStatus = String(
        hubtelStatus.data?.status || hubtelStatus.Data?.Status || hubtelStatus.data?.Status || ''
      ).toUpperCase();
      const hubtelResponseCode = String(
        hubtelStatus.ResponseCode || hubtelStatus.responseCode || hubtelStatus.data?.ResponseCode || ''
      ).trim();

      void hubtelResponseCode;
      // Only the transaction's own status decides. The status service's
      // responseCode "0000" means the lookup worked, not that the customer
      // paid — reading it as paid credited contracts seconds after the
      // prompt was sent, before anyone approved it.
      let newStatus = payment.status;
      const resolved = hubtelTransactionOutcome(rawHubtelStatus);
      if (resolved) newStatus = resolved;

      if (newStatus !== payment.status) {
        await prisma.paymentTransaction.update({
          where: { id: payment.id },
          data: {
            status: newStatus,
            paymentDate: newStatus === 'SUCCESS' ? new Date() : null,
          },
        });

        if (newStatus === 'SUCCESS') {
          await processSuccessfulPayment(payment.id);
        }
      }

      res.json({
        transactionRef: payment.transactionRef,
        status: newStatus,
        amount: payment.amount,
        hubtelStatus: hubtelStatus.data?.status || hubtelStatus.Data?.Status,
      });
    } else {
      res.json({
        transactionRef: payment.transactionRef,
        status: payment.status,
        amount: payment.amount,
      });
    }
  } catch (error: any) {
    console.error('Check Hubtel status error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
}

// Hubtel webhook callback handler
export async function handleHubtelCallback(req: Request, res: Response): Promise<void> {
  try {
    const webhookError = validateWebhookRequest(req);
    if (webhookError) {
      res.status(401).json({ error: webhookError });
      return;
    }

    console.log('Hubtel callback received:', req.body);

    // Process the callback
    await processHubtelCallback(req.body);

    // Respond to Hubtel
    res.status(200).json({ message: 'Callback processed successfully' });
  } catch (error) {
    console.error('Hubtel callback error:', error);
    res.status(500).json({ error: 'Failed to process callback' });
  }
}

// ==================== HUBTEL DIRECT DEBIT - PREAPPROVAL ====================

// Initiate preapproval for Direct Debit (Admin)
export async function initiateDirectDebitPreapproval(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { customerId, phoneNumber, network } = req.body;

    if (!customerId || !phoneNumber || !network) {
      res.status(400).json({ error: 'Customer ID, phone number, and network are required' });
      return;
    }

    // Validate network
    const validNetworks = ['MTN', 'VODAFONE', 'TELECEL'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network. Direct Debit only supports MTN, VODAFONE, and TELECEL' });
      return;
    }

    // Check if customer exists
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id_uuid: true },
    });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    if (!customer.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    // Check if already has an active preapproval for this network
    const existingPreapproval = await prisma.hubtelPreapproval.findFirst({
      where: {
        customerId_uuid: customer.id_uuid,
        customerMsisdn: formatPhoneForHubtel(phoneNumber),
        status: 'APPROVED',
      },
    });

    if (existingPreapproval) {
      res.status(400).json({
        error: 'Customer already has an active preapproval for this phone number',
        preapprovalId: existingPreapproval.id,
      });
      return;
    }

    // Generate unique client reference
    const clientReferenceId = `PREAPPR-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    // Initiate preapproval
    const preapprovalResponse = await initiatePreapproval({
      customerId: customer.id_uuid,
      customerPhone: phoneNumber,
      network: network.toUpperCase(),
      clientReferenceId,
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'INITIATE_PREAPPROVAL',
      entity: 'HubtelPreapproval',
      entityId: clientReferenceId,
      newValues: {
        customerId,
        network: network.toUpperCase(),
        clientReferenceId,
        verificationType: preapprovalResponse.verificationType,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({
      message: preapprovalResponse.verificationType === 'USSD'
        ? 'Customer will receive USSD prompt on their phone'
        : 'Customer will receive OTP via SMS',
      clientReferenceId: preapprovalResponse.clientReferenceId,
      hubtelPreapprovalId: preapprovalResponse.hubtelPreapprovalId,
      verificationType: preapprovalResponse.verificationType,
      otpPrefix: preapprovalResponse.otpPrefix,
      status: preapprovalResponse.status,
    });
  } catch (error: any) {
    console.error('Initiate preapproval error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate preapproval',
    });
  }
}

// Verify OTP for preapproval (Admin)
export async function verifyDirectDebitOTP(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { clientReferenceId, otpCode, phoneNumber } = req.body;

    if (!clientReferenceId || !otpCode || !phoneNumber) {
      res.status(400).json({ error: 'Client reference ID, OTP code, and phone number are required' });
      return;
    }

    // Find the preapproval
    const preapproval = await prisma.hubtelPreapproval.findUnique({
      where: { clientReferenceId },
    });

    if (!preapproval) {
      res.status(404).json({ error: 'Preapproval not found' });
      return;
    }

    if (preapproval.status !== 'PENDING') {
      res.status(400).json({ error: `Preapproval is already ${preapproval.status.toLowerCase()}` });
      return;
    }

    if (!preapproval.hubtelPreapprovalId) {
      res.status(400).json({ error: 'Invalid preapproval state' });
      return;
    }

    // Verify OTP
    const verifyResponse = await verifyPreapprovalOTP({
      customerPhone: phoneNumber,
      hubtelPreapprovalId: preapproval.hubtelPreapprovalId,
      clientReferenceId,
      otpCode,
    });

    res.json({
      message: verifyResponse.message,
      status: verifyResponse.status,
    });
  } catch (error: any) {
    console.error('Verify OTP error:', error);
    res.status(500).json({
      error: error.message || 'Failed to verify OTP',
    });
  }
}

// Check preapproval status (Admin)
export async function getPreapprovalStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { clientReferenceId } = req.params;

    const preapproval = await prisma.hubtelPreapproval.findUnique({
      where: { clientReferenceId },
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
          },
        },
      },
    });

    if (!preapproval) {
      res.status(404).json({ error: 'Preapproval not found' });
      return;
    }

    // If still pending, check with Hubtel
    if (preapproval.status === 'PENDING') {
      try {
        const hubtelStatus = await checkPreapprovalStatus(clientReferenceId);

        if (hubtelStatus.data?.preapprovalStatus && hubtelStatus.data.preapprovalStatus !== preapproval.status) {
          await prisma.hubtelPreapproval.update({
            where: { id: preapproval.id },
            data: {
              status: hubtelStatus.data.preapprovalStatus.toUpperCase(),
              approvedAt: hubtelStatus.data.preapprovalStatus.toUpperCase() === 'APPROVED' ? new Date() : null,
            },
          });

          preapproval.status = hubtelStatus.data.preapprovalStatus.toUpperCase();
        }
      } catch (error) {
        console.error('Failed to check Hubtel status:', error);
      }
    }

    res.json({
      clientReferenceId: preapproval.clientReferenceId,
      hubtelPreapprovalId: preapproval.hubtelPreapprovalId,
      status: preapproval.status,
      verificationType: preapproval.verificationType,
      customerMsisdn: preapproval.customerMsisdn,
      channel: preapproval.channel,
      approvedAt: preapproval.approvedAt,
      customer: preapproval.customer,
      createdAt: preapproval.createdAt,
    });
  } catch (error: any) {
    console.error('Get preapproval status error:', error);
    res.status(500).json({ error: 'Failed to get preapproval status' });
  }
}

// Get all preapprovals for a customer (Admin)
export async function getCustomerPreapprovals(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { customerId } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id_uuid: true },
    });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const preapprovals = await prisma.hubtelPreapproval.findMany({
      where: { customerId_uuid: customer.id_uuid },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ preapprovals });
  } catch (error) {
    console.error('Get customer preapprovals error:', error);
    res.status(500).json({ error: 'Failed to get preapprovals' });
  }
}

// Hubtel preapproval callback handler
export async function handlePreapprovalCallback(req: Request, res: Response): Promise<void> {
  try {
    const webhookError = validateWebhookRequest(req);
    if (webhookError) {
      res.status(401).json({ error: webhookError });
      return;
    }

    console.log('Hubtel preapproval callback received:', req.body);

    // Process the preapproval callback
    await processPreapprovalCallback(req.body);

    // Respond to Hubtel
    res.status(200).json({ message: 'Preapproval callback processed successfully' });
  } catch (error) {
    console.error('Preapproval callback error:', error);
    res.status(500).json({ error: 'Failed to process preapproval callback' });
  }
}

// Initiate Hubtel Regular Receive Money payment (Customer & Admin)
export async function initiateHubtelRegularPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, amount, phoneNumber, network } = req.body;
    const customerId = req.userType === 'customer' ? req.user!.id : undefined;

    if (!contractId || !amount || !phoneNumber || !network) {
      res.status(400).json({ error: 'Contract ID, amount, phone number, and network are required' });
      return;
    }

    // Validate network
    const validNetworks = ['MTN', 'VODAFONE', 'TELECEL', 'AIRTELTIGO'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network' });
      return;
    }

    // Validate contract
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: { customer: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (!contract.customer?.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    // Check ownership for customers
    if (customerId && contract.customerId_uuid !== customerId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (!ensureContractCanAcceptPayments(contract.status, res)) {
      return;
    }

    // Validate amount
    const paymentAmount = roundMoney(Number(amount));
    if (paymentAmount <= 0 || !isMoneyGte(payableCeiling(contract), paymentAmount)) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    // Generate transaction reference
    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

    // Create payment record
    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef,
        contractId,
        customerId_uuid: contract.customerId_uuid,
        amount: paymentAmount,
        paymentMethod: 'HUBTEL_REGULAR',
        mobileMoneyProvider: network.toUpperCase(),
        mobileMoneyNumber: formatPhoneForHubtel(phoneNumber),
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_REGULAR',
        }),
      },
    });

    // Initiate Hubtel Receive Money
    const hubtelResponse = await initiateHubtelReceiveMoney({
      amount: paymentAmount,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      customerPhone: phoneNumber,
      customerEmail: contract.customer.email || undefined,
      network: network.toUpperCase(),
      description: `Payment for contract ${contract.contractNumber}`,
      transactionRef,
    });

    // Update payment with transaction ID
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: hubtelResponse.transactionId,
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_REGULAR',
          hubtelTransactionId: hubtelResponse.transactionId,
        }),
      },
    });

    res.status(200).json({
      message: 'Payment initiated. Customer will receive prompt on their phone.',
      transactionRef,
      transactionId: hubtelResponse.transactionId,
      amount: paymentAmount,
      status: 'PENDING',
    });
  } catch (error: any) {
    console.error('Initiate Hubtel Regular payment error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate payment',
    });
  }
}

// Initiate Hubtel Direct Debit payment (Admin only - for recurring payments)
export async function initiateDirectDebitPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, amount } = req.body;

    if (!contractId) {
      res.status(400).json({ error: 'Contract ID is required' });
      return;
    }

    // Get contract with payment method details
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: { customer: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Contract is not active' });
      return;
    }

    if (contract.paymentMethod !== 'HUBTEL_DIRECT_DEBIT') {
      res.status(400).json({ error: 'Contract is not set up for Direct Debit payments' });
      return;
    }

    if (!contract.mobileMoneyNetwork || !contract.mobileMoneyNumber) {
      res.status(400).json({ error: 'Contract missing mobile money details' });
      return;
    }

    // Check if customer has approved preapproval
    const preapproval = await prisma.hubtelPreapproval.findFirst({
      where: {
        customerId_uuid: contract.customerId_uuid,
        customerMsisdn: formatPhoneForHubtel(contract.mobileMoneyNumber),
        status: 'APPROVED',
      },
    });

    if (!preapproval) {
      res.status(400).json({
        error: 'Customer has not approved Direct Debit for this phone number. Please initiate preapproval first.',
      });
      return;
    }

    // Validate amount
    const paymentAmount = amount ? Number(amount) : contract.installmentAmount;
    if (paymentAmount <= 0 || !isMoneyGte(payableCeiling(contract), paymentAmount)) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    // Generate transaction reference
    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

    // Create payment record
    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef,
        contractId,
        customerId_uuid: contract.customerId_uuid,
        amount: paymentAmount,
        paymentMethod: 'HUBTEL_DIRECT_DEBIT',
        mobileMoneyProvider: contract.mobileMoneyNetwork,
        mobileMoneyNumber: contract.mobileMoneyNumber,
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_DIRECT_DEBIT',
          preapprovalId: preapproval.id,
        }),
      },
    });

    // Initiate Direct Debit Charge
    const hubtelResponse = await initiateDirectDebitCharge({
      amount: paymentAmount,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      customerPhone: contract.mobileMoneyNumber,
      customerEmail: contract.customer.email || undefined,
      network: contract.mobileMoneyNetwork,
      description: `Auto-debit for contract ${contract.contractNumber}`,
      transactionRef,
    });

    // Update payment with transaction ID
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: hubtelResponse.transactionId,
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_DIRECT_DEBIT',
          preapprovalId: preapproval.id,
          hubtelTransactionId: hubtelResponse.transactionId,
        }),
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'INITIATE_DIRECT_DEBIT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        transactionRef,
        amount: paymentAmount,
        contractId,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({
      message: 'Direct Debit charge initiated. No customer action required.',
      transactionRef,
      transactionId: hubtelResponse.transactionId,
      amount: paymentAmount,
      status: 'PENDING',
    });
  } catch (error: any) {
    console.error('Initiate Direct Debit payment error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate Direct Debit payment',
    });
  }
}

// ─── USSD Payment Endpoints ───────────────────────────────────────────────────

// GET /payments/ussd/balance?phoneNumber=0244123456
export async function getUssdBalance(req: Request, res: Response): Promise<void> {
  try {
    const { phoneNumber } = req.query as { phoneNumber?: string };

    if (!phoneNumber) {
      res.status(400).json({ success: false, message: 'Phone number is required.' });
      return;
    }

    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    const customer = await prisma.customer.findFirst({
      where: { phone: sanitizedPhone },
    });

    if (!customer) {
      res.status(404).json({ success: false, message: 'You are not a registered customer.' });
      return;
    }

    if (!customer.isActivated) {
      res.status(403).json({ success: false, message: 'Your account is not active. Please contact us.' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findFirst({
      where: { customerId_uuid: customer.id_uuid, status: 'ACTIVE' },
      include: {
        installments: {
          where: { status: { in: ['PENDING', 'OVERDUE', 'PARTIAL'] } },
          orderBy: { dueDate: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ success: false, message: 'You have no active hire purchase contract.' });
      return;
    }

    if (contract.installments.length === 0) {
      res.status(200).json({ success: false, message: 'You have no outstanding payments.' });
      return;
    }

    const now = new Date();
    const overdueInstallments = contract.installments.filter(inst => inst.status === 'OVERDUE' || (inst.dueDate < now && inst.status !== 'PAID'));
    const overdueCount = overdueInstallments.length;
    const overdueAmount = overdueInstallments.reduce((sum, inst) => sum + (inst.amount - inst.paidAmount), 0);
    const totalDueAmount = contract.installments.reduce((sum, inst) => sum + (inst.amount - inst.paidAmount), 0);
    const next = contract.installments[0];

    res.status(200).json({
      success: true,
      customerName: `${customer.firstName} ${customer.lastName}`,
      contractNumber: contract.contractNumber,
      totalOutstanding: contract.outstandingBalance,
      installmentsDue: contract.installments.length,
      totalDueAmount: parseFloat(totalDueAmount.toFixed(2)),
      overdueCount,
      overdueAmount: parseFloat(overdueAmount.toFixed(2)),
      nextDueDate: next.dueDate,
      nextInstallmentAmount: parseFloat((next.amount - next.paidAmount).toFixed(2)),
    });
  } catch (error: any) {
    console.error('USSD balance error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve balance.' });
  }
}

// POST /payments/ussd/initiate
export async function initiateUssdPayment(req: Request, res: Response): Promise<void> {
  try {
    const { phoneNumber, network, amount } = req.body;

    if (!phoneNumber || !network || !amount) {
      res.status(400).json({ success: false, message: 'Phone number, network, and amount are required.' });
      return;
    }

    const validNetworks = ['MTN', 'VODAFONE', 'TELECEL', 'AIRTELTIGO'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ success: false, message: 'Invalid network. Use MTN, VODAFONE, TELECEL, or AIRTELTIGO.' });
      return;
    }

    const paymentAmount = roundMoney(Number(amount));
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
      return;
    }

    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);

    const customer = await prisma.customer.findFirst({
      where: { phone: sanitizedPhone },
    });

    if (!customer) {
      res.status(404).json({ success: false, message: 'You are not a registered customer.' });
      return;
    }

    if (!customer.isActivated) {
      res.status(403).json({ success: false, message: 'Your account is not active. Please contact us.' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findFirst({
      where: { customerId_uuid: customer.id_uuid, status: 'ACTIVE' },
      include: {
        installments: {
          where: { status: { in: ['PENDING', 'OVERDUE', 'PARTIAL'] } },
          orderBy: { dueDate: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ success: false, message: 'You have no active hire purchase contract.' });
      return;
    }

    if (contract.installments.length === 0) {
      res.status(200).json({ success: false, message: 'You have no outstanding payments.' });
      return;
    }

    // Generate unique transaction reference
    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

    // Create payment record
    await prisma.paymentTransaction.create({
      data: {
        transactionRef,
        contractId: contract.id,
        customerId_uuid: customer.id_uuid,
        amount: paymentAmount,
        paymentMethod: 'HUBTEL_REGULAR',
        mobileMoneyProvider: network.toUpperCase(),
        mobileMoneyNumber: formatPhoneForHubtel(sanitizedPhone),
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_REGULAR',
          channel: 'USSD',
        }),
      },
    });

    // Send USSD prompt via Hubtel
    const hubtelResponse = await initiateHubtelReceiveMoney({
      amount: paymentAmount,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerPhone: sanitizedPhone,
      customerEmail: customer.email || undefined,
      network: network.toUpperCase(),
      description: `Payment for contract ${contract.contractNumber}`,
      transactionRef,
    });

    await prisma.paymentTransaction.update({
      where: { transactionRef },
      data: {
        externalRef: hubtelResponse.transactionId,
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_REGULAR',
          channel: 'USSD',
          hubtelTransactionId: hubtelResponse.transactionId,
        }),
      },
    });

    res.status(200).json({
      success: true,
      message: 'A payment prompt has been sent to your phone. Please approve to complete payment.',
      transactionRef,
      amount: paymentAmount,
      contractNumber: contract.contractNumber,
    });
  } catch (error: any) {
    console.error('USSD initiate payment error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to initiate payment.' });
  }
}

// GET /payments/ussd/status/:transactionRef
export async function getUssdPaymentStatus(req: Request, res: Response): Promise<void> {
  try {
    const { transactionRef } = req.params;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef },
    });

    if (!payment) {
      res.status(404).json({ success: false, message: 'Transaction not found.' });
      return;
    }

    const messages: Record<string, string> = {
      PENDING: 'Your payment is being processed.',
      SUCCESS: `Payment of GHS ${payment.amount.toFixed(2)} was successful.`,
      FAILED: 'Payment failed. Please try again.',
    };

    res.status(200).json({
      success: true,
      transactionRef,
      status: payment.status,
      amount: payment.amount,
      message: messages[payment.status] ?? 'Unknown payment status.',
    });
  } catch (error: any) {
    console.error('USSD payment status error:', error);
    res.status(500).json({ success: false, message: 'Failed to retrieve payment status.' });
  }
}

// ─── Hubtel Programmable Services Session Handler ────────────────────────────

function ussdRelease(sessionId: string, message: string) {
  return {
    SessionId: sessionId,
    Type: 'release',
    Message: message,
    Label: message,
    ClientState: '',
    DataType: 'display',
    FieldType: 'text',
  };
}

/** Seconds between closing the USSD session and sending the Mobile Money prompt. */
const USSD_PROMPT_DELAY_MS = Number(process.env.USSD_PROMPT_DELAY_MS || '4000');

/** Send the Mobile Money prompt for a USSD payment once the session has closed. */
async function sendUssdPaymentPrompt(paymentId: string, p: {
  amount: number; customerName: string; customerEmail?: string; phone: string; network: string; contractNumber: string; transactionRef: string;
}): Promise<void> {
  try {
    const hubtel = await initiateHubtelReceiveMoney({
      amount: p.amount,
      customerName: p.customerName,
      customerPhone: p.phone,
      customerEmail: p.customerEmail,
      network: p.network,
      description: `Hire purchase payment for contract ${p.contractNumber}`,
      transactionRef: p.transactionRef,
    });
    const existing = await prisma.paymentTransaction.findUnique({ where: { id: paymentId }, select: { metadata: true } });
    await prisma.paymentTransaction.update({
      where: { id: paymentId },
      data: {
        externalRef: hubtel.transactionId,
        metadata: JSON.stringify({ ...JSON.parse(existing?.metadata || '{}'), hubtelTransactionId: hubtel.transactionId, promptSentAt: new Date().toISOString() }),
      },
    });
  } catch (error: any) {
    // The customer has already been told to expect a prompt; record why it
    // did not come so support can see it.
    await prisma.paymentTransaction.update({
      where: { id: paymentId },
      data: { status: 'FAILED', failureReason: `Mobile Money prompt not sent: ${error?.message || 'unknown error'}`.slice(0, 250) },
    }).catch(() => undefined);
    throw error;
  }
}

function ussdResponse(sessionId: string, message: string, label: string, clientState: string, fieldType = 'text') {
  return {
    SessionId: sessionId,
    Type: 'response',
    Message: message,
    Label: label,
    ClientState: clientState,
    DataType: 'input',
    FieldType: fieldType,
  };
}

type UssdPayer = 'SELF' | 'OTHER';

/**
 * The balance menu for the customer being paid for, or — when there is
 * nothing to pay — the reason, worded for whoever is paying.
 */
async function buildBalanceMenu(sessionId: string, customer: any, paymentPhone: string, network: string, payer: UssdPayer) {
  const contract = await prisma.hirePurchaseContract.findFirst({
    where: { customerId_uuid: customer.id_uuid, status: 'ACTIVE' },
    include: {
      installments: {
        where: { status: { in: ['PENDING', 'OVERDUE', 'PARTIAL'] } },
        orderBy: { dueDate: 'asc' },
      },
    },
  });

  if (!contract) {
    return { missing: payer === 'SELF' ? 'You have no active hire purchase contract.' : 'That customer has no active hire purchase contract.' };
  }
  if (contract.installments.length === 0) {
    return { missing: payer === 'SELF' ? 'You have no outstanding payments.' : 'That customer has no outstanding payments.' };
  }

  const now = new Date();
  const overdueInstallments = contract.installments.filter(
    inst => inst.status === 'OVERDUE' || (inst.dueDate < now && inst.status !== 'PAID')
  );
  const totalDueAmount = contract.installments.reduce((sum, inst) => sum + (inst.amount - inst.paidAmount), 0);
  const next = contract.installments[0];

  const state = JSON.stringify({
    contractId: contract.id,
    contractNumber: contract.contractNumber,
    customerId: customer.id_uuid,
    customerName: `${customer.firstName} ${customer.lastName}`,
    customerEmail: customer.email || '',
    phone: paymentPhone, // dialing number — used for Hubtel payment prompt
    network,
    payer,
  });

  const formattedDueDate = new Date(next.dueDate).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const overdueWarning = overdueInstallments.length > 0
    ? `Overdue: ${overdueInstallments.length} PMT(s)\n`
    : '';
  // Someone paying for another person sees whose account it is, so a
  // mistyped number is noticed before any money moves.
  const greeting = payer === 'SELF'
    ? `Hi ${customer.firstName}, (${contract.contractNumber})\n`
    : `For: ${customer.firstName} ${String(customer.lastName || '').charAt(0)}. (${contract.contractNumber})\n`;

  const message =
    `AIDOO TECH\n` +
    greeting +
    overdueWarning +
    `Bal: GHS ${contract.outstandingBalance.toFixed(2)}\n` +
    `Due: GHS ${totalDueAmount.toFixed(2)} (${contract.installments.length})\n` +
    `Next: GHS ${(next.amount - next.paidAmount).toFixed(2)}, ${formattedDueDate}\n` +
    `1. Pay  0. Cancel`;

  return { response: ussdResponse(sessionId, message, 'Aidoo Tech Hire Purchase', state) };
}

function askForOtherNumber(sessionId: string, dialingPhone: string, network: string) {
  return ussdResponse(sessionId, "Enter the customer's registered phone number:", 'Pay For Others', `OTHER|${dialingPhone}|${network}`, 'phone');
}

// POST /payments/ussd/session  — Hubtel Service Interaction URL
//
//   Dial → 1. Pay for self   → balance → amount → Mobile Money prompt
//          2. Pay for others → their number → balance → amount → prompt
// "Pay for self" from a number with nothing to pay offers "pay for others"
// instead. The prompt always goes to the number that dialled.
export async function handleUssdSession(req: Request, res: Response): Promise<void> {
  try {
    const { Type, Mobile, SessionId, Message, Operator } = req.body;
    const ClientState: string = req.body.ClientState || '';
    const choice = String(Message ?? '').trim();

    // Handle session timeout
    if (Type === 'Timeout') {
      res.json(ussdRelease(SessionId, 'Session timed out. Please try again.'));
      return;
    }

    // ── Step 1: Initiation — pay for self or for others ──────────────────────
    if (Type === 'Initiation') {
      const dialingPhone = sanitizePhoneNumber(Mobile);
      const networkMap: Record<string, string> = {
        mtn: 'MTN', vodafone: 'VODAFONE', telecel: 'VODAFONE', tigo: 'AIRTELTIGO', airtel: 'AIRTELTIGO',
      };
      const network = networkMap[Operator?.toLowerCase()] || 'MTN';
      res.json(ussdResponse(
        SessionId,
        `AIDOO TECH\n1. Pay for self\n2. Pay for others\n0. Cancel`,
        'Aidoo Tech Hire Purchase',
        `MENU|${dialingPhone}|${network}`,
      ));
      return;
    }

    // ── Step 2: Chose self (1), others (2) or cancel (0) ─────────────────────
    if (Type === 'Response' && ClientState.startsWith('MENU|')) {
      const [, dialingPhone, network] = ClientState.split('|');
      if (choice === '0') {
        res.json(ussdRelease(SessionId, 'Thank you. Goodbye.'));
        return;
      }
      if (choice === '2') {
        res.json(askForOtherNumber(SessionId, dialingPhone, network));
        return;
      }
      if (choice !== '1') {
        res.json(ussdRelease(SessionId, 'Invalid option. Please dial again.'));
        return;
      }

      const customer = await prisma.customer.findFirst({ where: { phone: dialingPhone } });
      const menu = customer ? await buildBalanceMenu(SessionId, customer, dialingPhone, network, 'SELF') : null;
      if (menu && 'response' in menu) {
        res.json(menu.response);
        return;
      }
      // Nothing to pay on this number: perhaps they are paying for a relative.
      const reason = menu?.missing || 'This number is not registered.';
      res.json(ussdResponse(
        SessionId,
        `AIDOO TECH\n${reason}\n1. Pay for others\n0. Cancel`,
        'Nothing To Pay',
        `NOSELF|${dialingPhone}|${network}`,
      ));
      return;
    }

    // ── Step 2a: Nothing to pay for self — pay for others (1) or cancel (0) ──
    // UNREGISTERED is the same menu from before this flow; it can still
    // arrive from a session open during a deploy.
    if (Type === 'Response' && (ClientState.startsWith('NOSELF|') || ClientState.startsWith('UNREGISTERED|'))) {
      const [, dialingPhone, network] = ClientState.split('|');
      if (choice === '0') {
        res.json(ussdRelease(SessionId, 'Thank you. Goodbye.'));
        return;
      }
      if (choice !== '1') {
        res.json(ussdRelease(SessionId, 'Invalid option. Please dial again.'));
        return;
      }
      res.json(askForOtherNumber(SessionId, dialingPhone, network));
      return;
    }

    // ── Step 2b: Pay for others — the customer's registered number ───────────
    if (Type === 'Response' && (ClientState.startsWith('OTHER|') || ClientState.startsWith('VERIFY|'))) {
      const [, dialingPhone, network] = ClientState.split('|');
      const enteredPhone = sanitizePhoneNumber(choice);
      const customer = validatePhoneNumber(enteredPhone)
        ? await prisma.customer.findFirst({ where: { phone: enteredPhone } })
        : null;
      if (!customer) {
        res.json(ussdRelease(SessionId, 'Number not recognised. Please check the number and dial again.'));
        return;
      }
      const menu = await buildBalanceMenu(SessionId, customer, dialingPhone, network, 'OTHER');
      res.json('response' in menu ? menu.response : ussdRelease(SessionId, menu.missing));
      return;
    }

    // ── Step 3: Balance shown — chose 1 (Pay) or 0 (Cancel) ──────────────────
    if (Type === 'Response' && ClientState.startsWith('{')) {
      if (choice === '0') {
        res.json(ussdRelease(SessionId, 'Thank you. Goodbye.'));
        return;
      }

      if (choice !== '1') {
        res.json(ussdRelease(SessionId, 'Invalid option. Please try again.'));
        return;
      }

      let state: any;
      try {
        state = JSON.parse(ClientState);
      } catch {
        res.json(ussdRelease(SessionId, 'Session error. Please dial again.'));
        return;
      }

      const nextState = `AMOUNT|${state.contractId}|${state.network}|${state.customerId}|${state.customerName}|${state.customerEmail}|${state.phone}|${state.contractNumber}|${state.payer || 'SELF'}`;

      res.json(ussdResponse(SessionId, 'Enter amount to pay (GHS):', 'Payment Amount', nextState, 'decimal'));
      return;
    }

    // ── Step 3: Customer entered an amount ────────────────────────────────────
    if (Type === 'Response' && ClientState.startsWith('AMOUNT|')) {
      const parts = ClientState.split('|');
      const [, contractId, network, customerId, , , phone, contractNumber, payer = 'SELF'] = parts;

      const paymentAmount = roundMoney(parseFloat(choice.replace(/,/g, '')));
      if (isNaN(paymentAmount) || paymentAmount <= 0) {
        res.json(ussdRelease(SessionId, 'Invalid amount. Please dial again and enter a valid amount.'));
        return;
      }

      // Re-read the contract: the amount must not exceed what is owed. A
      // phone number typed into the amount field used to go straight to the
      // payment provider as a GHS 245,064,424 charge.
      const contract = await prisma.hirePurchaseContract.findUnique({
        where: { id: contractId },
        select: {
          status: true,
          outstandingBalance: true,
          penaltyOutstanding: true,
          customer: { select: { firstName: true, lastName: true, email: true } },
        },
      });
      if (!contract || contract.status !== 'ACTIVE') {
        res.json(ussdRelease(SessionId, 'This contract cannot receive payments. Please contact customer service.'));
        return;
      }
      const ceiling = payableCeiling(contract);
      if (paymentAmount > ceiling + 0.005) {
        res.json(ussdRelease(SessionId, `Amount is more than you owe (GHS ${ceiling.toFixed(2)}). Please dial again and enter GHS ${ceiling.toFixed(2)} or less.`));
        return;
      }

      // Generate unique transaction ref
      let transactionRef = generateTransactionRef();
      let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
      while (exists) {
        transactionRef = generateTransactionRef();
        exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
      }

      // Recorded as pending; Hubtel's payment callback completes it.
      const payment = await prisma.paymentTransaction.create({
        data: {
          transactionRef,
          contractId,
          customerId_uuid: customerId,
          amount: paymentAmount,
          paymentMethod: 'HUBTEL_REGULAR',
          mobileMoneyProvider: network,
          mobileMoneyNumber: formatPhoneForHubtel(phone),
          status: 'PENDING',
          metadata: JSON.stringify({
            initiatedAt: new Date().toISOString(),
            gateway: 'HUBTEL_REGULAR',
            channel: 'USSD',
            sessionId: SessionId,
            // OTHER: someone paid from their own number for this customer.
            paidFor: payer === 'OTHER' ? 'OTHER' : 'SELF',
            payerPhone: phone,
          }),
        },
      });

      // Close the USSD session first, then ask Hubtel for the Mobile Money
      // prompt. A prompt cannot reach a phone that is still inside a USSD
      // session, and waiting on Hubtel before answering timed the session out
      // ("service not available"). Hubtel's own checkout was tried instead but
      // never produced a prompt. The prompt goes to the number that dialled,
      // which may differ from the registered one.
      res.json(ussdRelease(
        SessionId,
        `Payment of GHS ${paymentAmount.toFixed(2)} for ${contractNumber}. You will receive a Mobile Money prompt on ${phone} shortly. Enter your PIN to approve.`,
      ));
      setTimeout(() => {
        sendUssdPaymentPrompt(payment.id, {
          amount: paymentAmount,
          customerName: contract.customer ? `${contract.customer.firstName} ${contract.customer.lastName}`.trim() : 'Customer',
          customerEmail: contract.customer?.email || undefined,
          phone,
          network,
          contractNumber,
          transactionRef,
        }).catch((err) => console.error('USSD payment prompt failed:', err?.message || err));
      }, USSD_PROMPT_DELAY_MS).unref?.();
      return;
    }

    // Fallback
    res.json(ussdRelease(SessionId, 'Session error. Please dial again.'));
  } catch (error: any) {
    console.error('USSD session error:', error);
    // Always return a valid Hubtel response shape even on error
    const sessionId = req.body?.SessionId || '';
    res.json(ussdRelease(sessionId, 'Service unavailable. Please try again later.'));
  }
}

// POST /payments/ussd/fulfillment  — Hubtel Service Fulfillment URL
export async function handleUssdFulfillment(req: Request, res: Response): Promise<void> {
  try {
    const { SessionId, OrderId, OrderInfo } = req.body;

    if (!OrderInfo?.Payment?.IsSuccessful) {
      res.status(200).json({ received: true });
      return;
    }

    const customerPhone = sanitizePhoneNumber(OrderInfo.CustomerMobileNumber || '');

    // Find the pending transaction linked to this session
    const payment = await prisma.paymentTransaction.findFirst({
      where: {
        status: 'PENDING',
        mobileMoneyNumber: formatPhoneForHubtel(customerPhone),
        metadata: { contains: SessionId },
      },
    });

    if (payment) {
      // Use AmountAfterCharges (net merchant receives) if available, otherwise fall back to the stored payment amount
      const amountPaid = typeof OrderInfo.Payment.AmountPaid === 'number'
        ? OrderInfo.Payment.AmountPaid
        : typeof OrderInfo.Payment.AmountAfterCharges === 'number'
          ? OrderInfo.Payment.AmountAfterCharges
          : payment.amount;

      // Update transaction to SUCCESS
      await prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          status: 'SUCCESS',
          paymentDate: new Date(),
          externalRef: OrderId,
          metadata: JSON.stringify({
            ...JSON.parse(payment.metadata || '{}'),
            fulfilledAt: new Date().toISOString(),
            orderId: OrderId,
            amountPaid,
          }),
        },
      });

      // Use the canonical processSuccessfulPayment to update installments and contract totals
      await processSuccessfulPayment(payment.id);
    }

    // Always acknowledge fulfillment to Hubtel with 'success' — regardless of whether we found a matching
    // payment record. Hubtel requires a 200 acknowledgment; sending 'failed' causes them to retry indefinitely.
    await fetch(process.env.HUBTEL_SERVICE_CALLBACK_URL || 'https://gs-callback.hubtel.com:9055/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SessionId,
        OrderId,
        ServiceStatus: 'success',
        MetaData: null,
      }),
    }).catch(err => console.error('Hubtel fulfillment callback failed:', err));

    res.status(200).json({ received: true });
  } catch (error: any) {
    console.error('USSD fulfillment error:', error);
    res.status(200).json({ received: true });
  }
}

// POST /payments/admin/reconcile
// Finds all PENDING Hubtel payments, queries Hubtel for their actual status,
// and updates any that have resolved without a callback being received.
export async function reconcileHubtelPayments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const olderThanMinutes = Number(req.query.olderThanMinutes) || 10;
    const dryRun = req.query.dryRun === 'true';
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

    // Find PENDING Hubtel payments that have an externalRef (i.e. Hubtel accepted them)
    const pendingPayments = await prisma.paymentTransaction.findMany({
      where: {
        status: 'PENDING',
        paymentMethod: { in: ['HUBTEL_MOMO', 'HUBTEL_REGULAR', 'HUBTEL_DIRECT_DEBIT'] },
        externalRef: { not: null },
        createdAt: { lt: cutoff },
      },
      include: {
        contract: {
          select: {
            contractNumber: true,
            customerId_uuid: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const results: {
      transactionRef: string;
      contractNumber: string;
      amount: number;
      createdAt: Date;
      hubtelStatus: string;
      action: 'updated_success' | 'updated_failed' | 'still_pending' | 'error' | 'dry_run';
      error?: string;
    }[] = [];

    for (const payment of pendingPayments) {
      try {
        const hubtelResponse = await checkHubtelPaymentStatus(payment.transactionRef);

        // Hubtel status API can return status in data.status, Data.Status, or top-level ResponseCode
        const rawStatus = String(
          hubtelResponse.data?.status ||
          hubtelResponse.Data?.Status ||
          hubtelResponse.data?.Status ||
          ''
        ).toUpperCase();
        const responseCode = String(
          hubtelResponse.ResponseCode ||
          hubtelResponse.responseCode ||
          hubtelResponse.data?.ResponseCode ||
          ''
        ).trim();

        void responseCode;
        // As in checkHubtelStatus: the transaction status alone decides.
        const resolvedStatus = hubtelTransactionOutcome(rawStatus);

        if (!resolvedStatus) {
          results.push({
            transactionRef: payment.transactionRef,
            contractNumber: payment.contract?.contractNumber ?? '',
            amount: payment.amount,
            createdAt: payment.createdAt,
            hubtelStatus: rawStatus || 'PENDING',
            action: 'still_pending',
          });
          continue;
        }

        if (dryRun) {
          results.push({
            transactionRef: payment.transactionRef,
            contractNumber: payment.contract?.contractNumber ?? '',
            amount: payment.amount,
            createdAt: payment.createdAt,
            hubtelStatus: rawStatus,
            action: 'dry_run',
          });
          continue;
        }

        // Update payment status
        await prisma.paymentTransaction.update({
          where: { id: payment.id },
          data: {
            status: resolvedStatus,
            paymentDate: resolvedStatus === 'SUCCESS' ? new Date() : null,
            metadata: JSON.stringify({
              ...JSON.parse(payment.metadata || '{}'),
              reconciledAt: new Date().toISOString(),
              hubtelStatus: rawStatus,
            }),
          },
        });

        if (resolvedStatus === 'SUCCESS') {
          await processSuccessfulPayment(payment.id);
        }

        results.push({
          transactionRef: payment.transactionRef,
          contractNumber: payment.contract?.contractNumber ?? '',
          amount: payment.amount,
          createdAt: payment.createdAt,
          hubtelStatus: rawStatus,
          action: resolvedStatus === 'SUCCESS' ? 'updated_success' : 'updated_failed',
        });
      } catch (err: any) {
        results.push({
          transactionRef: payment.transactionRef,
          contractNumber: payment.contract?.contractNumber ?? '',
          amount: payment.amount,
          createdAt: payment.createdAt,
          hubtelStatus: 'ERROR',
          action: 'error',
          error: err.message,
        });
      }
    }

    const summary = {
      checkedCount: pendingPayments.length,
      updatedSuccess: results.filter(r => r.action === 'updated_success').length,
      updatedFailed: results.filter(r => r.action === 'updated_failed').length,
      stillPending: results.filter(r => r.action === 'still_pending').length,
      errors: results.filter(r => r.action === 'error').length,
      dryRun,
      olderThanMinutes,
    };

    console.log('Hubtel reconciliation complete:', summary);

    res.json({ summary, results });
  } catch (error: any) {
    console.error('Reconciliation error:', error);
    res.status(500).json({ error: 'Reconciliation failed' });
  }
}
