import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import { resolveContractScope, scopeAllows } from '../services/scopeService';
import { isSellingAgentRole } from '../constants/roles';
import { initiateHubtelReceiveMoney } from '../services/hubtelService';
import { sanitizePhoneNumber, validatePhoneNumber } from '../utils/helpers';
import {
  getTemporaryUnlockOffer,
  PAID_UNLOCK_CHANNEL,
  requestTemporaryUnlock,
  TemporaryUnlockError,
} from '../services/paidUnlockService';
import { postRecordedPayment } from './paymentController';

/**
 * Paid temporary unlock for customers (the app) and for staff taking cash at
 * the office. The USSD channel lives with the rest of the short code in
 * paymentController. See paidUnlockService for the rules.
 */

const VALID_NETWORKS = ['MTN', 'VODAFONE', 'AIRTELTIGO'];

function refuse(res: Response, error: unknown): boolean {
  if (error instanceof TemporaryUnlockError) {
    res.status(error.status).json({ error: error.message });
    return true;
  }
  return false;
}

// ── Customer ────────────────────────────────────────────────────────────────

// POST /customer/me/contracts/:id/temporary-unlock { percent, network, phoneNumber, expectedAmount? }
export async function customerRequestTemporaryUnlock(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerUuid = req.user!.id;
    const { percent, network, phoneNumber, expectedAmount } = req.body || {};
    if (!percent || !network || !phoneNumber) {
      res.status(400).json({ error: 'Choose an option, a network and a phone number.' });
      return;
    }
    const net = String(network).toUpperCase();
    if (!VALID_NETWORKS.includes(net)) {
      res.status(400).json({ error: 'Invalid network. Must be MTN, VODAFONE, or AIRTELTIGO' });
      return;
    }
    const phone = sanitizePhoneNumber(String(phoneNumber));
    if (!validatePhoneNumber(phone)) {
      res.status(400).json({ error: 'Invalid phone number' });
      return;
    }

    // Loaded by the signed-in customer: someone else's contract is simply not found.
    const contract = await prisma.hirePurchaseContract.findFirst({
      where: { id: req.params.id, customerId_uuid: customerUuid },
      select: { id: true, contractNumber: true, customerId_uuid: true, customer: { select: { firstName: true, lastName: true, email: true } } },
    });
    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const { option, clientReference } = await requestTemporaryUnlock({
      contractId: contract.id,
      percent: Number(percent),
      channel: PAID_UNLOCK_CHANNEL.APP,
      expectedAmount: expectedAmount === undefined ? undefined : Number(expectedAmount),
    });

    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef: clientReference,
        contractId: contract.id,
        customerId_uuid: contract.customerId_uuid,
        amount: option.total,
        unlockFee: option.fee,
        paymentMethod: 'HUBTEL_MOMO',
        isAutoRetryEnabled: false, // never charged again later; see the USSD path
        mobileMoneyProvider: net,
        mobileMoneyNumber: phone,
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL',
          channel: 'APP',
          temporaryUnlock: { percent: option.percent, hours: option.hours, fee: option.fee },
        }),
      },
    });

    try {
      const hubtel = await initiateHubtelReceiveMoney({
        amount: option.total,
        customerName: `${contract.customer?.firstName ?? ''} ${contract.customer?.lastName ?? ''}`.trim() || 'Customer',
        customerPhone: phone,
        customerEmail: contract.customer?.email || undefined,
        network: net,
        description: `Temporary unlock for contract ${contract.contractNumber}`,
        transactionRef: clientReference,
      });
      await prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: { externalRef: hubtel.transactionId },
      });
    } catch (error: any) {
      // The request may have reached Hubtel before it failed, so the payment
      // stays PENDING for the status check to settle. Never "failed" here.
      console.error('Temporary unlock prompt error:', error?.message || error);
      res.status(202).json({
        message: 'We could not confirm the Mobile Money prompt was sent. If you approve a payment it will still open your phone. Otherwise please try again in a few minutes.',
        transactionRef: clientReference,
        amount: option.total,
        status: 'PENDING',
      });
      return;
    }

    res.json({
      message: 'Approve the Mobile Money prompt on your phone. Your phone opens as soon as the payment comes in.',
      transactionRef: clientReference,
      amount: option.total,
      fee: option.fee,
      hours: option.hours,
      status: 'PENDING',
    });
  } catch (error) {
    if (refuse(res, error)) return;
    console.error('Customer temporary unlock error:', error);
    res.status(500).json({ error: 'Failed to start the payment' });
  }
}

// ── Staff ───────────────────────────────────────────────────────────────────

async function staffContract(req: AuthenticatedRequest, res: Response) {
  const admin = req.user as AdminUserPayload;
  // Cash an agent holds keeps the phone locked until it is paid in, so taking
  // it for an unlock would open a phone the company has not been paid for.
  if (isSellingAgentRole(admin.role)) {
    res.status(403).json({ error: 'Agents cannot take cash for a temporary unlock. The customer can pay on the short code or at the office.' });
    return null;
  }
  const contract = await prisma.hirePurchaseContract.findUnique({
    where: { id: req.params.id },
    select: { id: true, contractNumber: true, createdById: true, customerId_uuid: true },
  });
  if (!contract) {
    res.status(404).json({ error: 'Contract not found' });
    return null;
  }
  if (!scopeAllows(await resolveContractScope(admin), contract.createdById)) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return { admin, contract };
}

// GET /contracts/:id/temporary-unlock-offer
export async function getStaffTemporaryUnlockOffer(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const ctx = await staffContract(req, res);
    if (!ctx) return;
    res.json({ offer: await getTemporaryUnlockOffer(ctx.contract.id) });
  } catch (error) {
    console.error('Get temporary unlock offer error:', error);
    res.status(500).json({ error: 'Failed to load the temporary unlock offer' });
  }
}

// POST /contracts/:id/temporary-unlock-offer { percent, expectedAmount? } — cash taken at the office
export async function takeCashForTemporaryUnlock(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const ctx = await staffContract(req, res);
    if (!ctx) return;
    const { percent, expectedAmount } = req.body || {};
    if (!percent) {
      res.status(400).json({ error: 'Choose an option.' });
      return;
    }

    const { unlock, option, clientReference } = await requestTemporaryUnlock({
      contractId: ctx.contract.id,
      percent: Number(percent),
      channel: PAID_UNLOCK_CHANNEL.STAFF,
      requestedById: ctx.admin.id,
      expectedAmount: expectedAmount === undefined ? undefined : Number(expectedAmount),
    });

    // A cash payment under the unlock's own reference: posting it is what
    // opens the window (applyTemporaryUnlock inside the payment posting).
    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef: clientReference,
        contractId: ctx.contract.id,
        customerId_uuid: ctx.contract.customerId_uuid,
        amount: option.total,
        unlockFee: option.fee,
        paymentMethod: 'CASH',
        status: 'SUCCESS',
        paymentDate: new Date(),
        metadata: JSON.stringify({
          recordedBy: ctx.admin.id,
          notes: `Temporary unlock: ${option.percent}% of overdue for ${option.hours} hours${option.fee > 0 ? `, incl. GHS ${option.fee.toFixed(2)} charge` : ''}`,
          isManual: true,
          temporaryUnlock: { percent: option.percent, hours: option.hours, fee: option.fee },
        }),
      },
    });
    await postRecordedPayment(payment.id);

    await createAuditLog({
      userId: ctx.admin.id,
      action: 'RECORD_MANUAL_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: { transactionRef: clientReference, amount: option.total, unlockFee: option.fee, contractId: ctx.contract.id, paymentMethod: 'CASH', temporaryUnlockId: unlock.id },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const applied = await prisma.paidTemporaryUnlock.findUnique({ where: { id: unlock.id }, select: { status: true, expiresAt: true } });
    res.status(201).json({
      message: 'Cash recorded. The phone is opening now.',
      transactionRef: clientReference,
      amount: option.total,
      fee: option.fee,
      status: applied?.status,
      expiresAt: applied?.expiresAt,
      offer: await getTemporaryUnlockOffer(ctx.contract.id),
    });
  } catch (error) {
    if (refuse(res, error)) return;
    console.error('Take cash for temporary unlock error:', error);
    res.status(500).json({ error: 'Failed to record the payment' });
  }
}
