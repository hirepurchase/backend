import prisma from '../../config/database';
import { createAuditLog } from '../auditService';
import { checkCharge, ChargeCheck, isPaystackConfigured } from './paystack';
import { failUssdRemittance, settleUssdRemittance } from '../agentDepositUssdService';
import { roundMoney } from '../../utils/helpers';

/**
 * Settling a payment once its gateway has answered, whichever path the answer
 * came by: webhook, the customer's screen polling, the sweep or the admin
 * reconcile. Each claims the row before posting, so two answers arriving
 * together credit it once.
 */

function mergeMetadata(raw: string | null | undefined, note: Record<string, unknown>): string {
  let base: Record<string, unknown> = {};
  try {
    base = raw ? JSON.parse(raw) : {};
  } catch {
    base = { previousMetadata: raw };
  }
  return JSON.stringify({ ...base, ...note });
}

/**
 * Record a customer payment's result. SUCCESS is claimed from PENDING or
 * FAILED (a success can arrive after a failure) and then posted: allocation,
 * contract totals, paid unlock, device. FAILED only ever replaces PENDING.
 * Returns whether this call changed the payment.
 */
export async function settleCustomerPayment(
  paymentId: string,
  outcome: 'SUCCESS' | 'FAILED',
  note: Record<string, unknown> = {},
  extra: { externalRef?: string | null; failureReason?: string | null; gatewayFee?: number | null } = {},
): Promise<boolean> {
  const claimed = await prisma.paymentTransaction.updateMany({
    // SUCCESS claims a waiting or failed payment only: a reversed one (refunded
    // or charged back) is never credited again by a late or repeated answer.
    where: outcome === 'SUCCESS' ? { id: paymentId, status: { in: ['PENDING', 'FAILED'] } } : { id: paymentId, status: 'PENDING' },
    data:
      outcome === 'SUCCESS'
        ? {
            status: 'SUCCESS',
            paymentDate: new Date(),
            failureReason: null,
            ...(extra.externalRef ? { externalRef: extra.externalRef } : {}),
            ...(extra.gatewayFee != null ? { gatewayFee: extra.gatewayFee } : {}),
          }
        : { status: 'FAILED', failureReason: (extra.failureReason || 'Payment failed').slice(0, 250) },
  });
  if (claimed.count === 0) return false;

  const row = await prisma.paymentTransaction.findUnique({ where: { id: paymentId }, select: { metadata: true } });
  await prisma.paymentTransaction.update({
    where: { id: paymentId },
    data: { metadata: mergeMetadata(row?.metadata, { ...note, settledAt: new Date().toISOString() }) },
  });

  if (outcome === 'SUCCESS') {
    // Imported when needed: the payment controller imports the gateways.
    const { postRecordedPayment } = await import('../../controllers/paymentController');
    await postRecordedPayment(paymentId);
  }
  return true;
}

async function auditMismatch(reference: string, check: ChargeCheck, expected: number, kind: string): Promise<void> {
  await createAuditLog({
    action: 'PAYSTACK_AMOUNT_MISMATCH',
    entity: kind,
    entityId: reference,
    newValues: { reference, expectedAmount: expected, paidMinor: check.amountMinor, currency: check.currency, status: check.status },
  }).catch(() => undefined);
}

// ── Customer payments ───────────────────────────────────────────────────────

type CustomerRow = { id: string; transactionRef: string; amount: number; status: string; createdAt: Date };

/** Ask Paystack about one customer payment and settle it if it is decided. */
export async function refreshPaystackCustomerPayment(payment: CustomerRow): Promise<ChargeCheck> {
  const check = await checkCharge(payment.transactionRef, payment.amount, payment.createdAt);
  if (check.outcome === 'SUCCESS') {
    await settleCustomerPayment(payment.id, 'SUCCESS', { paystackStatus: check.status }, { externalRef: check.externalRef, gatewayFee: check.feeGhs });
  } else if (check.outcome === 'FAILED') {
    if (check.mismatch) await auditMismatch(payment.transactionRef, check, payment.amount, 'PaymentTransaction');
    await settleCustomerPayment(
      payment.id,
      'FAILED',
      { paystackStatus: check.status },
      { failureReason: check.mismatch ? 'Paystack reported a different amount or currency; not credited' : `Paystack: ${check.message}` },
    );
  }
  return check;
}

// ── Agent deposits (web page) ───────────────────────────────────────────────

/** Ask Paystack about an agent deposit charge and settle or fail its rows. */
export async function refreshPaystackAgentCharge(reference: string): Promise<ChargeCheck | null> {
  const rows = await prisma.agentDepositPayment.findMany({
    where: { OR: [{ clientReference: reference }, { transactionRef: reference, clientReference: null }], gateway: 'PAYSTACK' },
    select: { amount: true, createdAt: true },
  });
  if (rows.length === 0) return null;
  const expected = roundMoney(rows.reduce((s, r) => s + r.amount, 0));
  const startedAt = rows.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), rows[0].createdAt);
  const check = await checkCharge(reference, expected, startedAt);
  if (check.outcome === 'SUCCESS') {
    await settleUssdRemittance(reference, check.externalRef);
    if (check.feeGhs != null) await recordAgentFee(reference, check.feeGhs);
  } else if (check.outcome === 'FAILED') {
    if (check.mismatch) await auditMismatch(reference, check, expected, 'AgentDepositPayment');
    await failUssdRemittance(reference, check.mismatch ? 'Paystack reported a different amount; not credited' : `Paystack: ${check.message}`);
  }
  return check;
}

/** Spread Paystack's fee over the rows of a charge, by amount (a web charge is one row). */
async function recordAgentFee(reference: string, feeGhs: number): Promise<void> {
  const rows = await prisma.agentDepositPayment.findMany({
    where: { OR: [{ clientReference: reference }, { transactionRef: reference, clientReference: null }], status: 'SUCCESS', gatewayFee: null },
    select: { id: true, amount: true },
    orderBy: { transactionRef: 'asc' },
  });
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (rows.length === 0 || total <= 0) return;
  let left = roundMoney(feeGhs);
  for (const [i, r] of rows.entries()) {
    const share = i === rows.length - 1 ? left : roundMoney((feeGhs * r.amount) / total);
    left = roundMoney(left - share);
    await prisma.agentDepositPayment.update({ where: { id: r.id }, data: { gatewayFee: share } });
  }
}

// ── The payer gives up (Cancel on the SMS-code step) ────────────────────────

/**
 * The payer stopped before paying. Ask the gateway first (Paystack), so a
 * charge that did go through is credited rather than cancelled; otherwise
 * mark it not paid, so it stops blocking another try. A success that still
 * arrives later lands as usual: settling claims failed rows.
 */
export async function cancelCustomerPayment(paymentId: string): Promise<'SUCCESS' | 'FAILED' | 'UNCHANGED'> {
  const payment = await prisma.paymentTransaction.findUnique({
    where: { id: paymentId },
    select: { id: true, transactionRef: true, amount: true, status: true, createdAt: true, gateway: true },
  });
  if (!payment || payment.status !== 'PENDING') return 'UNCHANGED';
  if (payment.gateway === 'PAYSTACK') {
    try {
      const check = await refreshPaystackCustomerPayment(payment);
      if (check.outcome !== 'PENDING') return check.outcome;
    } catch (error: any) {
      console.error(`[Paystack] cancel check ${payment.transactionRef}:`, error?.message || error);
    }
  }
  const done = await settleCustomerPayment(payment.id, 'FAILED', { cancelledByPayer: true }, { failureReason: 'Cancelled by the payer' });
  return done ? 'FAILED' : 'UNCHANGED';
}

/** As cancelCustomerPayment, for an agent's own web deposit charge. */
export async function cancelAgentCharge(reference: string, gateway: string): Promise<'SUCCESS' | 'FAILED' | 'UNCHANGED'> {
  if (gateway === 'PAYSTACK') {
    try {
      const check = await refreshPaystackAgentCharge(reference);
      if (check && check.outcome !== 'PENDING') return check.outcome;
    } catch (error: any) {
      console.error(`[Paystack] cancel check ${reference}:`, error?.message || error);
    }
  }
  return (await failUssdRemittance(reference, 'Cancelled by the payer')) > 0 ? 'FAILED' : 'UNCHANGED';
}

// ── Webhook routing ─────────────────────────────────────────────────────────

/**
 * A Paystack event named this reference. Its contents are never trusted: the
 * charge is looked up with Paystack and settled from that answer.
 */
export async function handlePaystackReference(reference: string): Promise<'CUSTOMER' | 'AGENT_DEPOSIT' | 'UNMATCHED'> {
  const payment = await prisma.paymentTransaction.findUnique({
    where: { transactionRef: reference },
    select: { id: true, transactionRef: true, amount: true, status: true, createdAt: true, gateway: true },
  });
  if (payment && payment.gateway === 'PAYSTACK') {
    if (payment.status === 'PENDING' || payment.status === 'FAILED') await refreshPaystackCustomerPayment(payment);
    return 'CUSTOMER';
  }
  if (await refreshPaystackAgentCharge(reference)) return 'AGENT_DEPOSIT';

  await createAuditLog({
    action: 'PAYSTACK_UNMATCHED',
    entity: 'PaymentTransaction',
    entityId: reference,
    newValues: { reference, note: 'Paystack reported a charge with no matching Paystack payment here' },
  }).catch(() => undefined);
  return 'UNMATCHED';
}

// ── Refunds reported by Paystack ────────────────────────────────────────────

/**
 * Paystack says money from one of our charges was refunded (from its
 * dashboard). Nothing is reversed automatically, since only staff know whether
 * the whole payment should stop counting: the payment is flagged and audited,
 * and a super admin reverses it (reverseGatewayPayment).
 */
export async function notePaystackRefund(reference: string, event: string, amountMinor: number | null): Promise<boolean> {
  const payment = await prisma.paymentTransaction.findUnique({
    where: { transactionRef: reference },
    select: { id: true, metadata: true, status: true, contractId: true, amount: true },
  });
  if (!payment) {
    await createAuditLog({
      action: 'PAYSTACK_REFUND_UNMATCHED',
      entity: 'PaymentTransaction',
      entityId: reference,
      newValues: { reference, event, amountMinor },
    }).catch(() => undefined);
    return false;
  }
  await prisma.paymentTransaction.update({
    where: { id: payment.id },
    data: {
      metadata: mergeMetadata(payment.metadata, {
        refundReported: { at: new Date().toISOString(), event, amount: amountMinor != null ? amountMinor / 100 : null },
      }),
    },
  });
  await createAuditLog({
    action: 'PAYSTACK_REFUND_REPORTED',
    entity: 'PaymentTransaction',
    entityId: payment.id,
    newValues: { reference, event, refundAmount: amountMinor != null ? amountMinor / 100 : null, paymentAmount: payment.amount, status: payment.status, contractId: payment.contractId },
  }).catch(() => undefined);
  return true;
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/** Paystack asks for at least ten seconds before a pending charge is checked. */
const SWEEP_AFTER_MS = 2 * 60_000;
const GIVE_UP_AFTER_MS = 48 * 3600_000;
const SWEEP_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * Customer payments sent through Paystack that are still waiting: ask about
 * each, settle what is decided, and give up on any still unknown after 48
 * hours. A success that turns up later still lands (it claims failed rows).
 */
export async function sweepPaystackCustomerPayments(now: Date = new Date()): Promise<{ checked: number; settled: number; failed: number }> {
  const rows = await prisma.paymentTransaction.findMany({
    where: {
      gateway: 'PAYSTACK',
      status: 'PENDING',
      createdAt: { lt: new Date(now.getTime() - SWEEP_AFTER_MS), gt: new Date(now.getTime() - SWEEP_WINDOW_MS) },
    },
    select: { id: true, transactionRef: true, amount: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  let settled = 0;
  let failed = 0;
  const giveUp = async (row: { id: string; createdAt: Date }) =>
    now.getTime() - row.createdAt.getTime() > GIVE_UP_AFTER_MS &&
    (await settleCustomerPayment(row.id, 'FAILED', {}, { failureReason: 'No confirmation from Paystack after 48 hours' }));
  // Without the key Paystack cannot be asked. Waiting payments are left alone
  // (a success may still be confirmed once the key is back) until 48 hours.
  if (!isPaystackConfigured()) {
    if (rows.length > 0) console.warn(`[PaystackSweep] ${rows.length} Paystack payment(s) waiting but PAYSTACK_SECRET_KEY is not set`);
    for (const row of rows) if (await giveUp(row)) failed++;
    return { checked: 0, settled, failed };
  }
  for (const row of rows) {
    try {
      const check = await refreshPaystackCustomerPayment(row);
      if (check.outcome === 'SUCCESS') settled++;
      else if (check.outcome === 'FAILED') failed++;
      else if (await giveUp(row)) failed++;
    } catch (error: any) {
      // Paystack unreachable for two days: stop treating it as waiting.
      if (await giveUp(row).catch(() => false)) failed++;
      else console.error(`[PaystackSweep] ${row.transactionRef}:`, error?.message || error);
    }
  }
  return { checked: rows.length, settled, failed };
}
