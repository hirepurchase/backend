import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { formatPhoneForHubtel, HUBTEL_AGENT_DEPOSIT_CALLBACK_URL } from '../services/hubtelService';
import { gatewayFor, payerEmail, startPrompt, StartPromptResult, paystack as paystackGateway } from '../services/gateways';
import { cancelAgentCharge, refreshPaystackAgentCharge } from '../services/gateways/settle';
import { generateTransactionRef } from '../utils/helpers';
import { requestManagedDeviceUnlock } from '../services/deviceControlPolicyService';
import { unlockKnoxGuardDevice } from '../services/knoxGuardService';
import { SELLING_AGENT_ROLES } from '../constants/roles';
import { notifyPayTrigger } from '../services/payTrigger/events';
import { accrueCompletionCommission } from '../services/completionCommissionService';
import { failUssdRemittance, hasAgentDepositCharge, payableOnLedger, settleUssdRemittance } from '../services/agentDepositUssdService';
import { issuePaymentPin } from '../services/agentPinService';
import { isSellingAgentRole } from '../constants/roles';
import { createAuditLog } from '../services/auditService';
import { validateWebhookRequest } from '../utils/callbackSecurity';

// Unlock the device for a contract after agent deposit is fully paid.
// Priority order:
//   1. ManagedDevice linked via contractId  → requestManagedDeviceUnlock (Knox + DB update)
//   2. ManagedDevice linked via inventoryItemId only (standalone Knox enrollment) → Knox unlock directly
//   3. No Knox enrollment at all → update inventoryItem lockStatus only
export async function unlockDeviceAfterDepositPaid(contractId: string, logPrefix: string): Promise<void> {
  notifyPayTrigger(contractId, 'DEPOSIT_REMITTED');
  try {
    await requestManagedDeviceUnlock(contractId, 'Agent deposit fully remitted — device unlocked.');
  } catch (err: any) {
    if (err?.message !== 'Managed device not found for contract') {
      console.error(`[${logPrefix}] Failed to unlock device for contract ${contractId}:`, err);
      return;
    }

    // No ManagedDevice via contractId — check if inventory item has a standalone Knox device
    const inventoryItem = await prisma.inventoryItem.findFirst({ where: { contractId } });
    if (!inventoryItem) return;

    const standaloneMd = await (prisma as any).managedDevice.findFirst({
      where: { inventoryItemId: inventoryItem.id },
    });

    if (standaloneMd) {
      // Standalone Knox-enrolled device — call Knox directly
      const message = 'Agent deposit fully remitted — device unlocked.';
      let result = await unlockKnoxGuardDevice({ deviceUid: standaloneMd.deviceUid, objectId: standaloneMd.knoxObjectId, message });
      for (let attempt = 2; attempt <= 3 && !result.success && !result.dryRun; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        result = await unlockKnoxGuardDevice({ deviceUid: standaloneMd.deviceUid, objectId: standaloneMd.knoxObjectId, message });
      }
      const nextState = result.success || result.dryRun ? 'UNLOCKED' : standaloneMd.actualState;
      await (prisma as any).managedDevice.update({
        where: { id: standaloneMd.id },
        data: {
          desiredState: 'UNLOCKED',
          actualState: nextState,
          lastUnlockedAt: result.success || result.dryRun ? new Date() : undefined,
          lastEvaluatedAt: new Date(),
          lastSyncedAt: new Date(),
          lastKnoxAction: 'UNLOCK_DEVICE',
          lastTransactionId: result.transactionId || null,
          lastError: result.success || result.dryRun ? null : (result.error || 'Unlock failed'),
        },
      });
      await prisma.inventoryItem.update({ where: { id: inventoryItem.id }, data: { lockStatus: nextState } });
      console.log(`[${logPrefix}] Standalone Knox unlock for contract ${contractId}: ${nextState} (txn: ${result.transactionId})`);
    } else {
      // No Knox device at all — just update the inventory lockStatus
      await prisma.inventoryItem.update({ where: { id: inventoryItem.id }, data: { lockStatus: 'UNLOCKED' } });
      console.log(`[${logPrefix}] No Knox device — inventoryItem ${inventoryItem.id} lockStatus set to UNLOCKED`);
    }
  }
}

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

    const ledgerEntry = await prisma.agentDepositLedger.create({
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

    // A Transsion phone is held locked until this row exists; tell PayTrigger
    // it now does, so a sale with nothing to remit opens without waiting for
    // the morning sweep. Returns at once for Samsung contracts.
    notifyPayTrigger(contract.id, 'CONTRACT_ACTIVE');

    // The part of the commission held until the customer completes, plus the
    // completion bonus. Records nothing while both are 0; never throws.
    await accrueCompletionCommission({
      contractId: contract.id,
      agentId: contract.createdById,
      ledgerEntryId: ledgerEntry.id,
      upfrontAmount: commissionAmount,
      deferredAmount: commissionSettings?.deferredAmount ?? 0,
      completionBonus: commissionSettings?.completionBonus ?? 0,
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
    const { amount, phoneNumber, network, otpCapable } = req.body;
    const admin = req.user as AdminUserPayload;

    if (!amount || !phoneNumber || !network) {
      res.status(400).json({ error: 'amount, phoneNumber, and network are required' });
      return;
    }

    // TELECEL is accepted and stored as VODAFONE, the name both gateways use.
    const net = paystackGateway.normaliseNetwork(String(network));
    if (!net) {
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

    // No duplicate pending payments, from the portal or the short code
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
    // The web page only; the short code always uses Hubtel.
    const gateway = await gatewayFor('AGENT_DEPOSIT', { otpCapable: otpCapable === true, network: net });

    // Create payment record
    const payment = await prisma.agentDepositPayment.create({
      data: {
        ledgerEntryId: id,
        agentId: admin.id,
        transactionRef,
        amount: payAmount,
        phoneNumber: formattedPhone,
        network: net,
        gateway,
        status: 'PENDING',
      },
    });

    // Fetch agent name for the prompt
    const agentUser = await prisma.adminUser.findUnique({
      where: { id: admin.id },
      select: { firstName: true, lastName: true, email: true },
    });
    const agentName = agentUser ? `${agentUser.firstName} ${agentUser.lastName}` : 'Agent';

    let result: StartPromptResult;
    try {
      result = await startPrompt({
        gateway,
        reference: transactionRef,
        amount: payAmount,
        phone: formattedPhone,
        network: net,
        payerName: agentName,
        email: payerEmail(agentUser?.email, `agent${admin.id}`),
        description: `Agent deposit remittance - Contract ${ledgerEntry.contractNumber}`,
        hubtelCallbackUrl: HUBTEL_AGENT_DEPOSIT_CALLBACK_URL,
        metadata: { kind: 'AGENT_DEPOSIT', contractNumber: ledgerEntry.contractNumber },
      });
    } catch (gatewayError: any) {
      if (gateway === 'PAYSTACK') {
        // It may have reached Paystack: left waiting for the webhook or the
        // sweep, never marked failed on a guess.
        res.status(202).json({
          message: 'We could not confirm the prompt was sent. If you approve a payment it will still be credited. Otherwise try again in a few minutes.',
          transactionRef,
          amount: payAmount,
          status: 'PENDING',
          otpRequired: false,
          gateway,
        });
        return;
      }
      await prisma.agentDepositPayment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: gatewayError.message || 'Hubtel initiation failed' },
      });
      throw gatewayError;
    }

    if (result.state === 'FAILED') {
      await failUssdRemittance(transactionRef, result.message || 'The payment could not be started');
      res.status(400).json({ error: result.message || 'The payment could not be started. Please try again.', transactionRef, status: 'FAILED' });
      return;
    }
    if (result.externalRef) {
      await prisma.agentDepositPayment.update({ where: { id: payment.id }, data: { hubtelRef: result.externalRef } });
    }
    if (result.state === 'SUCCESS') await confirmAgentSuccess(transactionRef, gateway, result.externalRef);

    res.status(200).json({
      // Paystack's own words when it has some: for MTN they can say how to
      // approve when no prompt pops up.
      message: gateway === 'PAYSTACK' && result.message ? result.message : 'Payment initiated. You will receive a prompt on your phone.',
      transactionRef,
      transactionId: result.externalRef,
      amount: payAmount,
      status: result.state === 'SUCCESS' ? 'SUCCESS' : 'PENDING',
      otpRequired: result.state === 'OTP_REQUIRED',
      gateway,
    });
  } catch (error: any) {
    console.error('payDeposit error:', error);
    res.status(500).json({ error: error.message || 'Failed to initiate payment' });
  }
}

/**
 * A gateway said "paid" in its direct answer. Paystack's is confirmed with the
 * webhook's lookup (amount checked, fee kept); Hubtel's is settled as it is.
 */
async function confirmAgentSuccess(reference: string, gateway: string, externalRef: string | null): Promise<void> {
  if (gateway !== 'PAYSTACK') {
    await settleUssdRemittance(reference, externalRef);
    return;
  }
  try {
    await refreshPaystackAgentCharge(reference);
  } catch (error: any) {
    console.error(`[Paystack] confirm agent deposit ${reference}:`, error?.message || error);
  }
}

/** The agent's own web deposit charge, by its reference. */
async function ownWebCharge(req: AuthenticatedRequest) {
  const admin = req.user as AdminUserPayload;
  const row = await prisma.agentDepositPayment.findUnique({
    where: { transactionRef: req.params.ref },
    select: { id: true, transactionRef: true, agentId: true, status: true, gateway: true, amount: true, createdAt: true, failureReason: true, channel: true },
  });
  return row && row.agentId === admin.id && row.channel === 'WEB' ? row : null;
}

// POST /agent-deposits/payments/:ref/otp { otp } — Telecel on Paystack
export async function submitAgentDepositOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const otp = String(req.body?.otp ?? '').trim();
    if (!/^\d{4,8}$/.test(otp)) {
      res.status(400).json({ error: 'Enter the code from the SMS.' });
      return;
    }
    const row = await ownWebCharge(req);
    if (!row) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    if (row.gateway !== 'PAYSTACK' || row.status !== 'PENDING') {
      res.status(400).json({ error: 'This payment is not waiting for a code.', status: row.status });
      return;
    }
    const result = await paystackGateway.submitOtp(row.transactionRef, otp);
    if (result.state === 'SUCCESS') await confirmAgentSuccess(row.transactionRef, 'PAYSTACK', result.externalRef);
    else if (result.state === 'FAILED') await failUssdRemittance(row.transactionRef, result.message);
    const now = (await prisma.agentDepositPayment.findUnique({ where: { id: row.id }, select: { status: true } }))?.status ?? 'PENDING';
    res.json({
      transactionRef: row.transactionRef,
      status: now,
      otpRequired: now === 'PENDING' && result.state === 'OTP_REQUIRED',
      message: result.message,
    });
  } catch (error: any) {
    console.error('submitAgentDepositOtp error:', error?.message || error);
    res.status(502).json({ error: 'Could not reach the payment service. Please try again.' });
  }
}

// POST /agent-deposits/payments/:ref/cancel — the agent gave up before paying.
// Checked with Paystack first, so a payment that went through is credited.
// Frees the sale for another try straight away instead of after 48 hours.
export async function cancelAgentDepositPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const row = await ownWebCharge(req);
    if (!row) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    if (row.status !== 'PENDING') {
      res.json({ transactionRef: row.transactionRef, status: row.status, message: 'Nothing to cancel.' });
      return;
    }
    const outcome = await cancelAgentCharge(row.transactionRef, row.gateway);
    const status = (await prisma.agentDepositPayment.findUnique({ where: { id: row.id }, select: { status: true } }))?.status ?? row.status;
    res.json({
      transactionRef: row.transactionRef,
      status,
      message: outcome === 'SUCCESS' ? 'This payment already went through.' : status === 'FAILED' ? 'Payment cancelled.' : 'Nothing to cancel.',
    });
  } catch (error: any) {
    console.error('cancelAgentDepositPayment error:', error?.message || error);
    res.status(500).json({ error: 'Could not cancel the payment' });
  }
}

const AGENT_POLL_GAP_MS = 10_000;
const lastAgentPoll = new Map<string, number>();

// GET /agent-deposits/payments/:ref/status — the web page waits on this
export async function getAgentDepositPaymentStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const row = await ownWebCharge(req);
    if (!row) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }
    let status = row.status;
    const last = lastAgentPoll.get(row.transactionRef) ?? 0;
    if (status === 'PENDING' && row.gateway === 'PAYSTACK' && Date.now() - last >= AGENT_POLL_GAP_MS && Date.now() - row.createdAt.getTime() >= AGENT_POLL_GAP_MS) {
      lastAgentPoll.set(row.transactionRef, Date.now());
      if (lastAgentPoll.size > 2000) lastAgentPoll.clear();
      try {
        await refreshPaystackAgentCharge(row.transactionRef);
        status = (await prisma.agentDepositPayment.findUnique({ where: { id: row.id }, select: { status: true } }))?.status ?? status;
      } catch (error: any) {
        console.error(`[Paystack] agent deposit status ${row.transactionRef}:`, error?.message || error);
      }
    }
    res.json({ transactionRef: row.transactionRef, status, amount: row.amount, gateway: row.gateway, failureReason: status === 'FAILED' ? row.failureReason : undefined });
  } catch (error) {
    console.error('getAgentDepositPaymentStatus error:', error);
    res.status(500).json({ error: 'Failed to check the payment' });
  }
}

// POST /agent-deposits/hubtel/callback  (no auth — called by Hubtel)
//
// Serves both the agent portal (one row per charge, keyed on transactionRef)
// and the short code (several rows sharing a clientReference), through the
// same settle and fail as the stuck-charge sweep. Every change is a claim — a
// conditional update on the status it expects — so a repeated or crossing
// callback acts once. A success that arrives after a failure still lands: the
// money was taken.
export async function handleAgentPaymentCallback(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    // The callback URL carries the shared webhook token (appendWebhookToken).
    // A success credits the ledger and can open a phone with no one
    // confirming it, so an unsigned call must not get that far.
    const webhookError = validateWebhookRequest(req);
    if (webhookError) {
      res.status(401).json({ error: webhookError });
      return;
    }

    const body = req.body;
    const reference = body?.Data?.ClientReference || body?.ClientReference;
    const responseCode = body?.Data?.ResponseCode || body?.ResponseCode;
    const externalRef = body?.Data?.TransactionId || body?.TransactionId;
    const failureReason = body?.Data?.ResponseMessage || body?.ResponseMessage || body?.Message || 'Payment failed';

    if (!reference) {
      res.status(400).json({ error: 'Missing transaction reference' });
      return;
    }

    const isSuccess = responseCode === '0000';

    if (!(await hasAgentDepositCharge(reference))) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    if (!isSuccess) {
      await failUssdRemittance(reference, failureReason);
      res.json({ message: 'Callback processed' });
      return;
    }

    if (!(await settleUssdRemittance(reference, externalRef))) {
      // Money reported for a reference with nothing we can credit. Leave a
      // trail for staff rather than guessing where it belongs.
      console.error(`[AgentDeposit] Success callback for ${reference} matched no remittance rows`);
      await createAuditLog({ action: 'AGENT_DEPOSIT_UNMATCHED', entity: 'AgentDepositPayment', entityId: reference, newValues: { reference, externalRef } });
      res.status(500).json({ error: 'No remittance to credit' });
      return;
    }

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

    // A short-code or portal charge still waiting is money already on its
    // way; recording cash over it would pay the same balance twice.
    const payable = await payableOnLedger(id);
    if (payAmount > payable + 0.005) {
      res.status(400).json({
        error: payable < ledgerEntry.outstandingBalance - 0.005
          ? `GHS ${(ledgerEntry.outstandingBalance - payable).toFixed(2)} is waiting for a Mobile Money payment. At most GHS ${payable.toFixed(2)} can be recorded now.`
          : `Amount exceeds outstanding balance of GHS ${ledgerEntry.outstandingBalance.toFixed(2)}`,
      });
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
          channel: 'MANUAL',
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

    // If fully paid, trigger device unlock (non-blocking)
    if (contractId) {
      const cid = contractId;
      setImmediate(() => { unlockDeviceAfterDepositPaid(cid, 'AdminManualPay'); });
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
      where: { role: { name: { in: [...SELLING_AGENT_ROLES] } } },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: { firstName: 'asc' },
    });

    res.json({ summary, agents });
  } catch (error) {
    console.error('getAdminSummary error:', error);
    res.status(500).json({ error: 'Failed to fetch admin summary' });
  }
}

// GET /agent-deposits/my-pin — the signed-in agent's own payment PIN, and
// nobody else's. Issues one if the agent somehow has none.
export async function getMyPaymentPin(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    if (req.userType !== 'admin' || !isSellingAgentRole(admin.role)) {
      res.status(403).json({ error: 'Only agents have a payment PIN.' });
      return;
    }
    const pin = await issuePaymentPin(admin.id);
    if (!pin) {
      res.status(403).json({ error: 'Only agents have a payment PIN.' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ pin });
  } catch (error) {
    console.error('getMyPaymentPin error:', error);
    res.status(500).json({ error: 'Failed to load your payment PIN' });
  }
}
