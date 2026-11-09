import prisma from '../config/database';
import { createAuditLog } from './auditService';
import { sendSMS } from './notificationService';
import { getPayTriggerSettings } from './payTrigger/settings';
import { lockMomentFor, LOCK_NOW_LEAD_MS } from './payTrigger/decide';
import { SELLING_AGENT_ROLES } from '../constants/roles';
import { generateTransactionRef, roundMoney } from '../utils/helpers';
import { getActiveTemporaryUnlock } from './temporaryUnlockService';

/**
 * Paid temporary unlock: a customer whose phone has locked pays a share of
 * what is overdue and the phone opens for a set number of hours.
 *
 * Not the same thing as TemporaryUnlockRequest (temporaryUnlockService), which
 * a cluster agent asks for and an admin approves for weeks. Both can exist on
 * one contract; neither reads the other's rows.
 *
 * Nothing here moves money or touches a device. A request is saved against the
 * charge's reference before the charge is made; the phone opens only when the
 * payment for that reference is posted (applyTemporaryUnlock, called from both
 * processSuccessfulPayment paths), and the device is judged straight after.
 *
 * Whether an unlock counts is read from its payment every time: a payment that
 * is deleted (this project's reversal) takes its unlock with it and gives the
 * use back, with nothing to update at the time.
 */

const prismaAny = prisma as any;

export interface UnlockTier {
  percent: number;
  hours: number;
  /**
   * The charge, as a percentage of what is overdue, added to `percent`: a
   * 25% tier with a 5% charge asks for 30% of the arrears. The charge is the
   * company's fee and does not reduce what is owed. 0 for none.
   */
  feePercent: number;
}

export const DEFAULT_UNLOCK_TIERS: UnlockTier[] = [
  { percent: 25, hours: 24, feePercent: 0 },
  { percent: 50, hours: 72, feePercent: 0 },
  { percent: 75, hours: 120, feePercent: 0 },
  { percent: 90, hours: 168, feePercent: 0 },
];

/** The largest charge a tier may carry, as a percentage of the arrears. */
export const MAX_CHARGE_PERCENT = 50;

export const PAID_UNLOCK_CHANNEL = { USSD: 'USSD', APP: 'APP', STAFF: 'STAFF' } as const;
export type PaidUnlockChannel = (typeof PAID_UNLOCK_CHANNEL)[keyof typeof PAID_UNLOCK_CHANNEL];

export const MIN_TIERS = 4;
/** A USSD screen holds at most six. */
export const MAX_TIERS = 6;
export const MAX_USES_LIMIT = 20;

const COMPANY = 'AIDOO TECH';

/** A refusal the customer or officer should read as it is. */
export class TemporaryUnlockError extends Error {
  status = 400;
}

export interface UnlockOption {
  percent: number;
  hours: number;
  /** Towards the overdue instalments. */
  amount: number;
  /** The tier's charge as a percentage of the arrears (added to `percent`). */
  feePercent: number;
  /** The tier's charge in GHS: the company's fee, not towards the contract. */
  fee: number;
  /** What the payer pays: amount + fee. */
  total: number;
}

export interface TemporaryUnlockOffer {
  available: boolean;
  message: string;
  overdue: number;
  options: UnlockOption[];
  /** When a window already running ends; null when the phone is shut. */
  activeUntil: Date | null;
  usesLeft: number;
}

// ── Money and time ──────────────────────────────────────────────────────────

/** `ceil(amount × percent / 100)` to the pesewa, in whole pesewas so float drift can't round it up a pesewa too far. */
export function tierAmount(overdue: number, percent: number): number {
  const pesewas = Math.round(overdue * 100);
  return Math.ceil((pesewas * percent) / 100) / 100;
}

export function formatGhs(amount: number): string {
  return `GHS ${roundMoney(amount).toFixed(2)}`;
}

/** "3 days", "1 day", "36 hours" — a tier's length as a customer reads it. */
export function formatPeriod(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? '1 day' : `${days} days`;
  }
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** "dd/mm hh:mm" in Ghana time, for a USSD screen. */
export function formatShortDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Accra', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}

/** "Mon 10 Nov at 14:30", for a text message. */
export function formatLongDateTime(d: Date): string {
  const date = d.toLocaleDateString('en-GB', { timeZone: 'Africa/Accra', weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} at ${time}`;
}

function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ── Settings ────────────────────────────────────────────────────────────────

export interface PaidUnlockSettings {
  enabled: boolean;
  maxUses: number;
  tiers: UnlockTier[];
}

function parseTiers(raw: unknown): UnlockTier[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return DEFAULT_UNLOCK_TIERS;
    }
  }
  if (!Array.isArray(value)) return DEFAULT_UNLOCK_TIERS;
  return value.map((t: any) => ({ percent: Number(t?.percent), hours: Number(t?.hours), feePercent: Number(t?.feePercent ?? 0) }));
}

export async function getPaidUnlockSettings(): Promise<PaidUnlockSettings> {
  const row = await prismaAny.knoxGuardSettings.findFirst({
    select: { temporaryUnlockEnabled: true, temporaryUnlockMaxUses: true, temporaryUnlockTiers: true },
  });
  return {
    enabled: !!row?.temporaryUnlockEnabled,
    maxUses: row?.temporaryUnlockMaxUses ?? 2,
    tiers: parseTiers(row?.temporaryUnlockTiers ?? DEFAULT_UNLOCK_TIERS),
  };
}

/**
 * The longest a phone can be promised: PayTrigger never accepts a lock date
 * further ahead than its horizon, so no tier may promise more.
 */
export async function maxUnlockHours(horizonDays?: number): Promise<number> {
  const days = horizonDays ?? (await getPayTriggerSettings()).maxUnlockHorizonDays;
  return Math.max(1, Math.floor(days * 24));
}

/** Null when the tiers are acceptable, else what is wrong with them. */
export function validateTiers(tiers: unknown, maxHours: number): string | null {
  if (!Array.isArray(tiers)) return 'Tiers must be a list.';
  if (tiers.length < MIN_TIERS || tiers.length > MAX_TIERS) return `Set between ${MIN_TIERS} and ${MAX_TIERS} tiers.`;
  let prev: UnlockTier | null = null;
  for (const [i, t] of tiers.entries()) {
    const percent = Number((t as any)?.percent);
    const hours = Number((t as any)?.hours);
    const feePercent = Number((t as any)?.feePercent ?? 0);
    const n = i + 1;
    if (!Number.isInteger(percent) || percent < 1 || percent > 99) return `Tier ${n}: the percentage must be a whole number from 1 to 99.`;
    if (!Number.isInteger(hours) || hours < 1) return `Tier ${n}: the hours must be a whole number of at least 1.`;
    if (hours > maxHours) return `Tier ${n}: ${hours} hours is longer than a phone can be opened ahead (${maxHours} hours).`;
    if (!Number.isInteger(feePercent) || feePercent < 0 || feePercent > MAX_CHARGE_PERCENT) {
      return `Tier ${n}: the charge must be a whole percentage from 0 to ${MAX_CHARGE_PERCENT}.`;
    }
    // Share and charge together must stay below the whole arrears, or paying
    // everything off would be cheaper than the unlock.
    if (percent + feePercent >= 100) {
      return `Tier ${n}: the share and the charge together (${percent + feePercent}%) must be less than 100%.`;
    }
    if (prev && percent <= prev.percent) return `Tier ${n} must ask for a higher percentage than tier ${n - 1}.`;
    if (prev && hours <= prev.hours) return `Tier ${n} must give more hours than tier ${n - 1}.`;
    prev = { percent, hours, feePercent };
  }
  return null;
}

export function validateMaxUses(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_USES_LIMIT) return `The use limit must be a whole number from 1 to ${MAX_USES_LIMIT}.`;
  return null;
}

// ── Windows ─────────────────────────────────────────────────────────────────

interface PaidUnlockRow {
  id: string;
  contractId: string;
  percent: number;
  hours: number;
  amount: number;
  paymentId: string | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
}

/** Applied unlocks whose payment still stands. A deleted or failed payment drops out. */
async function standingUnlocks(where: Record<string, unknown>): Promise<PaidUnlockRow[]> {
  const rows: PaidUnlockRow[] = await prismaAny.paidTemporaryUnlock.findMany({
    where: { status: 'APPLIED', paymentId: { not: null }, ...where },
    select: { id: true, contractId: true, percent: true, hours: true, amount: true, paymentId: true, activatedAt: true, expiresAt: true },
  });
  if (rows.length === 0) return rows;
  const paid = await prisma.paymentTransaction.findMany({
    where: { id: { in: rows.map((r) => r.paymentId as string) }, status: 'SUCCESS' },
    select: { id: true },
  });
  const ok = new Set(paid.map((p) => p.id));
  return rows.filter((r) => ok.has(r.paymentId as string));
}

export function paidUnlocks(contractId: string): Promise<PaidUnlockRow[]> {
  return standingUnlocks({ contractId });
}

/** The latest end, after `now`, of this contract's paid windows; null when none is running. */
export async function temporaryUnlockUntil(contractId: string, now: Date = new Date()): Promise<Date | null> {
  const rows = await standingUnlocks({ contractId, expiresAt: { gt: now } });
  let end: Date | null = null;
  for (const r of rows) if (r.expiresAt && (!end || r.expiresAt > end)) end = r.expiresAt;
  return end;
}

/**
 * Whether a window is worth honouring: one ending inside the "lock now" margin
 * is treated as over, so a device is never opened for a minute.
 */
export function isLiveWindow(until: Date | null | undefined, now: Date = new Date()): until is Date {
  return !!until && until.getTime() > now.getTime() + LOCK_NOW_LEAD_MS;
}

/** Batch form for the Knox sweeps: contracts with a live paid window. */
export async function liveWindowContractIds(contractIds: string[], now: Date = new Date()): Promise<Set<string>> {
  if (contractIds.length === 0) return new Set();
  const rows = await standingUnlocks({
    contractId: { in: contractIds },
    expiresAt: { gt: new Date(now.getTime() + LOCK_NOW_LEAD_MS) },
  });
  return new Set(rows.map((r) => r.contractId));
}

/** Contracts whose paid window ended in [from, to) — the relock job's list. */
export async function windowsEndedBetween(from: Date, to: Date): Promise<string[]> {
  const rows = await standingUnlocks({ expiresAt: { gte: from, lt: to } });
  return [...new Set(rows.map((r) => r.contractId))];
}

/** Whether this contract has ever had a paid window — a defaulted phone opened by one must be shut after. */
export async function hadPaidWindow(contractId: string): Promise<boolean> {
  return (await standingUnlocks({ contractId })).length > 0;
}

// ── Offer ───────────────────────────────────────────────────────────────────

type Provider = 'KNOX' | 'PAYTRIGGER';

async function activeDeviceProvider(contractId: string): Promise<Provider | null> {
  const [knox, pt] = await Promise.all([
    prismaAny.managedDevice.findFirst({
      where: { contractId, isActive: true, enrollmentStatus: 'ACTIVE' },
      select: { id: true },
    }),
    prisma.payTriggerDevice.findFirst({ where: { contractId, enrollmentStatus: 'ACTIVE' }, select: { id: true } }),
  ]);
  if (pt) return 'PAYTRIGGER';
  if (knox) return 'KNOX';
  return null;
}

async function lockRules(provider: Provider): Promise<{ lockAfterOverdueDays: number; depositHold: boolean }> {
  if (provider === 'PAYTRIGGER') {
    const s = await getPayTriggerSettings();
    return { lockAfterOverdueDays: s.lockAfterOverdueDays, depositHold: s.lockOnUnpaidAgentDeposit };
  }
  // Knox holds the phone for an unremitted deposit unconditionally.
  const s = await prismaAny.knoxGuardSettings.findFirst({ select: { lockAfterOverdueDays: true } });
  return { lockAfterOverdueDays: s?.lockAfterOverdueDays ?? 1, depositHold: true };
}

function overdueOf(installments: Array<{ status: string; dueDate: Date; amount: number; paidAmount: number }>, now: Date) {
  const today = startOfDay(now);
  const rows = installments.filter(
    (i) => i.status !== 'PAID' && i.status !== 'WRITTEN_OFF' && i.dueDate < today && i.amount - i.paidAmount > 0.005,
  );
  const overdue = roundMoney(rows.reduce((s, i) => s + (i.amount - i.paidAmount), 0));
  const oldest = rows.reduce<Date | null>((m, i) => (!m || i.dueDate < m ? i.dueDate : m), null);
  return { overdue, oldest };
}

export const DEPOSIT_HOLD_MESSAGE = 'Your phone is held until your agent finishes registering your payment. Please contact your agent.';

export async function getTemporaryUnlockOffer(contractId: string, now: Date = new Date()): Promise<TemporaryUnlockOffer | null> {
  const settings = await getPaidUnlockSettings();
  if (!settings.enabled) return null;

  const contract = await prisma.hirePurchaseContract.findUnique({
    where: { id: contractId },
    select: {
      id: true,
      status: true,
      gracePeriodDays: true,
      installments: { select: { status: true, dueDate: true, amount: true, paidAmount: true } },
      agentLedger: { select: { outstandingBalance: true } },
      createdBy: { select: { role: { select: { name: true } } } },
    },
  });
  if (!contract || !['ACTIVE', 'DEFAULTED'].includes(contract.status)) return null;

  // An approved temporary unlock (the cluster-leader request an admin
  // approves, temporaryUnlockService) already holds the phone open. Offering a
  // paid unlock on top would ask the customer to pay to open an open phone.
  if (await getActiveTemporaryUnlock(contract.id, now)) return null;

  const provider = await activeDeviceProvider(contract.id);
  if (!provider) return null;

  const { overdue, oldest } = overdueOf(contract.installments, now);
  if (overdue <= 0 || !oldest) return null;

  const rules = await lockRules(provider);
  const lockedSince = lockMomentFor(oldest, contract.gracePeriodDays ?? 0, rules.lockAfterOverdueDays);
  const activeUntil = await temporaryUnlockUntil(contract.id, now);
  if (contract.status !== 'DEFAULTED' && lockedSince > now && !activeUntil) return null;

  // A defaulted contract does not reopen on its own schedule when the arrears
  // are paid (a Transsion phone stays shut), so it is not promised that.
  const payFully = (amount: number) =>
    contract.status === 'DEFAULTED'
      ? `Please contact customer service about the ${formatGhs(amount)} overdue to open your phone.`
      : `Pay the full overdue amount of ${formatGhs(amount)} to open your phone.`;

  const standing = await paidUnlocks(contract.id);
  const used = standing.filter((r) => r.activatedAt && r.activatedAt >= oldest).length;
  const usesLeft = Math.max(0, settings.maxUses - used);
  const closed = (message: string): TemporaryUnlockOffer => ({ available: false, message, overdue, options: [], activeUntil, usesLeft });

  const soldByAgent = (SELLING_AGENT_ROLES as readonly string[]).includes(contract.createdBy?.role?.name ?? '');
  if (soldByAgent && rules.depositHold && (!contract.agentLedger || contract.agentLedger.outstandingBalance > 0.005)) {
    return closed(DEPOSIT_HOLD_MESSAGE);
  }
  if (usesLeft === 0) {
    return closed(`You have used all your temporary unlocks. ${payFully(overdue)}`);
  }

  // The share must stay below the full overdue amount; the charge rides on top.
  const options = settings.tiers
    .map((t) => {
      const amount = tierAmount(overdue, t.percent);
      const feePercent = t.feePercent || 0;
      const fee = feePercent > 0 ? tierAmount(overdue, feePercent) : 0;
      return { percent: t.percent, hours: t.hours, amount, feePercent, fee, total: roundMoney(amount + fee) };
    })
    .filter((o) => o.amount > 0 && o.amount < overdue - 0.005);
  if (options.length === 0) {
    return closed(payFully(overdue));
  }

  return {
    available: true,
    message: activeUntil
      ? `Your phone is open until ${formatLongDateTime(activeUntil)}. Pay part of what is overdue to keep it open longer.`
      : 'Your phone is locked. Pay part of what is overdue to open it for a while.',
    overdue,
    options,
    activeUntil,
    usesLeft,
  };
}

// ── Request, apply ──────────────────────────────────────────────────────────

async function freshReference(): Promise<string> {
  for (;;) {
    const ref = generateTransactionRef();
    const [payment, unlock] = await Promise.all([
      prisma.paymentTransaction.findUnique({ where: { transactionRef: ref }, select: { id: true } }),
      prismaAny.paidTemporaryUnlock.findUnique({ where: { clientReference: ref }, select: { id: true } }),
    ]);
    if (!payment && !unlock) return ref;
  }
}

/** How long an unapproved unlock prompt blocks another. */
const PENDING_UNLOCK_BLOCK_MS = 10 * 60_000;

async function hasUnlockPaymentWaiting(contractId: string, now: Date): Promise<boolean> {
  const rows: Array<{ clientReference: string }> = await prismaAny.paidTemporaryUnlock.findMany({
    where: { contractId, status: 'PENDING', createdAt: { gt: new Date(now.getTime() - PENDING_UNLOCK_BLOCK_MS) } },
    select: { clientReference: true },
  });
  if (rows.length === 0) return false;
  const waiting = await prisma.paymentTransaction.count({
    where: { transactionRef: { in: rows.map((r) => r.clientReference) }, status: 'PENDING' },
  });
  return waiting > 0;
}

export interface RequestTemporaryUnlockInput {
  contractId: string;
  percent: number;
  channel: PaidUnlockChannel;
  clientReference?: string;
  requestedById?: string | null;
  /** The total the payer was shown (share + charge). A different figure means something moved. */
  expectedAmount?: number;
  now?: Date;
}

/**
 * Record what a charge with this reference is for, before the charge is made.
 * Moves no money. Confirming twice in one session is one request.
 */
export async function requestTemporaryUnlock(input: RequestTemporaryUnlockInput) {
  const now = input.now ?? new Date();
  const offer = await getTemporaryUnlockOffer(input.contractId, now);
  if (!offer || !offer.available) {
    throw new TemporaryUnlockError(offer?.message || 'A temporary unlock is not available for this contract.');
  }
  // One unlock payment at a time: a second tap or a redial while the first
  // prompt is still out would charge twice.
  if (await hasUnlockPaymentWaiting(input.contractId, now)) {
    throw new TemporaryUnlockError(
      input.channel === PAID_UNLOCK_CHANNEL.STAFF
        ? 'The customer has a Mobile Money payment to open this phone waiting for approval. Try again in a few minutes if it is not approved.'
        : 'A payment to open this phone is already waiting for approval. Approve it on your phone, or try again in a few minutes.',
    );
  }

  const option = offer.options.find((o) => o.percent === Number(input.percent));
  if (!option) throw new TemporaryUnlockError('That option is no longer available. Please start again.');
  if (input.expectedAmount !== undefined && Math.abs(roundMoney(input.expectedAmount) - option.total) > 0.005) {
    throw new TemporaryUnlockError('The amount overdue has changed. Please start again.');
  }

  // The project's payment amount check: more than nothing, and no more than is owed.
  const contract = await prisma.hirePurchaseContract.findUnique({
    where: { id: input.contractId },
    select: { outstandingBalance: true, penaltyOutstanding: true },
  });
  const ceiling = roundMoney((contract?.outstandingBalance ?? 0) + (contract?.penaltyOutstanding ?? 0));
  if (option.amount <= 0 || option.amount > ceiling + 0.005) {
    throw new TemporaryUnlockError('This amount cannot be paid on this contract. Please contact customer service.');
  }

  const clientReference = input.clientReference || (await freshReference());
  const unlock = await prismaAny.paidTemporaryUnlock.upsert({
    where: { clientReference },
    update: {},
    create: {
      contractId: input.contractId,
      percent: option.percent,
      hours: option.hours,
      overdueAmount: offer.overdue,
      amount: option.amount,
      fee: option.fee,
      channel: input.channel,
      status: 'PENDING',
      clientReference,
      requestedById: input.requestedById ?? null,
    },
  });
  return { unlock, option, offer, clientReference };
}

/**
 * Open the phone for a settled charge, if the charge was for an unlock.
 * Called for every posted payment, most of which are not: returns quietly
 * unless a PENDING request carries this reference. Never throws — the payment
 * is already recorded and must not be undone by anything here.
 *
 * The device is not touched here. Both callers judge the device straight
 * after (safelyEvaluateManagedDeviceForContract, notifyPayTrigger), and that
 * is what opens it; doing it here as well would send Knox two commands.
 */
export async function applyTemporaryUnlock(clientReference: string | null | undefined, paymentId: string): Promise<boolean> {
  if (!clientReference) return false;
  try {
    const row = await prismaAny.paidTemporaryUnlock.findUnique({ where: { clientReference } });
    if (!row || row.status !== 'PENDING') return false;

    const now = new Date();
    const running = await temporaryUnlockUntil(row.contractId, now);
    const asked = new Date(now.getTime() + row.hours * 3600_000);
    // A window already running is only ever lengthened.
    const expiresAt = running && running > asked ? running : asked;

    const claimed = await prismaAny.paidTemporaryUnlock.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'APPLIED', paymentId, activatedAt: now, expiresAt },
    });
    if (claimed.count === 0) return false;

    await createAuditLog({
      userId: row.requestedById ?? undefined,
      action: 'PAID_TEMPORARY_UNLOCK_APPLIED',
      entity: 'PaidTemporaryUnlock',
      entityId: row.id,
      newValues: {
        contractId: row.contractId,
        percent: row.percent,
        hours: row.hours,
        amount: row.amount,
        fee: row.fee,
        channel: row.channel,
        paymentId,
        expiresAt: expiresAt.toISOString(),
      },
    });

    await textCustomer(row.contractId, expiresAt, now).catch((err) =>
      console.error('[PaidUnlock] SMS failed:', err?.message || err),
    );
    return true;
  } catch (error: any) {
    console.error(`[PaidUnlock] Could not apply unlock for ${clientReference}:`, error?.message || error);
    return false;
  }
}

async function textCustomer(contractId: string, expiresAt: Date, now: Date): Promise<void> {
  const contract = await prisma.hirePurchaseContract.findUnique({
    where: { id: contractId },
    select: {
      installments: { select: { status: true, dueDate: true, amount: true, paidAmount: true } },
      customer: { select: { firstName: true, phone: true } },
    },
  });
  if (!contract?.customer?.phone) return;
  const { overdue } = overdueOf(contract.installments, now);
  if (overdue <= 0) return; // all paid: the phone is back on its schedule, nothing to warn about
  await sendSMS({
    to: contract.customer.phone,
    message:
      `Hi ${contract.customer.firstName}, your phone is open until ${formatLongDateTime(expiresAt)}. ` +
      `Pay the remaining ${formatGhs(overdue)} overdue before then or it will lock again. ${COMPANY}`,
  });
}
