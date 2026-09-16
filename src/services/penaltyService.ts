import prisma from '../config/database';

const prismaAny = prisma as any;

export const PENALTY_KIND = {
  LATE_INSTALLMENT: 'LATE_INSTALLMENT',
  CONTRACT_EXPIRY: 'CONTRACT_EXPIRY',
} as const;

export const PENALTY_MODE = {
  FIXED: 'FIXED',
  DAILY: 'DAILY',
} as const;

export interface PenaltySettings {
  id: string;
  expiryPenaltyEnabled: boolean;
  expiryPenaltyMode: string;
  expiryPenaltyRate: number;
  expiryGraceDays: number;
  maxPenaltyPercentage: number;
  activatedAt: Date | null;
}

const DEFAULTS = {
  expiryPenaltyEnabled: false,
  expiryPenaltyMode: PENALTY_MODE.FIXED,
  expiryPenaltyRate: 0,
  expiryGraceDays: 0,
  maxPenaltyPercentage: 50,
  activatedAt: null,
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function atMidnight(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export async function getPenaltySettings(): Promise<PenaltySettings> {
  const existing = await prismaAny.penaltySettings.findFirst();
  if (existing) return existing;
  return prismaAny.penaltySettings.create({ data: { ...DEFAULTS } });
}

/**
 * The first day a contract can be charged for running past its term.
 *
 * Two things gate it, and the later of them wins. The contract's own term plus
 * any grace is the obvious one. The other is `activatedAt`: when this feature
 * was switched on there were 477 live contracts already past term owing over
 * GHS 660,000 between them. Charging from their real expiry would invent an
 * enormous bill overnight for customers who were never told the rule existed,
 * so nothing accrues for any day before the switch was flipped.
 */
export function firstChargeableDay(
  contractEndDate: Date,
  settings: PenaltySettings
): Date | null {
  if (!settings.activatedAt) return null;

  const afterTerm = new Date(contractEndDate);
  afterTerm.setDate(afterTerm.getDate() + settings.expiryGraceDays + 1);

  const afterActivation = new Date(settings.activatedAt);
  afterActivation.setDate(afterActivation.getDate() + 1);

  return atMidnight(afterTerm > afterActivation ? afterTerm : afterActivation);
}

/**
 * Keeps `contract.penaltyOutstanding` equal to what is actually unpaid.
 * It is a cached total, recomputed from the penalty rows rather than
 * incremented, so it cannot drift out of step with them.
 */
export async function recomputePenaltyOutstanding(
  contractId: string,
  tx: any = prismaAny
): Promise<number> {
  const rows = await tx.penalty.findMany({
    where: { contractId, isPaid: false },
    select: { amount: true, paidAmount: true },
  });
  const total = roundMoney(
    rows.reduce((sum: number, row: any) => sum + (row.amount - row.paidAmount), 0)
  );
  await tx.hirePurchaseContract.update({
    where: { id: contractId },
    data: { penaltyOutstanding: Math.max(0, total) },
  });
  return Math.max(0, total);
}

interface AccrualContract {
  id: string;
  contractNumber: string;
  endDate: Date;
  outstandingBalance: number;
  status: string;
  totalPrice?: number;
  depositAmount?: number;
}

/**
 * What the customer still owed at the end of a given day.
 *
 * A daily charge is for a particular day, so it has to be priced on that day's
 * balance. Pricing every backfilled day at today's figure is wrong in both
 * directions — too high if the customer has since paid, too low if a
 * subsequent charge inflated the balance — and produces a schedule nobody can
 * reconcile against the payment history.
 */
function balanceOnDay(
  contract: AccrualContract,
  payments: Array<{ amount: number; paymentDate: Date }>,
  day: Date
): number {
  if (contract.totalPrice === undefined || contract.depositAmount === undefined) {
    // Caller did not supply the history; fall back to the current balance.
    return contract.outstandingBalance;
  }
  const endOfDay = new Date(day);
  endOfDay.setHours(23, 59, 59, 999);
  const paidBy = payments
    .filter((row) => new Date(row.paymentDate).getTime() <= endOfDay.getTime())
    .reduce((sum, row) => sum + row.amount, 0);
  return Math.max(0, roundMoney(contract.totalPrice - (contract.depositAmount + paidBy)));
}

/**
 * Works out every charge a single contract is owed but has not been given yet,
 * without writing anything. Split out from the writing so it can be shown to an
 * admin as a preview before the feature is switched on — with 477 contracts in
 * scope, nobody should have to find out what this does by turning it on.
 */
export async function planExpiryPenaltiesForContract(
  contract: AccrualContract,
  settings: PenaltySettings,
  today: Date = new Date(),
  /**
   * The contract's existing expiry penalties. The batch caller passes these in
   * from one query covering the whole book — without it this function issues a
   * query per contract, which across 477 past-term contracts meant hundreds of
   * round trips to a remote pooler on every run.
   */
  existingCharges?: Array<{ dedupeKey: string | null; amount: number }>,
  /** Successful payments on this contract, so a backfilled day can be priced
   *  on the balance that actually stood on it. */
  paymentHistory?: Array<{ amount: number; paymentDate: Date }>
): Promise<Array<{ dedupeKey: string; periodDate: Date; amount: number; reason: string }>> {
  if (!settings.expiryPenaltyEnabled || settings.expiryPenaltyRate <= 0) return [];
  if (contract.status !== 'ACTIVE') return [];
  if (contract.outstandingBalance <= 0) return [];

  const start = firstChargeableDay(contract.endDate, settings);
  if (!start) return [];

  const cutoff = atMidnight(today);
  if (start > cutoff) return [];

  const existing =
    existingCharges ??
    (await prismaAny.penalty.findMany({
      where: { contractId: contract.id, kind: PENALTY_KIND.CONTRACT_EXPIRY },
      select: { dedupeKey: true, amount: true },
    }));
  const alreadyCharged = new Set(existing.map((row: any) => row.dedupeKey));
  let chargedSoFar = existing.reduce((sum: number, row: any) => sum + row.amount, 0);

  // The cap is on the total ever charged for running past term, measured
  // against the balance it is charged on.
  const ceiling = roundMoney((contract.outstandingBalance * settings.maxPenaltyPercentage) / 100);
  if (chargedSoFar >= ceiling) return [];

  const planned: Array<{ dedupeKey: string; periodDate: Date; amount: number; reason: string }> = [];

  if (settings.expiryPenaltyMode === PENALTY_MODE.FIXED) {
    // One charge for the whole overrun, however long it lasts.
    const key = `expiry:${contract.id}:fixed`;
    if (alreadyCharged.has(key)) return [];
    const amount = Math.min(
      roundMoney((contract.outstandingBalance * settings.expiryPenaltyRate) / 100),
      ceiling
    );
    if (amount <= 0) return [];
    planned.push({
      dedupeKey: key,
      periodDate: start,
      amount,
      reason: `Contract term expired with ${roundMoney(contract.outstandingBalance)} still outstanding`,
    });
    return planned;
  }

  // DAILY: one charge per day past term. Capped by day count as well as by the
  // ceiling, so a contract abandoned for a year cannot produce a year of rows
  // in one run.
  const MAX_DAYS_PER_RUN = 400;
  let cursor = new Date(start);
  let days = 0;

  while (cursor <= cutoff && days < MAX_DAYS_PER_RUN) {
    const key = `expiry:${contract.id}:${dayKey(cursor)}`;
    if (!alreadyCharged.has(key)) {
      const dayBalance = paymentHistory
        ? balanceOnDay(contract, paymentHistory, cursor)
        : contract.outstandingBalance;
      const amount = roundMoney((dayBalance * settings.expiryPenaltyRate) / 100);
      if (amount > 0) {
        const room = roundMoney(ceiling - chargedSoFar);
        if (room <= 0) break;
        const charge = Math.min(amount, room);
        planned.push({
          dedupeKey: key,
          periodDate: new Date(cursor),
          amount: charge,
          reason: `Daily penalty for ${dayKey(cursor)} — contract past term with ${dayBalance} outstanding`,
        });
        chargedSoFar = roundMoney(chargedSoFar + charge);
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    days++;
  }

  return planned;
}

/**
 * Applies expiry penalties across the whole book. `dryRun` returns exactly what
 * would be charged without writing it.
 */
export async function accrueExpiryPenalties(options: {
  dryRun?: boolean;
  /**
   * Try a rate that has not been saved yet. Only honoured for a dry run —
   * with 477 contracts already past term, an admin needs to see the bill a
   * setting would produce before committing to it, not after.
   */
  overrides?: Partial<Pick<PenaltySettings, 'expiryPenaltyMode' | 'expiryPenaltyRate' | 'expiryGraceDays' | 'maxPenaltyPercentage'>>;
} = {}): Promise<{
  enabled: boolean;
  contractsExamined: number;
  contractsCharged: number;
  penaltiesCreated: number;
  totalCharged: number;
  dryRun: boolean;
  details: Array<{ contractNumber: string; charges: number; amount: number }>;
}> {
  const dryRun = Boolean(options.dryRun);
  const stored = await getPenaltySettings();
  const settings: PenaltySettings =
    dryRun && options.overrides ? { ...stored, ...options.overrides } : stored;

  const empty = {
    enabled: settings.expiryPenaltyEnabled,
    contractsExamined: 0,
    contractsCharged: 0,
    penaltiesCreated: 0,
    totalCharged: 0,
    dryRun,
    details: [] as Array<{ contractNumber: string; charges: number; amount: number }>,
  };

  if (!settings.expiryPenaltyEnabled && !dryRun) return empty;
  if (settings.expiryPenaltyRate <= 0) return empty;

  const today = new Date();
  const contracts = await prismaAny.hirePurchaseContract.findMany({
    where: { status: 'ACTIVE', endDate: { lt: today }, outstandingBalance: { gt: 0 } },
    select: {
      id: true,
      contractNumber: true,
      endDate: true,
      outstandingBalance: true,
      status: true,
      totalPrice: true,
      depositAmount: true,
    },
  });

  // One query for the whole book instead of one per contract.
  const priorCharges = await prismaAny.penalty.findMany({
    where: {
      kind: PENALTY_KIND.CONTRACT_EXPIRY,
      contractId: { in: contracts.map((c: AccrualContract) => c.id) },
    },
    select: { contractId: true, dedupeKey: true, amount: true },
  });
  const chargesByContract = new Map<string, Array<{ dedupeKey: string | null; amount: number }>>();
  for (const row of priorCharges) {
    const list = chargesByContract.get(row.contractId) ?? [];
    list.push({ dedupeKey: row.dedupeKey, amount: row.amount });
    chargesByContract.set(row.contractId, list);
  }

  // Only DAILY prices per-day, so only DAILY pays for the payment history —
  // again as one query for the whole book rather than one per contract.
  const paymentsByContract = new Map<string, Array<{ amount: number; paymentDate: Date }>>();
  if (settings.expiryPenaltyMode === PENALTY_MODE.DAILY) {
    const payments = await prismaAny.paymentTransaction.findMany({
      where: {
        status: 'SUCCESS',
        contractId: { in: contracts.map((c: AccrualContract) => c.id) },
      },
      select: { contractId: true, amount: true, paymentDate: true },
    });
    for (const row of payments) {
      const list = paymentsByContract.get(row.contractId) ?? [];
      list.push({ amount: row.amount, paymentDate: row.paymentDate });
      paymentsByContract.set(row.contractId, list);
    }
  }

  let contractsCharged = 0;
  let penaltiesCreated = 0;
  let totalCharged = 0;
  const details: Array<{ contractNumber: string; charges: number; amount: number }> = [];

  for (const contract of contracts) {
    // In a dry run the enabled flag is bypassed above, so it has to be
    // satisfied here for the plan to be produced at all.
    // A preview of a feature not yet switched on anchors activation to
    // yesterday, so it answers the question actually being asked — what the
    // first run would charge — rather than "nothing yet, come back tomorrow".
    const previewActivation = new Date(today);
    previewActivation.setDate(previewActivation.getDate() - 1);
    const effective = dryRun
      ? { ...settings, expiryPenaltyEnabled: true, activatedAt: settings.activatedAt ?? previewActivation }
      : settings;
    const planned = await planExpiryPenaltiesForContract(
      contract,
      effective,
      today,
      chargesByContract.get(contract.id) ?? [],
      paymentsByContract.get(contract.id) ?? (settings.expiryPenaltyMode === PENALTY_MODE.DAILY ? [] : undefined)
    );
    if (planned.length === 0) continue;

    const amount = roundMoney(planned.reduce((sum, row) => sum + row.amount, 0));
    contractsCharged++;
    penaltiesCreated += planned.length;
    totalCharged = roundMoney(totalCharged + amount);
    details.push({ contractNumber: contract.contractNumber, charges: planned.length, amount });

    if (dryRun) continue;

    // skipDuplicates leans on the dedupeKey unique index: a concurrent run
    // that already wrote a charge is the constraint doing its job, not an error.
    const written = await prismaAny.penalty.createMany({
      data: planned.map((row) => ({
        contractId: contract.id,
        amount: row.amount,
        reason: row.reason,
        kind: PENALTY_KIND.CONTRACT_EXPIRY,
        dedupeKey: row.dedupeKey,
        periodDate: row.periodDate,
        appliedDate: new Date(),
      })),
      skipDuplicates: true,
    });
    if (written.count < planned.length) {
      const skipped = planned.length - written.count;
      penaltiesCreated -= skipped;
      totalCharged = roundMoney(
        totalCharged - planned.slice(written.count).reduce((sum, row) => sum + row.amount, 0)
      );
    }

    await recomputePenaltyOutstanding(contract.id);
  }

  return {
    enabled: settings.expiryPenaltyEnabled,
    contractsExamined: contracts.length,
    contractsCharged,
    penaltiesCreated,
    totalCharged,
    dryRun,
    details: details.sort((a, b) => b.amount - a.amount),
  };
}

/**
 * Applies money to a contract's unpaid penalties, oldest first, allowing part
 * payment. Returns what is left over for the caller to put against
 * installments.
 *
 * Penalties are settled *after* overdue installments, not before: the device
 * lock keys off overdue installments, so taking a customer's payment for
 * penalties first would leave them locked despite having paid exactly what
 * they were asked for.
 */
export async function allocateToPenalties(
  contractId: string,
  available: number,
  tx: any = prismaAny
): Promise<{ applied: number; remaining: number }> {
  if (available <= 0) return { applied: 0, remaining: 0 };

  const penalties = await tx.penalty.findMany({
    where: { contractId, isPaid: false },
    orderBy: [{ periodDate: 'asc' }, { appliedDate: 'asc' }],
  });

  let remaining = roundMoney(available);
  let applied = 0;

  for (const penalty of penalties) {
    if (remaining <= 0) break;
    const due = roundMoney(penalty.amount - penalty.paidAmount);
    if (due <= 0) continue;

    const pay = Math.min(remaining, due);
    const newPaid = roundMoney(penalty.paidAmount + pay);
    const settled = newPaid >= roundMoney(penalty.amount) - 0.005;

    await tx.penalty.update({
      where: { id: penalty.id },
      data: {
        paidAmount: newPaid,
        ...(settled ? { isPaid: true, paidAt: new Date() } : {}),
      },
    });

    remaining = roundMoney(remaining - pay);
    applied = roundMoney(applied + pay);
  }

  if (applied > 0) {
    await recomputePenaltyOutstanding(contractId, tx);
  }

  return { applied, remaining };
}

/**
 * Rebuilds penalty allocation from scratch for a contract whose payment
 * history has been edited.
 *
 * Editing or deleting a payment rebuilds the installment schedule from the new
 * total, but left penalty rows exactly as they were — so money that no longer
 * exists stayed credited against penalties, and a contract could show penalties
 * paid out of a payment that had since been reduced or deleted. Resets every
 * penalty, then re-applies whatever is left after the installments.
 *
 * Returns the new penalty outstanding so the caller can re-test completion:
 * a rebuild can revive penalties and must therefore be able to un-complete a
 * contract, not only complete one.
 */
export async function rebuildPenaltyAllocation(
  contractId: string,
  leftoverAfterInstallments: number,
  tx: any = prismaAny
): Promise<number> {
  await tx.penalty.updateMany({
    where: { contractId },
    data: { paidAmount: 0, isPaid: false, paidAt: null },
  });

  if (leftoverAfterInstallments > 0) {
    await allocateToPenalties(contractId, leftoverAfterInstallments, tx);
  }

  return recomputePenaltyOutstanding(contractId, tx);
}
