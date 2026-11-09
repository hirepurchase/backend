import prisma from '../config/database';
import { createAuditLog } from './auditService';
import { sendSMS } from './notificationService';
import { roundMoney } from '../utils/helpers';

/**
 * Agent deposits paid in on the short code.
 *
 * In this project AgentDepositPayment is both the remittance and the charge
 * record: PENDING is "waiting for payment", FAILED "not paid", SUCCESS
 * "confirmed". One short-code charge can pay in several sales, so its rows
 * share a clientReference (the Hubtel ClientReference) while each keeps its
 * own unique transactionRef.
 *
 * This is not a customer payment: nothing here writes a PaymentTransaction or
 * touches a contract's totals. The ledger is credited when the money arrives,
 * by the callback, with nobody confirming it.
 *
 * PENDING rows are money in flight. Everything that works out what can still
 * be paid in subtracts them, so a manual entry and a charge cannot cover the
 * same money twice.
 */

const COMPANY = 'AIDOO TECH';

export class AgentDepositError extends Error {}

export interface DepositToPay {
  ledgerId: string;
  contractId: string;
  contractNumber: string;
  customerName: string;
  createdAt: Date;
  payable: number;
}

/** Amount in flight (PENDING) per ledger row. */
async function inFlightByLedger(ledgerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (ledgerIds.length === 0) return map;
  const rows = await prisma.agentDepositPayment.groupBy({
    by: ['ledgerEntryId'],
    where: { ledgerEntryId: { in: ledgerIds }, status: 'PENDING' },
    _sum: { amount: true },
  });
  for (const r of rows) map.set(r.ledgerEntryId, roundMoney(r._sum.amount ?? 0));
  return map;
}

/** What can still be paid in on one ledger row: the balance less anything in flight. */
export async function payableOnLedger(ledgerId: string): Promise<number> {
  const ledger = await prisma.agentDepositLedger.findUnique({ where: { id: ledgerId }, select: { outstandingBalance: true, status: true } });
  if (!ledger || ledger.status !== 'PENDING') return 0;
  const inFlight = (await inFlightByLedger([ledgerId])).get(ledgerId) ?? 0;
  return Math.max(0, roundMoney(ledger.outstandingBalance - inFlight));
}

/** Unsettled sales, oldest first, each with what can still be paid in. Only those above 0. */
export async function agentDepositsToPay(agentId: string): Promise<DepositToPay[]> {
  const ledgers = await prisma.agentDepositLedger.findMany({
    where: { agentId, status: 'PENDING', outstandingBalance: { gt: 0 } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, contractId: true, contractNumber: true, customerName: true, createdAt: true, outstandingBalance: true },
  });
  const inFlight = await inFlightByLedger(ledgers.map((l) => l.id));
  return ledgers
    .map((l) => ({
      ledgerId: l.id,
      contractId: l.contractId,
      contractNumber: l.contractNumber,
      customerName: l.customerName,
      createdAt: l.createdAt,
      payable: Math.max(0, roundMoney(l.outstandingBalance - (inFlight.get(l.id) ?? 0))),
    }))
    .filter((l) => l.payable > 0.005);
}

/**
 * Open the remittance rows for a short-code charge, before the charge is made.
 * With a ledgerId the money goes to that sale; without, across every sale
 * oldest first. Throws when it is more than is owed.
 */
export async function openUssdRemittance(input: {
  agentId: string;
  amount: number;
  clientReference: string;
  phone: string;
  network: string;
  ledgerId?: string;
}): Promise<{ contractId: string; rows: number }> {
  const amount = roundMoney(input.amount);
  return prisma.$transaction(async (tx) => {
    // Serialise per agent so two sessions cannot both claim the same balance.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-deposit:${input.agentId}`}))`;
    const all = await agentDepositsToPayTx(tx, input.agentId);
    const targets = input.ledgerId ? all.filter((d) => d.ledgerId === input.ledgerId) : all;
    const owed = roundMoney(targets.reduce((s, d) => s + d.payable, 0));
    if (amount <= 0 || targets.length === 0 || amount > owed + 0.005) {
      throw new AgentDepositError('That is more than you owe. Please dial again.');
    }
    let left = amount;
    let n = 0;
    for (const d of targets) {
      if (left <= 0.005) break;
      const part = roundMoney(Math.min(left, d.payable));
      n++;
      await tx.agentDepositPayment.create({
        data: {
          ledgerEntryId: d.ledgerId,
          agentId: input.agentId,
          transactionRef: `${input.clientReference}-${n}`,
          clientReference: input.clientReference,
          channel: 'USSD',
          amount: part,
          phoneNumber: input.phone,
          network: input.network,
          status: 'PENDING',
        },
      });
      left = roundMoney(left - part);
    }
    return { contractId: targets[0].contractId, rows: n };
  });
}

// The same read as agentDepositsToPay, inside a transaction.
async function agentDepositsToPayTx(tx: any, agentId: string): Promise<DepositToPay[]> {
  const ledgers = await tx.agentDepositLedger.findMany({
    where: { agentId, status: 'PENDING', outstandingBalance: { gt: 0 } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, contractId: true, contractNumber: true, customerName: true, createdAt: true, outstandingBalance: true },
  });
  if (ledgers.length === 0) return [];
  const pending = await tx.agentDepositPayment.groupBy({
    by: ['ledgerEntryId'],
    where: { ledgerEntryId: { in: ledgers.map((l: any) => l.id) }, status: 'PENDING' },
    _sum: { amount: true },
  });
  const inFlight = new Map<string, number>(pending.map((r: any) => [r.ledgerEntryId, roundMoney(r._sum.amount ?? 0)]));
  return ledgers
    .map((l: any) => ({ ...l, ledgerId: l.id, payable: Math.max(0, roundMoney(l.outstandingBalance - (inFlight.get(l.id) ?? 0))) }))
    .filter((l: DepositToPay) => l.payable > 0.005);
}

/**
 * The rows a Hubtel ClientReference stands for: every row of a short-code
 * charge, or the single row of an agent-portal charge (whose transactionRef is
 * the reference). Settling and failing treat both the same way.
 */
function chargeRows(reference: string) {
  return { OR: [{ clientReference: reference }, { transactionRef: reference, clientReference: null }] };
}

export async function hasAgentDepositCharge(reference: string): Promise<boolean> {
  return !!(await prisma.agentDepositPayment.findFirst({ where: chargeRows(reference), select: { id: true } }));
}

/** A charge that did not go through: its rows stop counting as in flight. */
export async function failUssdRemittance(clientReference: string, reason = 'Payment failed'): Promise<number> {
  const r = await prisma.agentDepositPayment.updateMany({
    where: { ...chargeRows(clientReference), status: 'PENDING' },
    data: { status: 'FAILED', failureReason: reason.slice(0, 250) },
  });
  return r.count;
}

/**
 * Money arrived for a short-code charge. Claims each row still waiting — or
 * already marked failed, since a success can arrive after a failure — and
 * credits its sale exactly as a staff payment does. Returns false only when
 * the reference has no confirmed rows at all.
 */
export async function settleUssdRemittance(clientReference: string, externalRef?: string | null): Promise<boolean> {
  const paidOff: string[] = [];
  const credited: Array<{ ledgerId: string; amount: number }> = [];

  await prisma.$transaction(async (tx) => {
    const rows = await tx.agentDepositPayment.findMany({
      where: { ...chargeRows(clientReference), status: { in: ['PENDING', 'FAILED'] } },
      orderBy: { transactionRef: 'asc' },
    });
    for (const row of rows) {
      const claimed = await tx.agentDepositPayment.updateMany({
        where: { id: row.id, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'SUCCESS', paidAt: new Date(), failureReason: null, hubtelRef: externalRef || row.hubtelRef },
      });
      if (claimed.count === 0) continue;
      const ledger = await tx.agentDepositLedger.findUnique({ where: { id: row.ledgerEntryId } });
      if (!ledger) continue;
      const amountPaid = roundMoney(ledger.amountPaid + row.amount);
      const outstanding = Math.max(0, roundMoney(ledger.amountDueCompany - amountPaid));
      const status = ledger.status === 'CANCELLED' ? 'CANCELLED' : outstanding <= 0.005 ? 'PAID' : 'PENDING';
      await tx.agentDepositLedger.update({
        where: { id: ledger.id },
        data: { amountPaid, outstandingBalance: outstanding, status },
      });
      credited.push({ ledgerId: ledger.id, amount: row.amount });
      if (status === 'PAID' && ledger.status !== 'PAID') paidOff.push(ledger.contractId);
    }
  });

  const confirmed = await prisma.agentDepositPayment.findMany({
    where: { ...chargeRows(clientReference), status: 'SUCCESS' },
    select: { agentId: true, amount: true, phoneNumber: true },
  });
  if (confirmed.length === 0) return false;
  if (credited.length === 0) return true; // already settled by an earlier callback

  // A held phone can open now its deposit is in.
  const { unlockDeviceAfterDepositPaid } = await import('../controllers/agentDepositController');
  // Imported here: the controller imports this service.
  for (const contractId of paidOff) {
    setImmediate(() => { unlockDeviceAfterDepositPaid(contractId, 'AgentDepositUssd'); });
  }

  const agentId = confirmed[0].agentId;
  const total = roundMoney(credited.reduce((s, c) => s + c.amount, 0));
  await createAuditLog({
    userId: agentId,
    action: 'AGENT_DEPOSIT_PAID',
    entity: 'AgentDepositPayment',
    entityId: clientReference,
    newValues: { clientReference, amount: total, sales: credited.length, salesPaidOff: paidOff.length },
  });

  await sendReceipt(agentId, total, confirmed[0].phoneNumber).catch((err) =>
    console.error('[AgentDepositUssd] receipt SMS failed:', err?.message || err),
  );
  return true;
}

function ghs(amount: number): string {
  return `GHS ${roundMoney(amount).toFixed(2)}`;
}

/** Text the receipt to the agent's number on record, else the number charged. */
async function sendReceipt(agentId: string, amount: number, chargedPhone: string): Promise<void> {
  const agent = await prisma.adminUser.findUnique({ where: { id: agentId }, select: { firstName: true, phone: true } });
  const left = await prisma.agentDepositLedger.aggregate({
    where: { agentId, status: 'PENDING' },
    _sum: { outstandingBalance: true },
  });
  const remaining = roundMoney(left._sum.outstandingBalance ?? 0);
  const to = agent?.phone || toLocalPhone(chargedPhone);
  if (!to) return;
  const tail = remaining > 0.005 ? `You still have ${ghs(remaining)} to pay in.` : 'You have nothing more to pay in.';
  await sendSMS({
    to,
    message: `Hi ${agent?.firstName ?? 'there'}, we have received your deposit payment of ${ghs(amount)}. ${tail} ${COMPANY}`,
  });
}

/** Hubtel numbers are stored 233XXXXXXXXX; texts go to 0XXXXXXXXX like the rest of the system. */
function toLocalPhone(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) return `0${digits.slice(3)}`;
  return digits;
}

// ── Sweep for charges Hubtel never called back about ───────────────────────

const SWEEP_AFTER_MS = 10 * 60_000;
/** A charge still unconfirmed after this long was not paid: it stops blocking the balance. */
const GIVE_UP_AFTER_MS = 48 * 3600_000;
/**
 * Rows waiting longer than this are not asked about at all: they predate the
 * sweep (charges from the agent portal that never resolved), and staff may
 * already have recorded the same money by hand while they blocked it. They are
 * marked not paid without crediting anything, so the balance can be paid in
 * again; a success that still arrives for one lands as usual.
 */
const SWEEP_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * Ask Hubtel about deposit charges still waiting after ten minutes, and settle
 * or fail them as a callback would. A charge Hubtel cannot answer for stays
 * waiting for 48 hours — a Mobile Money prompt is long dead by then — and is
 * then marked not paid so the money can be paid in again. If a success does
 * turn up after that, it still lands: settling claims failed rows too.
 */
export async function sweepStuckAgentDeposits(now: Date = new Date()): Promise<{ checked: number; settled: number; failed: number }> {
  const stale = await prisma.agentDepositPayment.updateMany({
    where: { status: 'PENDING', channel: { in: ['WEB', 'USSD'] }, createdAt: { lte: new Date(now.getTime() - SWEEP_WINDOW_MS) } },
    data: { status: 'FAILED', failureReason: 'No confirmation from Hubtel for over 7 days' },
  });

  const rows = await prisma.agentDepositPayment.findMany({
    where: {
      status: 'PENDING',
      channel: { in: ['WEB', 'USSD'] },
      createdAt: { lt: new Date(now.getTime() - SWEEP_AFTER_MS), gt: new Date(now.getTime() - SWEEP_WINDOW_MS) },
    },
    select: { transactionRef: true, clientReference: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  const references = [...new Set(rows.map((r) => r.clientReference || r.transactionRef))];
  const createdOf = new Map(rows.map((r) => [r.clientReference || r.transactionRef, r.createdAt]));
  const giveUp = async (reference: string) => {
    const created = createdOf.get(reference);
    if (created && now.getTime() - created.getTime() > GIVE_UP_AFTER_MS) {
      return (await failUssdRemittance(reference, 'No confirmation from Hubtel after 48 hours')) > 0;
    }
    return false;
  };
  const { checkHubtelPaymentStatus } = await import('./hubtelService');
  const { hubtelTransactionOutcome } = await import('../controllers/paymentController');
  let settled = 0;
  let failed = 0;
  for (const reference of references) {
    try {
      const status: any = await checkHubtelPaymentStatus(reference);
      const raw = String(status?.data?.status || status?.Data?.Status || status?.data?.Status || '');
      const outcome = hubtelTransactionOutcome(raw);
      if (outcome === 'SUCCESS') {
        if (await settleUssdRemittance(reference, status?.data?.transactionId || status?.Data?.TransactionId || null)) settled++;
      } else if (outcome === 'FAILED') {
        if (await failUssdRemittance(reference, `Hubtel status: ${raw}`)) failed++;
      } else if (await giveUp(reference)) {
        failed++;
      }
    } catch (error: any) {
      // Hubtel answers "not found" for a prompt that was never approved.
      if (await giveUp(reference).catch(() => false)) failed++;
      else console.error(`[AgentDepositSweep] ${reference}:`, error?.message || error);
    }
  }
  return { checked: references.length, settled, failed: failed + stale.count };
}
