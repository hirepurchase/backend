import crypto from 'crypto';
import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import { payerEmail } from '../services/gateways';
import {
  isPaystackConfigured,
  lookupCharge,
  normaliseNetwork,
  paystackKeyMode,
  refundCharge,
  startMobileMoneyCharge,
  submitOtp,
  toPesewas,
} from '../services/gateways/paystack';
import { sanitizePhoneNumber, validatePhoneNumber, roundMoney } from '../utils/helpers';

/**
 * The Paystack test page (super admins). Sends a small real charge that
 * belongs to no contract, customer or agent: nothing here is ever credited.
 * Its reference starts with TEST_PREFIX, which the webhook recognises and
 * records instead of routing, so the page can show that Paystack's
 * notifications reach us and what they contain.
 *
 * Everything is kept in the audit trail: the charge (PAYSTACK_TEST_CHARGE),
 * every webhook for it (PAYSTACK_TEST_EVENT) and refunds (PAYSTACK_TEST_REFUND).
 */

export const TEST_PREFIX = 'PSTEST';
const MIN_AMOUNT = 0.1;
const MAX_AMOUNT = 5;

export function isTestReference(reference: string | null | undefined): boolean {
  return !!reference && reference.startsWith(TEST_PREFIX);
}

function superAdmin(req: AuthenticatedRequest, res: Response): AdminUserPayload | null {
  const admin = req.user as AdminUserPayload;
  if (req.userType !== 'admin' || admin?.role !== 'SUPER_ADMIN') {
    res.status(403).json({ error: 'Super admin access required' });
    return null;
  }
  if (!isPaystackConfigured()) {
    res.status(400).json({ error: 'Paystack is not set up on the server yet: add PAYSTACK_SECRET_KEY first.' });
    return null;
  }
  return admin;
}

function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length >= 6 ? `${d.slice(0, 3)}****${d.slice(-3)}` : '****';
}

function parse(json: string | null): Record<string, any> {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

// POST /settings/payment-gateway/test/charge { amount, phoneNumber, network }
export async function startTestCharge(req: AuthenticatedRequest, res: Response): Promise<void> {
  const admin = superAdmin(req, res);
  if (!admin) return;
  try {
    const amount = roundMoney(Number(req.body?.amount));
    if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
      res.status(400).json({ error: `A test payment must be between GHS ${MIN_AMOUNT.toFixed(2)} and GHS ${MAX_AMOUNT.toFixed(2)}.` });
      return;
    }
    const network = normaliseNetwork(String(req.body?.network || ''));
    if (!network) {
      res.status(400).json({ error: 'Choose MTN, Telecel or AirtelTigo.' });
      return;
    }
    const phone = sanitizePhoneNumber(String(req.body?.phoneNumber || ''));
    if (!validatePhoneNumber(phone)) {
      res.status(400).json({ error: 'Enter a valid Mobile Money number.' });
      return;
    }

    const reference = `${TEST_PREFIX}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const me = await prisma.adminUser.findUnique({ where: { id: admin.id }, select: { email: true } });
    await createAuditLog({
      userId: admin.id,
      action: 'PAYSTACK_TEST_CHARGE',
      entity: 'PaystackTest',
      entityId: reference,
      newValues: { reference, amount, network, phone: maskPhone(phone), keyMode: paystackKeyMode() },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    // Paystack's answer is kept with the test, so a refusal can be read later.
    const keep = (state: string, message: string) =>
      createAuditLog({
        userId: admin.id,
        action: 'PAYSTACK_TEST_RESULT',
        entity: 'PaystackTest',
        entityId: reference,
        newValues: { reference, step: 'start', state, message: String(message).slice(0, 500) },
      }).catch(() => undefined);

    let start;
    try {
      start = await startMobileMoneyCharge({
        reference,
        amount,
        phone,
        network,
        email: payerEmail(me?.email, `test${admin.id}`),
        metadata: { kind: 'TEST', note: 'Paystack test page: not linked to any contract' },
      });
    } catch (error: any) {
      const message = `No clear answer from Paystack: ${error?.message || error}. The page will keep checking.`;
      await keep('UNKNOWN', message);
      // It may still have reached Paystack: the page keeps checking.
      res.status(202).json({ reference, state: 'UNKNOWN', message });
      return;
    }
    await keep(start.state, start.message);
    res.json({ reference, state: start.state, message: start.message, externalRef: start.externalRef, amount, network });
  } catch (error: any) {
    console.error('Paystack test charge error:', error?.message || error);
    res.status(500).json({ error: 'Could not start the test payment' });
  }
}

// POST /settings/payment-gateway/test/:reference/otp { otp }
export async function submitTestOtp(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!superAdmin(req, res)) return;
  const reference = req.params.reference;
  if (!isTestReference(reference)) {
    res.status(400).json({ error: 'Not a test payment.' });
    return;
  }
  const otp = String(req.body?.otp ?? '').trim();
  if (!/^\d{4,8}$/.test(otp)) {
    res.status(400).json({ error: 'Enter the code from the SMS.' });
    return;
  }
  try {
    const result = await submitOtp(reference, otp);
    await createAuditLog({
      action: 'PAYSTACK_TEST_RESULT',
      entity: 'PaystackTest',
      entityId: reference,
      newValues: { reference, step: 'otp', state: result.state, message: String(result.message).slice(0, 500) },
    }).catch(() => undefined);
    res.json({ reference, state: result.state, message: result.message });
  } catch (error: any) {
    res.status(502).json({ error: error?.message || 'Could not reach Paystack' });
  }
}

// GET /settings/payment-gateway/test/:reference — what Paystack says, and which webhooks arrived
export async function getTestCharge(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!superAdmin(req, res)) return;
  const reference = req.params.reference;
  if (!isTestReference(reference)) {
    res.status(400).json({ error: 'Not a test payment.' });
    return;
  }
  try {
    const rows = await prisma.auditLog.findMany({
      where: { entityId: reference, action: { in: ['PAYSTACK_TEST_CHARGE', 'PAYSTACK_TEST_EVENT', 'PAYSTACK_TEST_REFUND', 'PAYSTACK_TEST_RESULT'] } },
      orderBy: { createdAt: 'asc' },
      select: { action: true, newValues: true, createdAt: true },
    });
    const charge = rows.find((r) => r.action === 'PAYSTACK_TEST_CHARGE');
    if (!charge) {
      res.status(404).json({ error: 'Test payment not found' });
      return;
    }
    const asked = parse(charge.newValues);
    let paystack: Record<string, unknown> | null = null;
    let lookupError: string | null = null;
    try {
      paystack = await lookupCharge(reference);
    } catch (error: any) {
      lookupError = error?.message || String(error);
    }
    const expected = toPesewas(Number(asked.amount));
    const requested = paystack ? Number(paystack.requested_amount ?? paystack.amount) : null;
    res.json({
      reference,
      asked: { ...asked, at: charge.createdAt },
      paystack,
      lookupError,
      amountMatches: paystack?.status === 'success' ? requested === expected && Number(paystack.amount) >= expected && paystack.currency === 'GHS' : null,
      events: rows.filter((r) => r.action === 'PAYSTACK_TEST_EVENT').map((r) => ({ at: r.createdAt, ...parse(r.newValues) })),
      refunds: rows.filter((r) => r.action === 'PAYSTACK_TEST_REFUND').map((r) => ({ at: r.createdAt, ...parse(r.newValues) })),
      answers: rows.filter((r) => r.action === 'PAYSTACK_TEST_RESULT').map((r) => ({ at: r.createdAt, ...parse(r.newValues) })),
    });
  } catch (error: any) {
    console.error('Paystack test lookup error:', error?.message || error);
    res.status(500).json({ error: 'Could not load the test payment' });
  }
}

// POST /settings/payment-gateway/test/:reference/refund — give the test money back
export async function refundTestCharge(req: AuthenticatedRequest, res: Response): Promise<void> {
  const admin = superAdmin(req, res);
  if (!admin) return;
  const reference = req.params.reference;
  if (!isTestReference(reference)) {
    res.status(400).json({ error: 'Only test payments can be refunded here.' });
    return;
  }
  try {
    const result = await refundCharge(reference, 'Paystack test page: test payment refunded');
    await createAuditLog({
      userId: admin.id,
      action: 'PAYSTACK_TEST_REFUND',
      entity: 'PaystackTest',
      entityId: reference,
      newValues: { reference, ok: result.ok, status: result.status, message: result.message },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.message });
      return;
    }
    res.json({ reference, status: result.status, message: result.message });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Could not request the refund' });
  }
}

// GET /settings/payment-gateway/test — recent test payments
export async function listTestCharges(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!superAdmin(req, res)) return;
  const rows = await prisma.auditLog.findMany({
    where: { action: 'PAYSTACK_TEST_CHARGE' },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { entityId: true, newValues: true, createdAt: true, user: { select: { firstName: true, lastName: true } } },
  });
  const refs = rows.map((r) => r.entityId).filter((x): x is string => !!x);
  const events = refs.length
    ? await prisma.auditLog.groupBy({ by: ['entityId'], where: { action: 'PAYSTACK_TEST_EVENT', entityId: { in: refs } }, _count: { _all: true } })
    : [];
  const eventCount = new Map(events.map((e) => [e.entityId, e._count._all]));
  res.json({
    tests: rows.map((r) => ({
      reference: r.entityId,
      at: r.createdAt,
      by: r.user ? `${r.user.firstName} ${r.user.lastName}`.trim() : null,
      ...parse(r.newValues),
      webhooks: eventCount.get(r.entityId) ?? 0,
    })),
  });
}

/**
 * Called by the webhook for a test reference: keep what arrived so the test
 * page can show it. The event's own fields are kept as names only (plus the
 * few values the test checks), so the audit trail never holds payer details.
 */
export async function recordTestEvent(reference: string, event: string, data: any): Promise<void> {
  const keys = (o: any) => (o && typeof o === 'object' ? Object.keys(o).sort() : []);
  await createAuditLog({
    action: 'PAYSTACK_TEST_EVENT',
    entity: 'PaystackTest',
    entityId: reference,
    newValues: {
      event,
      status: data?.status ?? null,
      amount: data?.amount ?? null,
      requested_amount: data?.requested_amount ?? null,
      fees: data?.fees ?? null,
      currency: data?.currency ?? null,
      channel: data?.channel ?? null,
      gateway_response: data?.gateway_response ?? null,
      transaction_reference: data?.transaction_reference ?? data?.transaction?.reference ?? null,
      fields: keys(data),
      transactionFields: keys(data?.transaction),
    },
  }).catch(() => undefined);
}
