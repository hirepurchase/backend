/**
 * Rescheduling an expired contract's balance.
 *
 * When a contract runs past its end date still owing, its balance, plus any
 * unpaid late charges, plus flat interest (a % per month of the new term), is
 * spread over a new schedule. A request is raised by hand or by the daily job
 * (when switched on) and changes nothing until a second person approves it.
 *
 * On approval the instalments the customer has paid stay as they are; one
 * part-paid is closed at what was paid; the unpaid ones are replaced by the new
 * schedule, numbered on from the last kept one. The old schedule is kept on the
 * request. The late charges taken into the balance are waived with a reason
 * that says so, so they are never collected twice.
 */
import prisma from '../config/database';
import { createAuditLog } from './auditService';
import { roundMoney, calculateInstallmentSchedule, toBusinessDay } from '../utils/helpers';
import { PENALTY_FOLDED_REASON, recomputePenaltyOutstanding } from './penaltyService';
import { PaymentFrequency } from '../types';

const db = prisma as any;
const DAY_MS = 86_400_000;

export const FREQUENCIES: PaymentFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];
const MAX_INSTALMENTS: Record<PaymentFrequency, number> = { DAILY: 365, WEEKLY: 104, MONTHLY: 36 };

export class RescheduleError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface RescheduleSettings {
  autoEnabled: boolean;
  autoAfterDays: number;
  defaultMonthlyRate: number;
  maxMonthlyRate: number;
  autoFrequency: PaymentFrequency;
  autoInstallments: number;
  maxReschedulesPerContract: number;
  updatedById?: string | null;
  updatedAt?: Date | null;
}

const DEFAULTS: RescheduleSettings = {
  autoEnabled: false,
  autoAfterDays: 7,
  defaultMonthlyRate: 5,
  maxMonthlyRate: 20,
  autoFrequency: 'WEEKLY',
  autoInstallments: 8,
  maxReschedulesPerContract: 2,
};

export async function getRescheduleSettings(): Promise<RescheduleSettings & { id?: string }> {
  const row = await db.rescheduleSettings.findFirst();
  return row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
}

export async function saveRescheduleSettings(
  input: Partial<RescheduleSettings>,
  adminId: string
): Promise<RescheduleSettings> {
  const current = await getRescheduleSettings();
  const next = { ...current, ...input };
  if (!FREQUENCIES.includes(next.autoFrequency)) throw new RescheduleError('Frequency must be DAILY, WEEKLY or MONTHLY');
  if (!Number.isFinite(next.maxMonthlyRate) || next.maxMonthlyRate < 0 || next.maxMonthlyRate > 100) {
    throw new RescheduleError('The highest rate must be between 0 and 100% a month');
  }
  if (!Number.isFinite(next.defaultMonthlyRate) || next.defaultMonthlyRate < 0 || next.defaultMonthlyRate > next.maxMonthlyRate) {
    throw new RescheduleError(`The usual rate must be between 0 and ${next.maxMonthlyRate}% a month`);
  }
  if (!Number.isInteger(next.autoAfterDays) || next.autoAfterDays < 0 || next.autoAfterDays > 365) {
    throw new RescheduleError('Days past the end date must be a whole number from 0 to 365');
  }
  if (!Number.isInteger(next.autoInstallments) || next.autoInstallments < 1 || next.autoInstallments > MAX_INSTALMENTS[next.autoFrequency]) {
    throw new RescheduleError(`Number of payments must be from 1 to ${MAX_INSTALMENTS[next.autoFrequency]}`);
  }
  if (!Number.isInteger(next.maxReschedulesPerContract) || next.maxReschedulesPerContract < 1 || next.maxReschedulesPerContract > 10) {
    throw new RescheduleError('Times per contract must be from 1 to 10');
  }
  const data = {
    autoEnabled: Boolean(next.autoEnabled),
    autoAfterDays: next.autoAfterDays,
    defaultMonthlyRate: next.defaultMonthlyRate,
    maxMonthlyRate: next.maxMonthlyRate,
    autoFrequency: next.autoFrequency,
    autoInstallments: next.autoInstallments,
    maxReschedulesPerContract: next.maxReschedulesPerContract,
    updatedById: adminId,
  };
  const saved = current.id
    ? await db.rescheduleSettings.update({ where: { id: current.id }, data })
    : await db.rescheduleSettings.create({ data });
  await createAuditLog({
    userId: adminId,
    action: 'UPDATE_RESCHEDULE_SETTINGS',
    entity: 'RescheduleSettings',
    entityId: saved.id,
    oldValues: { ...current, id: undefined },
    newValues: data,
  });
  return { ...DEFAULTS, ...saved };
}

// ---------------------------------------------------------------- dates

/** Midnight UTC today, plus `days`. Due dates are stored at midnight UTC. */
export function utcDay(days = 0, from: Date = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + days));
}

function oneDayOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** The usual first due date: one period from today, off the weekend. */
export function defaultFirstDueDate(frequency: PaymentFrequency, today: Date = utcDay()): Date {
  const d = new Date(today);
  if (frequency === 'DAILY') d.setUTCDate(d.getUTCDate() + 1);
  else if (frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return oneDayOnly(toBusinessDay(d));
}

/** Whole calendar months between two days, plus the days left over as thirtieths. */
export function monthsBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  const anchor = new Date(from);
  anchor.setUTCMonth(anchor.getUTCMonth() + months);
  const days = Math.max(0, Math.round((to.getTime() - anchor.getTime()) / DAY_MS));
  return Math.round((months + days / 30) * 100) / 100;
}

// ---------------------------------------------------------------- figures

export interface Terms {
  monthlyRate: number;
  frequency: PaymentFrequency;
  installments: number;
  /** YYYY-MM-DD or a Date; defaults to one period from today. */
  firstDueDate?: string | Date | null;
}

export interface Quote {
  balance: number;
  lateCharges: number;
  principal: number;
  monthlyRate: number;
  termMonths: number;
  interest: number;
  newTotal: number;
  frequency: PaymentFrequency;
  installments: number;
  installmentAmount: number;
  firstDueDate: Date;
  newEndDate: Date;
  schedule: Array<{ installmentNo: number; dueDate: Date; amount: number }>;
}

function parseDay(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return oneDayOnly(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RescheduleError('First due date must be a date (YYYY-MM-DD)');
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new RescheduleError('First due date is not a real date');
  return d;
}

export function validateTerms(terms: Terms, settings: RescheduleSettings, today: Date = utcDay()): Required<Omit<Terms, 'firstDueDate'>> & { firstDueDate: Date } {
  const frequency = String(terms.frequency || '').toUpperCase() as PaymentFrequency;
  if (!FREQUENCIES.includes(frequency)) throw new RescheduleError('Frequency must be DAILY, WEEKLY or MONTHLY');
  const installments = Number(terms.installments);
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALMENTS[frequency]) {
    throw new RescheduleError(`Number of payments must be a whole number from 1 to ${MAX_INSTALMENTS[frequency]} for ${frequency.toLowerCase()} payments`);
  }
  const monthlyRate = Number(terms.monthlyRate);
  if (!Number.isFinite(monthlyRate) || monthlyRate < 0 || monthlyRate > settings.maxMonthlyRate) {
    throw new RescheduleError(`Interest must be from 0 to ${settings.maxMonthlyRate}% a month`);
  }
  let firstDueDate = parseDay(terms.firstDueDate) ?? defaultFirstDueDate(frequency, today);
  if (firstDueDate <= today) throw new RescheduleError('First due date must be after today');
  if (firstDueDate.getTime() - today.getTime() > 62 * DAY_MS) throw new RescheduleError('First due date must be within 62 days');
  firstDueDate = oneDayOnly(toBusinessDay(firstDueDate));
  return { monthlyRate, frequency, installments, firstDueDate };
}

export function buildQuote(
  balance: number,
  lateCharges: number,
  terms: { monthlyRate: number; frequency: PaymentFrequency; installments: number; firstDueDate: Date },
  today: Date = utcDay()
): Quote {
  const principal = roundMoney(balance + lateCharges);
  const dates = calculateInstallmentSchedule(1, terms.frequency, terms.installments, terms.firstDueDate);
  const newEndDate = oneDayOnly(dates[dates.length - 1].dueDate);
  const termMonths = monthsBetween(today, newEndDate);
  const interest = roundMoney((principal * terms.monthlyRate * termMonths) / 100);
  const newTotal = roundMoney(principal + interest);
  const schedule = calculateInstallmentSchedule(newTotal, terms.frequency, terms.installments, terms.firstDueDate)
    .map((row) => ({ installmentNo: row.installmentNo, dueDate: oneDayOnly(row.dueDate), amount: row.amount }));
  return {
    balance: roundMoney(balance),
    lateCharges: roundMoney(lateCharges),
    principal,
    monthlyRate: terms.monthlyRate,
    termMonths,
    interest,
    newTotal,
    frequency: terms.frequency,
    installments: terms.installments,
    installmentAmount: schedule[0].amount,
    firstDueDate: terms.firstDueDate,
    newEndDate,
    schedule,
  };
}

// ---------------------------------------------------------------- position

interface Position {
  contract: any;
  /** What is owed on the purchase, from the payments themselves. */
  balance: number;
  /** Unpaid late charges, all kinds. */
  lateCharges: number;
  penaltyIds: string[];
  paymentsSum: number;
  instalments: Array<{ id: string; installmentNo: number; dueDate: Date; amount: number; paidAmount: number; status: string }>;
}

async function readPosition(contractId: string, client: any = db): Promise<Position> {
  const contract = await client.hirePurchaseContract.findUnique({
    where: { id: contractId },
    select: {
      id: true, contractNumber: true, status: true, endDate: true, originalEndDate: true, rescheduleCount: true,
      totalPrice: true, depositAmount: true, financeAmount: true, totalInstallments: true, paymentFrequency: true,
      customer: { select: { firstName: true, lastName: true, phone: true } },
    },
  });
  if (!contract) throw new RescheduleError('Contract not found', 404);
  const [payments, penalties, instalments] = await Promise.all([
    client.paymentTransaction.findMany({ where: { contractId, status: 'SUCCESS' }, select: { amount: true, unlockFee: true } }),
    client.penalty.findMany({ where: { contractId, isPaid: false, isWaived: false }, select: { id: true, amount: true, paidAmount: true } }),
    client.installmentSchedule.findMany({
      where: { contractId },
      orderBy: { installmentNo: 'asc' },
      select: { id: true, installmentNo: true, dueDate: true, amount: true, paidAmount: true, status: true },
    }),
  ]);
  const paymentsSum = roundMoney(payments.reduce((s: number, p: any) => s + p.amount - (p.unlockFee ?? 0), 0));
  const balance = roundMoney(contract.totalPrice - contract.depositAmount - paymentsSum);
  const lateCharges = roundMoney(penalties.reduce((s: number, p: any) => s + Math.max(0, p.amount - p.paidAmount), 0));
  return { contract, balance, lateCharges, penaltyIds: penalties.map((p: any) => p.id), paymentsSum, instalments };
}

/** Why this contract cannot be rescheduled, or null if it can. */
export function ineligibleReason(pos: Position, today: Date = utcDay()): string | null {
  const c = pos.contract;
  if (!['ACTIVE', 'DEFAULTED'].includes(c.status)) return `The contract is ${String(c.status).toLowerCase().replace(/_/g, ' ')}`;
  if (oneDayOnly(new Date(c.endDate)) >= today) return `The contract runs until ${new Date(c.endDate).toISOString().slice(0, 10)}; it can be rescheduled once that date has passed`;
  if (pos.balance <= 0.005) return 'Nothing is owed on this contract';
  if (pos.instalments.some((i) => i.status === 'WRITTEN_OFF')) return 'Part of this contract was written off; reschedule it by hand';
  const scheduled = pos.instalments.reduce((s, i) => s + i.amount, 0);
  if (scheduled + 0.05 < pos.paymentsSum) return 'The payments are more than the schedule; check the contract by hand';
  return null;
}

export async function previewForContract(contractId: string, terms: Partial<Terms>) {
  const settings = await getRescheduleSettings();
  const pos = await readPosition(contractId);
  const reason = ineligibleReason(pos);
  const pending = await db.contractReschedule.findFirst({ where: { contractId, status: 'PENDING' }, select: { id: true } });
  const filled: Terms = {
    monthlyRate: terms.monthlyRate ?? settings.defaultMonthlyRate,
    frequency: (terms.frequency as PaymentFrequency) ?? (pos.contract.paymentFrequency as PaymentFrequency) ?? settings.autoFrequency,
    installments: terms.installments ?? settings.autoInstallments,
    firstDueDate: terms.firstDueDate ?? null,
  };
  const quote = reason ? null : buildQuote(pos.balance, pos.lateCharges, validateTerms(filled, settings));
  return {
    eligible: !reason && !pending,
    reason: reason ?? (pending ? 'A reschedule for this contract is already waiting for approval' : null),
    pendingId: pending?.id ?? null,
    contract: {
      contractNumber: pos.contract.contractNumber,
      endDate: pos.contract.endDate,
      originalEndDate: pos.contract.originalEndDate,
      rescheduleCount: pos.contract.rescheduleCount,
    },
    settings: { defaultMonthlyRate: settings.defaultMonthlyRate, maxMonthlyRate: settings.maxMonthlyRate },
    quote,
  };
}

// ---------------------------------------------------------------- request

export async function requestReschedule(params: {
  contractId: string;
  terms: Terms;
  adminId: string | null;
  source: 'MANUAL' | 'AUTO';
  note?: string | null;
}) {
  const settings = await getRescheduleSettings();
  const pos = await readPosition(params.contractId);
  const reason = ineligibleReason(pos);
  if (reason) throw new RescheduleError(reason, 409);
  const terms = validateTerms(params.terms, settings);
  const quote = buildQuote(pos.balance, pos.lateCharges, terms);

  // One waiting request per contract, decided in the database so two clicks
  // (or the job and a person together) cannot both raise one.
  const created = await db.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT id FROM "HirePurchaseContract" WHERE id = ${params.contractId} FOR UPDATE`;
    const waiting = await tx.contractReschedule.findFirst({ where: { contractId: params.contractId, status: 'PENDING' }, select: { id: true } });
    if (waiting) throw new RescheduleError('A reschedule for this contract is already waiting for approval', 409);
    return tx.contractReschedule.create({
      data: {
        contractId: params.contractId,
        source: params.source,
        balance: quote.balance,
        lateCharges: quote.lateCharges,
        principal: quote.principal,
        monthlyRate: quote.monthlyRate,
        termMonths: quote.termMonths,
        interest: quote.interest,
        newTotal: quote.newTotal,
        frequency: quote.frequency,
        installments: quote.installments,
        installmentAmount: quote.installmentAmount,
        firstDueDate: quote.firstDueDate,
        newEndDate: quote.newEndDate,
        oldEndDate: pos.contract.endDate,
        note: params.note?.trim() || null,
        requestedById: params.adminId,
      },
    });
  });
  await createAuditLog({
    userId: params.adminId ?? undefined,
    action: 'REQUEST_CONTRACT_RESCHEDULE',
    entity: 'HirePurchaseContract',
    entityId: params.contractId,
    newValues: { contractNumber: pos.contract.contractNumber, rescheduleId: created.id, source: params.source, ...summary(quote) },
  });
  return created;
}

function summary(q: Quote) {
  return {
    balance: q.balance, lateCharges: q.lateCharges, principal: q.principal, monthlyRate: q.monthlyRate,
    termMonths: q.termMonths, interest: q.interest, newTotal: q.newTotal, frequency: q.frequency,
    installments: q.installments, installmentAmount: q.installmentAmount,
    firstDueDate: q.firstDueDate.toISOString().slice(0, 10), newEndDate: q.newEndDate.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------- decide

/** The terms a waiting request was raised with, as they apply today. */
async function approvedTerms(request: any, today: Date) {
  const settings = await getRescheduleSettings();
  const firstDue = oneDayOnly(new Date(request.firstDueDate));
  return validateTerms(
    {
      monthlyRate: request.monthlyRate,
      frequency: request.frequency,
      installments: request.installments,
      // A first due date that has passed while waiting moves to one period from today.
      firstDueDate: firstDue > today ? firstDue : null,
    },
    // A rate allowed when it was asked for stays allowed if the ceiling is lowered since.
    { ...settings, maxMonthlyRate: Math.max(settings.maxMonthlyRate, request.monthlyRate) },
    today
  );
}

/** What approving a waiting request would do, worked out on the contract as it stands now. */
export async function currentQuoteFor(request: any): Promise<Quote> {
  const today = utcDay();
  const terms = await approvedTerms(request, today);
  const pos = await readPosition(request.contractId);
  const reason = ineligibleReason(pos, today);
  if (reason) throw new RescheduleError(reason, 409);
  return buildQuote(pos.balance, pos.lateCharges, terms, today);
}

/**
 * Approves and applies a waiting request. The figures are worked out again
 * from the contract as it stands now, since the customer may have paid since
 * the request was raised; the agreed terms (rate, frequency, number of
 * payments) are what was approved.
 */
export async function approveReschedule(id: string, adminId: string, opts: { allowSelfApproval?: boolean } = {}) {
  const { rebuildContractFromPayments, REBUILD_TX } = await import('../controllers/paymentController');
  const request = await db.contractReschedule.findUnique({ where: { id } });
  if (!request) throw new RescheduleError('Reschedule request not found', 404);
  if (request.status !== 'PENDING') throw new RescheduleError(`This request is already ${request.status.toLowerCase()}`, 409);
  if (request.requestedById && request.requestedById === adminId && !opts.allowSelfApproval) {
    throw new RescheduleError('Someone other than the person who asked for it must approve this', 403);
  }
  const today = utcDay();
  const terms = await approvedTerms(request, today);

  const result = await db.$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT id FROM "HirePurchaseContract" WHERE id = ${request.contractId} FOR UPDATE`;
    const claimed = await tx.contractReschedule.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'APPLIED', decidedById: adminId, decidedAt: new Date() },
    });
    if (claimed.count === 0) throw new RescheduleError('This request was decided by someone else just now', 409);

    const pos = await readPosition(request.contractId, tx);
    const reason = ineligibleReason(pos, today);
    if (reason) throw new RescheduleError(reason, 409);
    const quote = buildQuote(pos.balance, pos.lateCharges, terms, today);

    // Keep what has been paid, in order, from the payments themselves.
    let left = pos.paymentsSum;
    let lastKept = 0;
    for (const inst of pos.instalments) {
      const covered = roundMoney(Math.min(left, inst.amount));
      left = roundMoney(left - covered);
      if (covered >= inst.amount - 0.005) {
        lastKept = inst.installmentNo;
      } else if (covered > 0.005) {
        await tx.installmentSchedule.update({ where: { id: inst.id }, data: { amount: covered } });
        lastKept = inst.installmentNo;
      } else {
        await tx.installmentSchedule.delete({ where: { id: inst.id } });
      }
    }
    for (const row of quote.schedule) {
      await tx.installmentSchedule.create({
        data: {
          contractId: request.contractId,
          installmentNo: lastKept + row.installmentNo,
          dueDate: row.dueDate,
          amount: row.amount,
          status: 'PENDING',
        },
      });
    }

    // The late charges are now part of the price, so they stop standing on their own.
    if (pos.penaltyIds.length) {
      await tx.penalty.updateMany({
        where: { id: { in: pos.penaltyIds }, isPaid: false, isWaived: false },
        data: { isWaived: true, waivedAt: new Date(), waivedById: adminId, waiveReason: PENALTY_FOLDED_REASON },
      });
      await recomputePenaltyOutstanding(request.contractId, tx);
    }

    const added = roundMoney(quote.lateCharges + quote.interest);
    await tx.hirePurchaseContract.update({
      where: { id: request.contractId },
      data: {
        totalPrice: roundMoney(pos.contract.totalPrice + added),
        financeAmount: roundMoney((pos.contract.financeAmount ?? pos.contract.totalPrice - pos.contract.depositAmount) + added),
        installmentAmount: quote.installmentAmount,
        paymentFrequency: quote.frequency,
        totalInstallments: lastKept + quote.installments,
        endDate: quote.newEndDate,
        originalEndDate: pos.contract.originalEndDate ?? pos.contract.endDate,
        rescheduleCount: { increment: 1 },
        status: 'ACTIVE',
      },
    });
    await rebuildContractFromPayments(request.contractId, tx);

    await tx.contractReschedule.update({
      where: { id },
      data: {
        balance: quote.balance,
        lateCharges: quote.lateCharges,
        principal: quote.principal,
        termMonths: quote.termMonths,
        interest: quote.interest,
        newTotal: quote.newTotal,
        installmentAmount: quote.installmentAmount,
        firstDueDate: quote.firstDueDate,
        newEndDate: quote.newEndDate,
        oldEndDate: pos.contract.endDate,
        oldSchedule: JSON.stringify(pos.instalments.map((i) => ({
          installmentNo: i.installmentNo, dueDate: new Date(i.dueDate).toISOString().slice(0, 10),
          amount: i.amount, paidAmount: i.paidAmount, status: i.status,
        }))),
      },
    });
    return { quote, pos };
  }, REBUILD_TX);

  const { quote, pos } = result;
  await createAuditLog({
    userId: adminId,
    action: 'APPROVE_CONTRACT_RESCHEDULE',
    entity: 'HirePurchaseContract',
    entityId: request.contractId,
    oldValues: { endDate: pos.contract.endDate, totalPrice: pos.contract.totalPrice, paymentFrequency: pos.contract.paymentFrequency, totalInstallments: pos.contract.totalInstallments },
    newValues: { contractNumber: pos.contract.contractNumber, rescheduleId: id, lateChargesWaivedIntoBalance: pos.penaltyIds.length, ...summary(quote) },
  });

  // After the commit: the phone and PayTrigger follow the new schedule, and the customer is told.
  try {
    const enrolled = await db.managedDevice.findFirst({ where: { contractId: request.contractId, isActive: true }, select: { id: true } });
    if (enrolled) {
      const { evaluateManagedDeviceForContract } = await import('./deviceControlPolicyService');
      await evaluateManagedDeviceForContract(request.contractId);
    }
  } catch (err) {
    console.error('Reschedule: device check failed', request.contractId, err);
  }
  try {
    const { notifyPayTrigger } = await import('./payTrigger/events');
    notifyPayTrigger(request.contractId, 'CONTRACT_CHANGED');
  } catch { /* never blocks the approval */ }
  try {
    const phone = pos.contract.customer?.phone;
    if (phone) {
      const { sendSMS } = await import('./notificationService');
      const per = quote.frequency === 'DAILY' ? 'daily' : quote.frequency === 'WEEKLY' ? 'weekly' : 'monthly';
      await sendSMS({
        to: phone,
        message: `Dear ${pos.contract.customer.firstName}, your contract ${pos.contract.contractNumber} has been rescheduled. `
          + `New balance GHS ${quote.newTotal.toFixed(2)}, paid in ${quote.installments} ${per} payments of GHS ${quote.installmentAmount.toFixed(2)}, `
          + `first due ${quote.firstDueDate.toISOString().slice(0, 10)}, last due ${quote.newEndDate.toISOString().slice(0, 10)}.`,
      });
    }
  } catch (err) {
    console.error('Reschedule: SMS failed', request.contractId, err);
  }

  return db.contractReschedule.findUnique({ where: { id } });
}

export async function rejectReschedule(id: string, adminId: string, reason: string) {
  const text = String(reason || '').trim();
  if (text.length < 3) throw new RescheduleError('Give a reason');
  const claimed = await db.contractReschedule.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'REJECTED', decidedById: adminId, decidedAt: new Date(), rejectReason: text },
  });
  if (claimed.count === 0) throw new RescheduleError('This request is no longer waiting', 409);
  const row = await db.contractReschedule.findUnique({ where: { id }, include: { contract: { select: { contractNumber: true } } } });
  await createAuditLog({
    userId: adminId,
    action: 'REJECT_CONTRACT_RESCHEDULE',
    entity: 'HirePurchaseContract',
    entityId: row.contractId,
    newValues: { contractNumber: row.contract?.contractNumber, rescheduleId: id, reason: text },
  });
  return row;
}

// ---------------------------------------------------------------- automatic

/**
 * Contracts the daily job would raise a request for: past their end date by
 * the set number of days, still owing, under the per-contract limit, and with
 * no request already raised since their current end date (waiting, approved or
 * turned down), so a rejected one is not raised again every morning.
 */
async function autoCandidates(settings: RescheduleSettings, today: Date = utcDay()) {
  const cutoff = utcDay(-settings.autoAfterDays, today);
  const rows: Array<{ id: string; contractNumber: string }> = await db.$queryRaw`
    SELECT c.id, c."contractNumber" FROM "HirePurchaseContract" c
    WHERE c.status = 'ACTIVE' AND c."endDate" < ${cutoff} AND c."outstandingBalance" > 0
      AND c."rescheduleCount" < ${settings.maxReschedulesPerContract}
      AND NOT EXISTS (SELECT 1 FROM "ContractReschedule" r WHERE r."contractId" = c.id
                      AND (r.status = 'PENDING' OR r."createdAt" >= c."endDate"))
    ORDER BY c."endDate" ASC`;
  return rows;
}

export async function countAutoCandidates(): Promise<number> {
  const settings = await getRescheduleSettings();
  return (await autoCandidates(settings)).length;
}

export async function raiseAutomaticReschedules(opts: { force?: boolean } = {}) {
  const settings = await getRescheduleSettings();
  if (!settings.autoEnabled && !opts.force) return { enabled: false, raised: 0, skipped: 0 };
  const rows = await autoCandidates(settings);
  let raised = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      await requestReschedule({
        contractId: row.id,
        source: 'AUTO',
        adminId: null,
        terms: { monthlyRate: settings.defaultMonthlyRate, frequency: settings.autoFrequency, installments: settings.autoInstallments },
      });
      raised++;
    } catch (err) {
      skipped++;
      if (!(err instanceof RescheduleError)) console.error('Reschedule job:', row.contractNumber, err);
    }
  }
  return { enabled: true, raised, skipped };
}
