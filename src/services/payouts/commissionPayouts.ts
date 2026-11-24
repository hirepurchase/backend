/**
 * Paying commission into agents' and cluster leaders' Mobile Money wallets.
 *
 * A super admin sends an approved month's payouts from the system. Each one
 * becomes a CommissionTransfer through the payout gateway (Paystack or Hubtel,
 * chosen on the payment gateway settings page). The payout row is marked paid
 * only when its transfer succeeds, with the gateway reference, so the books
 * never say paid for money that did not leave.
 *
 * Safety:
 *  - only months that are APPROVED, only payouts still PENDING with money owed;
 *  - at most one transfer per payout queued, sending, pending or succeeded,
 *    decided under a row lock, so two clicks cannot pay twice;
 *  - a transfer is marked SENDING before the gateway is called; if the answer
 *    is lost, it is checked by our reference before anything is resent;
 *  - no payout number: skipped; a wallet in another name (or unknown to the
 *    network): sent only if the admin ticked that person.
 */
import crypto from 'crypto';
import prisma from '../../config/database';
import { createAuditLog } from '../auditService';
import * as paystack from '../gateways/paystack';
import { hubtelPayoutBlockReason, hubtelPayoutStatus, hubtelSendMoney, isHubtelPayoutReady } from './hubtelSendMoney';

const db = prisma as any;
const round2 = (n: number) => Math.round(n * 100) / 100;
const ACTIVE = ['QUEUED', 'SENDING', 'PENDING', 'SUCCESS'];
const MISMATCH_CHECKS = ['MISMATCH', 'NOT_REGISTERED'];

export type PayoutKind = 'AGENT_COMPLETION' | 'CLUSTER_LEADER';
export type PayoutGateway = 'PAYSTACK' | 'HUBTEL';

export class PayoutError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const KIND = {
  AGENT_COMPLETION: { period: 'agentCompletionPayPeriod', payout: 'agentCompletionPayout', table: 'AgentCompletionPayout', person: 'agentId', label: 'Completion commission' },
  CLUSTER_LEADER: { period: 'clusterScorecardPeriod', payout: 'clusterPayout', table: 'ClusterPayout', person: 'clusterAgentId', label: 'Cluster leader pay' },
} as const;

export function asKind(value: string): PayoutKind {
  const k = String(value || '').toUpperCase();
  if (k === 'AGENT_COMPLETION' || k === 'CLUSTER_LEADER') return k;
  throw new PayoutError('Unknown payout type', 404);
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

// ---------------------------------------------------------------- gateway

export async function getPayoutGateway(): Promise<PayoutGateway> {
  const row = await db.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { payoutGateway: true } });
  return row?.payoutGateway === 'HUBTEL' ? 'HUBTEL' : 'PAYSTACK';
}

export async function setPayoutGateway(gateway: PayoutGateway, adminId: string): Promise<void> {
  if (gateway === 'HUBTEL' && !isHubtelPayoutReady()) throw new PayoutError(hubtelPayoutBlockReason() || 'Hubtel payouts are not ready');
  if (gateway === 'PAYSTACK' && !paystack.isPaystackConfigured()) throw new PayoutError('No Paystack secret key is set on the server.');
  const row = await db.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, payoutGateway: true } });
  if (row) await db.paymentGatewaySettings.update({ where: { id: row.id }, data: { payoutGateway: gateway, updatedById: adminId } });
  else await db.paymentGatewaySettings.create({ data: { payoutGateway: gateway, updatedById: adminId } });
  await createAuditLog({ userId: adminId, action: 'SET_PAYOUT_GATEWAY', entity: 'PaymentGatewaySettings', oldValues: { payoutGateway: row?.payoutGateway ?? null }, newValues: { payoutGateway: gateway } });
}

export function gatewayBlock(gateway: PayoutGateway): string | null {
  if (gateway === 'HUBTEL') return hubtelPayoutBlockReason();
  return paystack.isPaystackConfigured() ? null : 'No Paystack secret key is set on the server.';
}

export async function gatewayBalance(gateway: PayoutGateway): Promise<number | null> {
  if (gateway === 'PAYSTACK' && paystack.isPaystackConfigured()) return paystack.getGhsBalance();
  return null; // Hubtel balance: not available until its documentation is confirmed
}

// ---------------------------------------------------------------- the list

export interface PayableLine {
  payoutId: string;
  recipientId: string;
  name: string;
  amount: number;
  payoutStatus: 'PENDING' | 'PAID';
  payout: { number: string; network: string | null; registeredName: string | null; check: string | null } | null;
  /** Why it cannot be sent, or null. */
  block: string | null;
  needsConfirm: boolean;
  transfer: { id: string; status: string; gateway: string; reference: string; failureReason: string | null; updatedAt: Date } | null;
}

export async function listPayable(kindValue: string, month: string) {
  const kind = asKind(kindValue);
  const k = KIND[kind];
  const period = await db[k.period].findUnique({ where: { month } });
  const gateway = await getPayoutGateway();
  const base = { kind, month, gateway, gatewayBlock: gatewayBlock(gateway), approved: period?.status === 'APPROVED' };
  if (!period) return { ...base, lines: [] as PayableLine[], balance: null, total: 0 };
  let payouts = await db[k.payout].findMany({ where: { periodId: period.id, total: { gt: 0 } } });
  const people = await db.adminUser.findMany({
    where: { id: { in: payouts.map((p: any) => p[k.person]) } },
    select: { id: true, firstName: true, lastName: true, payoutMomoNumber: true, payoutMomoNetwork: true, payoutMomoName: true, payoutMomoCheck: true },
  });
  const byId = new Map(people.map((p: any) => [p.id, p]));
  // While someone watches the list, ask the gateway about anything waiting more
  // than 20 seconds, so it updates even if a notification never arrives.
  const waitingRows = await db.commissionTransfer.findMany({
    where: { kind, payoutId: { in: payouts.map((p: any) => p.id) }, status: { in: ['SENDING', 'PENDING'] }, updatedAt: { lt: new Date(Date.now() - 20_000) } },
    take: 20,
  });
  for (const t of waitingRows) {
    try { await recheck(t); } catch (err) { console.warn('Payout recheck failed', t.reference, (err as Error)?.message || err); }
  }
  if (waitingRows.length) payouts = await db[k.payout].findMany({ where: { periodId: period.id, total: { gt: 0 } } });
  const transfers = await db.commissionTransfer.findMany({ where: { kind, payoutId: { in: payouts.map((p: any) => p.id) } }, orderBy: { createdAt: 'desc' } });
  const latest = new Map<string, any>();
  for (const t of transfers) if (!latest.has(t.payoutId)) latest.set(t.payoutId, t);

  const lines: PayableLine[] = payouts.map((p: any) => {
    const who: any = byId.get(p[k.person]);
    const t = latest.get(p.id);
    const payout = who?.payoutMomoNumber
      ? { number: who.payoutMomoNumber, network: who.payoutMomoNetwork, registeredName: who.payoutMomoName, check: who.payoutMomoCheck }
      : null;
    let block: string | null = null;
    if (p.status === 'PAID') block = 'Already paid';
    else if (t && ACTIVE.includes(t.status)) block = t.status === 'SUCCESS' ? 'Already paid' : 'Payment in progress';
    else if (!payout) block = 'No payout number';
    return {
      payoutId: p.id,
      recipientId: p[k.person],
      name: who ? `${who.firstName} ${who.lastName}`.trim() : 'Former user',
      amount: p.total,
      payoutStatus: p.status === 'PAID' ? 'PAID' : 'PENDING',
      payout,
      block,
      needsConfirm: !!payout && MISMATCH_CHECKS.includes(payout.check || ''),
      transfer: t ? { id: t.id, status: t.status, gateway: t.gateway, reference: t.reference, failureReason: t.failureReason, updatedAt: t.updatedAt } : null,
    };
  });
  lines.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const total = round2(lines.filter((l) => !l.block).reduce((s, l) => s + l.amount, 0));
  return { ...base, lines, balance: await gatewayBalance(gateway), total };
}

// ---------------------------------------------------------------- sending

export async function sendPayouts(params: {
  kind: string;
  month: string;
  items: Array<{ payoutId: string; confirmMismatch?: boolean }>;
  adminId: string;
}) {
  const kind = asKind(params.kind);
  const k = KIND[kind];
  const period = await db[k.period].findUnique({ where: { month: params.month } });
  if (!period || period.status !== 'APPROVED') throw new PayoutError('Approve the month before sending payments.', 409);
  const gateway = await getPayoutGateway();
  const block = gatewayBlock(gateway);
  if (block) throw new PayoutError(block, 409);
  if (!params.items?.length) throw new PayoutError('Choose who to pay.');

  const created: string[] = [];
  const skipped: Array<{ payoutId: string; reason: string }> = [];
  let total = 0;
  for (const item of params.items) {
    try {
      const row = await db.$transaction(async (tx: any) => {
        await tx.$queryRawUnsafe(`SELECT id FROM "${k.table}" WHERE id = $1 FOR UPDATE`, item.payoutId);
        const p = await tx[k.payout].findUnique({ where: { id: item.payoutId } });
        if (!p || p.periodId !== period.id) throw new PayoutError('Not in this month');
        if (p.status === 'PAID') throw new PayoutError('Already paid');
        if (!(p.total > 0)) throw new PayoutError('Nothing owed');
        const active = await tx.commissionTransfer.findFirst({ where: { kind, payoutId: p.id, status: { in: ACTIVE } }, select: { id: true } });
        if (active) throw new PayoutError('Payment already in progress');
        const who = await tx.adminUser.findUnique({
          where: { id: p[k.person] },
          select: { firstName: true, lastName: true, payoutMomoNumber: true, payoutMomoNetwork: true, payoutMomoName: true, payoutMomoCheck: true },
        });
        if (!who?.payoutMomoNumber || !who.payoutMomoNetwork) throw new PayoutError('No payout number');
        const mismatch = MISMATCH_CHECKS.includes(who.payoutMomoCheck || '');
        if (mismatch && !item.confirmMismatch) throw new PayoutError('Wallet in a different name — tick to confirm');
        return tx.commissionTransfer.create({
          data: {
            kind, month: params.month, payoutId: p.id, recipientId: p[k.person], amount: round2(p.total), gateway,
            phone: who.payoutMomoNumber, network: who.payoutMomoNetwork, registeredName: who.payoutMomoName, nameCheck: who.payoutMomoCheck,
            confirmedMismatch: mismatch, reference: `comm-${kind === 'AGENT_COMPLETION' ? 'ag' : 'cl'}-${params.month}-${crypto.randomUUID().replace(/-/g, '')}`,
            status: 'QUEUED', initiatedById: params.adminId,
          },
        });
      });
      created.push(row.id);
      total = round2(total + row.amount);
    } catch (err) {
      skipped.push({ payoutId: item.payoutId, reason: err instanceof PayoutError ? err.message : 'Could not queue' });
      if (!(err instanceof PayoutError)) console.error('Payout queue error:', err);
    }
  }

  // Refuse the whole batch if the balance plainly cannot cover it.
  if (created.length) {
    const balance = await gatewayBalance(gateway);
    if (balance !== null && balance + 0.005 < total) {
      await db.commissionTransfer.updateMany({ where: { id: { in: created } }, data: { status: 'FAILED', failureReason: `Not enough in the ${gateway} balance (GHS ${balance.toFixed(2)} for GHS ${total.toFixed(2)})`, completedAt: new Date() } });
      throw new PayoutError(`Not enough in the ${gateway === 'PAYSTACK' ? 'Paystack' : 'Hubtel'} balance: GHS ${balance.toFixed(2)} available, GHS ${total.toFixed(2)} needed. Top it up and send again.`, 409);
    }
  }

  await createAuditLog({
    userId: params.adminId,
    action: 'SEND_COMMISSION_PAYOUTS',
    entity: 'CommissionTransfer',
    entityId: `${kind}:${params.month}`,
    newValues: { kind, month: params.month, gateway, queued: created.length, total, skipped },
  });

  // In the background, one after another; the page follows progress.
  if (created.length) setImmediate(() => { void processTransfers(created); });
  return { queued: created.length, total, skipped, gateway };
}

let running = false;
const waiting = new Set<string>();

/** Sends queued transfers one at a time. Safe to call repeatedly. */
export async function processTransfers(ids: string[]): Promise<void> {
  ids.forEach((id) => waiting.add(id));
  if (running) return;
  running = true;
  try {
    while (waiting.size) {
      const id = waiting.values().next().value as string;
      waiting.delete(id);
      try {
        await sendOne(id);
      } catch (err) {
        console.error('Payout send error:', id, err);
      }
    }
  } finally {
    running = false;
  }
}

async function sendOne(id: string): Promise<void> {
  // Claim it: only a QUEUED transfer is sent, once.
  const claimed = await db.commissionTransfer.updateMany({ where: { id, status: 'QUEUED' }, data: { status: 'SENDING' } });
  if (claimed.count === 0) return;
  const t = await db.commissionTransfer.findUnique({ where: { id } });
  const reason = `${KIND[t.kind as PayoutKind].label} ${monthLabel(t.month)}`;
  try {
    if (t.gateway === 'PAYSTACK') {
      const recipient = await paystackRecipientFor(t);
      const r = await paystack.initiateTransfer({ amount: t.amount, recipientCode: recipient, reference: t.reference, reason });
      if (r.state === 'OTP') {
        await finish(t, 'FAILED', 'Paystack is asking for a one-time code for transfers. Switch off "Confirm transfers with OTP" in the Paystack dashboard, then send again.', r.transferCode);
      } else {
        await applyState(t, r.state, r.message, r.transferCode);
      }
    } else {
      const r = await hubtelSendMoney({ amount: t.amount, phone: t.phone, network: t.network, name: t.registeredName || 'Commission', reference: t.reference, description: reason });
      await applyState(t, r.state, r.message, r.externalRef);
    }
  } catch (err: any) {
    // No answer: leave it SENDING; the sweep checks by reference before anything is resent.
    console.warn('Payout: no answer from gateway, will check by reference', t.reference, err?.message || err);
    await db.commissionTransfer.update({ where: { id }, data: { failureReason: 'Waiting to confirm with the gateway' } });
  }
}

async function paystackRecipientFor(t: any): Promise<string> {
  const u = await db.adminUser.findUnique({ where: { id: t.recipientId }, select: { firstName: true, lastName: true, payoutPaystackRecipient: true, payoutPaystackRecipientKey: true } });
  const key = `${t.phone}|${t.network}`;
  if (u?.payoutPaystackRecipient && u.payoutPaystackRecipientKey === key) return u.payoutPaystackRecipient;
  const code = await paystack.createMobileMoneyRecipient({
    name: t.registeredName || `${u?.firstName ?? ''} ${u?.lastName ?? ''}`.trim() || 'Commission',
    phone: t.phone,
    network: t.network,
    description: `Commission payouts (${t.recipientId})`,
  });
  await db.adminUser.update({ where: { id: t.recipientId }, data: { payoutPaystackRecipient: code, payoutPaystackRecipientKey: key } });
  return code;
}

async function applyState(t: any, state: string, message: string, externalRef: string | null): Promise<void> {
  if (state === 'SUCCESS') return finish(t, 'SUCCESS', null, externalRef);
  if (state === 'FAILED' || state === 'REVERSED') return finish(t, state, message || 'The gateway refused the payment', externalRef);
  await db.commissionTransfer.update({ where: { id: t.id }, data: { status: 'PENDING', externalRef: externalRef ?? t.externalRef, failureReason: null } });
}

/** The end of a transfer. Success marks the payout paid; a reversal after success unmarks it. */
async function finish(t: any, status: 'SUCCESS' | 'FAILED' | 'REVERSED', failureReason: string | null, externalRef: string | null): Promise<void> {
  const k = KIND[t.kind as PayoutKind];
  const was = t.status;
  await db.$transaction(async (tx: any) => {
    await tx.commissionTransfer.update({
      where: { id: t.id },
      data: { status, failureReason, externalRef: externalRef ?? t.externalRef, completedAt: new Date() },
    });
    if (status === 'SUCCESS') {
      await tx[k.payout].updateMany({
        where: { id: t.payoutId, status: { not: 'PAID' } },
        data: { status: 'PAID', paidAt: new Date(), paidById: t.initiatedById, reference: `${t.gateway} ${externalRef ?? t.reference}`.slice(0, 100) },
      });
    } else if (status === 'REVERSED' && was === 'SUCCESS') {
      await tx[k.payout].updateMany({ where: { id: t.payoutId }, data: { status: 'PENDING', paidAt: null, paidById: null, reference: null } });
    }
  });
  await createAuditLog({
    userId: t.initiatedById,
    action: status === 'SUCCESS' ? 'COMMISSION_PAYOUT_SENT' : status === 'REVERSED' ? 'COMMISSION_PAYOUT_REVERSED' : 'COMMISSION_PAYOUT_FAILED',
    entity: 'CommissionTransfer',
    entityId: t.id,
    newValues: { kind: t.kind, month: t.month, recipientId: t.recipientId, amount: t.amount, gateway: t.gateway, phone: `${t.phone.slice(0, 3)}****${t.phone.slice(-3)}`, reference: t.reference, externalRef, failureReason },
  });
}

// ---------------------------------------------------------------- results coming back

/** Paystack webhook (transfer.success / transfer.failed / transfer.reversed): never trusted, re-checked. */
export async function handlePaystackTransferEvent(reference: string): Promise<boolean> {
  const t = await db.commissionTransfer.findUnique({ where: { reference } });
  if (!t) return false;
  await recheck(t);
  return true;
}

export async function handleHubtelPayoutCallback(reference: string): Promise<boolean> {
  const t = await db.commissionTransfer.findUnique({ where: { reference } });
  if (!t) return false;
  await recheck(t);
  return true;
}

async function recheck(t: any): Promise<void> {
  if (['FAILED'].includes(t.status)) return;
  if (t.gateway === 'PAYSTACK') {
    const v = await paystack.verifyTransfer(t.reference);
    if (v.state === 'NOT_FOUND') {
      // Paystack never received it. Only safe to call failed once we stopped waiting for an answer.
      if (t.status === 'SENDING' && Date.now() - new Date(t.updatedAt).getTime() > 5 * 60_000) {
        await finish(t, 'FAILED', 'Paystack did not receive the payment; nothing was sent. Send again.', null);
      }
      return;
    }
    if (v.amountMinor !== null && v.amountMinor !== paystack.toPesewas(t.amount)) {
      console.error('Payout amount mismatch', t.reference, v.amountMinor, t.amount);
    }
    if (v.state === 'SUCCESS' && t.status !== 'SUCCESS') return finish(t, 'SUCCESS', null, v.transferCode);
    if (v.state === 'REVERSED' && t.status !== 'REVERSED') return finish(t, 'REVERSED', v.message || 'Reversed by Paystack', v.transferCode);
    if (v.state === 'FAILED' && t.status !== 'SUCCESS') return finish(t, 'FAILED', v.message || 'Paystack could not complete the payment', v.transferCode);
    if (v.state === 'PENDING' && t.status === 'SENDING') {
      await db.commissionTransfer.update({ where: { id: t.id }, data: { status: 'PENDING', externalRef: v.transferCode ?? t.externalRef, failureReason: null } });
    }
    return;
  }
  const h = await hubtelPayoutStatus(t.reference);
  if (h.state === 'NOT_FOUND') {
    if (t.status === 'SENDING' && Date.now() - new Date(t.updatedAt).getTime() > 5 * 60_000) {
      await finish(t, 'FAILED', 'Hubtel did not receive the payment; nothing was sent. Send again.', null);
    }
    return;
  }
  if (h.state === 'SUCCESS' && t.status !== 'SUCCESS') return finish(t, 'SUCCESS', null, h.externalRef);
  if (h.state === 'FAILED' && t.status !== 'SUCCESS') return finish(t, 'FAILED', h.message || 'Hubtel could not complete the payment', h.externalRef);
  if (h.state === 'PENDING' && t.status === 'SENDING') await db.commissionTransfer.update({ where: { id: t.id }, data: { status: 'PENDING' } });
}

/** Every few minutes: re-check unfinished transfers and pick up any left queued by a restart. */
export async function sweepCommissionTransfers(): Promise<{ checked: number; resumed: number }> {
  const twoMinAgo = new Date(Date.now() - 2 * 60_000);
  const queued = await db.commissionTransfer.findMany({ where: { status: 'QUEUED', updatedAt: { lt: twoMinAgo } }, select: { id: true } });
  if (queued.length) void processTransfers(queued.map((q: any) => q.id));
  const open = await db.commissionTransfer.findMany({ where: { status: { in: ['SENDING', 'PENDING'] }, updatedAt: { lt: twoMinAgo } }, take: 100 });
  let checked = 0;
  for (const t of open) {
    try {
      await recheck(t);
      checked++;
    } catch (err) {
      console.warn('Payout recheck failed', t.reference, (err as Error)?.message || err);
    }
  }
  return { checked, resumed: queued.length };
}

/** Whether a payout row has money sent or on its way, so "Mark as paid" by hand is refused. */
export async function transferBlocksManualPay(kind: PayoutKind, payoutId: string): Promise<string | null> {
  const t = await db.commissionTransfer.findFirst({ where: { kind, payoutId, status: { in: ACTIVE } }, select: { status: true } });
  if (!t) return null;
  return t.status === 'SUCCESS' ? 'This was paid through the system; it cannot be changed by hand.' : 'A payment to this person is in progress.';
}
