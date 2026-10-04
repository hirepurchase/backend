import * as crypto from 'crypto';

/**
 * What a Transsion phone should be doing, from the contract alone.
 *
 * Pure: no database, no network, no clock except `now`. Everything the sidecar
 * does to a handset starts here, so this is the part the fixtures pin down.
 *
 * PayTrigger is expiration-driven — the phone locks itself when its lock date
 * passes, online or not. So "unlocked" means "lock date pushed into the future"
 * and "lock" means "lock date pulled to a minute from now". The rules mirror
 * Knox's evaluateManagedDeviceForContract so a Samsung and a Transsion customer
 * in the same position are treated the same:
 *
 *   - an approved temporary unlock outranks every reason to lock;
 *   - an unremitted agent deposit holds the phone locked whatever the customer
 *     has paid (ACTIVE contracts only);
 *   - the phone locks once the earliest unpaid instalment is
 *     `lockAfterOverdueDays` past its due date + grace — the same day Knox's
 *     morning run would lock it;
 *   - late charges never cause a lock; with holdOnUnpaidPenalties on they keep
 *     an existing one in place.
 */

export type DecisionAction = 'EXTEND' | 'HOLD' | 'LOCK' | 'RELEASE' | 'CANCEL' | 'NONE';

export interface DecideInput {
  contract: {
    id: string;
    contractNumber: string;
    status: string;
    gracePeriodDays: number;
    totalPrice: number;
    totalPaid: number;
    totalInstallments: number;
    endDate: Date;
    approvedAt: Date | null;
  };
  installments: Array<{ installmentNo: number; dueDate: Date; amount: number; paidAmount: number; status: string }>;
  tempUnlocks: Array<{ status: string; expiresAt: Date | null }>;
  /** null when no ledger row exists for the contract. */
  depositLedger: { outstandingBalance: number } | null;
  penaltiesOwed: number;
  device: {
    enrollmentStatus: string;
    /** When PayTrigger last accepted a lock date; null before the first push. */
    providerExpiresAt: Date | null;
    activated: boolean;
  };
  settings: {
    lockAfterOverdueDays: number;
    lockOnUnpaidAgentDeposit: boolean;
    holdOnUnpaidPenalties: boolean;
    maxUnlockHorizonDays: number;
  };
  now: Date;
}

export interface Decision {
  action: DecisionAction;
  reason: string;
  /** The lock date to send. Absent when nothing needs sending. */
  nextRepayTime?: Date;
  /** The lock date the schedule implies, before clamping — shown to admins. */
  scheduleExpiresAt?: Date;
  depositHold: boolean;
  nextRepayAmt?: number;
  repayedAmt: number;
  totalAmt: number;
  currentTerm?: number;
  totalTerm: number;
  fingerprint: string;
}

/** Hour of day the lock date falls on — just before Knox's 08:32 run. */
const LOCK_HOUR = 8;
const LOCK_MINUTE = 30;
/** A revoked or overdue phone is told to lock this far ahead; PayTrigger refuses past dates. */
export const LOCK_NOW_LEAD_MS = 60_000;
/** Slack after a temporary unlock window ends, so the 08:05 expiry job runs first. */
const TEMP_UNLOCK_SLACK_MS = 6 * 3600_000;

const DAY_MS = 86400_000;
/** How stale a capped lock date may get before it is pushed out again. */
const HORIZON_REFRESH_MS = 7 * DAY_MS;
const round2 = (n: number) => Math.round(n * 100) / 100;

function lockMomentFor(dueDate: Date, graceDays: number, lockAfterDays: number): Date {
  const d = new Date(dueDate);
  d.setDate(d.getDate() + graceDays + lockAfterDays);
  d.setHours(LOCK_HOUR, LOCK_MINUTE, 0, 0);
  return d;
}

function liveTempUnlockEnd(rows: DecideInput['tempUnlocks'], now: Date): Date | null {
  let end: Date | null = null;
  for (const row of rows) {
    if (row.status !== 'APPROVED' || !row.expiresAt || row.expiresAt.getTime() <= now.getTime()) continue;
    if (!end || row.expiresAt > end) end = row.expiresAt;
  }
  return end;
}

function fingerprintOf(parts: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export function decide(input: DecideInput): Decision {
  const { contract, settings, device, now } = input;

  const unpaid = [...input.installments]
    .filter((i) => i.status !== 'PAID' && i.status !== 'WRITTEN_OFF' && i.paidAmount + 0.005 < i.amount)
    .sort((a, b) => a.installmentNo - b.installmentNo);
  const next = unpaid[0];

  const amounts = {
    repayedAmt: round2(contract.totalPaid),
    totalAmt: round2(contract.totalPrice),
    totalTerm: Math.min(1000, Math.max(1, contract.totalInstallments)),
    currentTerm: next ? Math.min(1000, Math.max(1, next.installmentNo)) : undefined,
    nextRepayAmt: next ? round2(next.amount - next.paidAmount) : undefined,
  };

  const providerOpen = !!device.providerExpiresAt && device.providerExpiresAt.getTime() > now.getTime();
  const lockNow = () => (providerOpen ? new Date(now.getTime() + LOCK_NOW_LEAD_MS) : undefined);

  const result = (
    action: DecisionAction,
    reason: string,
    extra: { nextRepayTime?: Date; scheduleExpiresAt?: Date; depositHold?: boolean; lockNow?: boolean } = {},
  ): Decision => ({
    action,
    reason,
    nextRepayTime: extra.nextRepayTime,
    scheduleExpiresAt: extra.scheduleExpiresAt,
    depositHold: !!extra.depositHold,
    ...amounts,
    // "Lock now" carries a moving timestamp; fingerprint the intent instead, so
    // a phone already told to lock is not told again on every event.
    fingerprint: fingerprintOf({
      action,
      at: extra.lockNow ? 'NOW' : extra.nextRepayTime?.toISOString() ?? null,
      hold: !!extra.depositHold,
      ...amounts,
    }),
  });

  // ── Contract states that are not live hire purchase ──────────────────────
  if (contract.status === 'COMPLETED') {
    return result('RELEASE', 'Contract paid off — release after the hold period.');
  }
  if (contract.status === 'CANCELLED') {
    if (!device.activated) return result('CANCEL', 'Cancelled before activation — cancel enrolment and return the licence.');
    // The phone is back in stock (or should be): shut it now rather than
    // leaving it usable until the lock date it was last given.
    return providerOpen
      ? result('LOCK', 'Cancelled — the phone is locked like any unsold stock.', { nextRepayTime: lockNow(), lockNow: true })
      : result('NONE', 'Cancelled after activation — lock date is never extended, so the phone stays locked.');
  }
  if (contract.status === 'WRITTEN_OFF' || contract.status === 'DEFAULTED') {
    return result('NONE', `Contract ${contract.status.toLowerCase().replace('_', ' ')} — lock date is never extended.`);
  }
  if (contract.status !== 'ACTIVE') {
    return result('NONE', `Contract is ${contract.status} — nothing to send until it is active.`);
  }

  // ── ACTIVE ───────────────────────────────────────────────────────────────
  const horizon = new Date(now.getTime() + settings.maxUnlockHorizonDays * DAY_MS);
  const contractEnd = lockMomentFor(contract.endDate, contract.gracePeriodDays, settings.lockAfterOverdueDays);
  const clamp = (d: Date) => new Date(Math.min(d.getTime(), horizon.getTime(), Math.max(contractEnd.getTime(), now.getTime() + LOCK_NOW_LEAD_MS)));

  const schedule = next
    ? lockMomentFor(next.dueDate, contract.gracePeriodDays, settings.lockAfterOverdueDays)
    : horizon; // nothing unpaid but not yet completed: keep it open while the status catches up

  // An approved temporary unlock outranks everything, the deposit hold included.
  const tempEnd = liveTempUnlockEnd(input.tempUnlocks, now);
  if (tempEnd) {
    const windowEnd = new Date(tempEnd.getTime() + TEMP_UNLOCK_SLACK_MS);
    const target = schedule > windowEnd ? clamp(schedule) : windowEnd;
    return result('EXTEND', 'Approved temporary unlock in force.', { nextRepayTime: target, scheduleExpiresAt: schedule });
  }

  // Agent deposit. The ledger row is written after approval, in the
  // background, so an approved contract with no row yet is treated as unpaid:
  // fail closed, and the Issues page flags it if the row never appears.
  if (settings.lockOnUnpaidAgentDeposit) {
    const ledgerOwed = !!input.depositLedger && input.depositLedger.outstandingBalance > 0.005;
    const ledgerMissing = !input.depositLedger && !!contract.approvedAt;
    if (ledgerOwed || ledgerMissing) {
      const at = lockNow();
      return result(
        'HOLD',
        ledgerMissing ? 'Approved, deposit ledger not created yet — held locked (fail closed).' : 'Agent has not remitted the deposit — held locked.',
        { nextRepayTime: at, scheduleExpiresAt: schedule, depositHold: true, lockNow: true },
      );
    }
  }

  if (schedule.getTime() <= now.getTime()) {
    return result('LOCK', `Instalment ${next?.installmentNo} is overdue past the lock threshold.`, {
      nextRepayTime: lockNow(),
      scheduleExpiresAt: schedule,
      lockNow: true,
    });
  }

  // Late charges hold a lock that is already in place; they never start one.
  if (settings.holdOnUnpaidPenalties && input.penaltiesOwed > 0.005 && device.activated && !providerOpen) {
    return result('LOCK', 'Arrears cleared but late charges are unpaid — lock kept in place.', {
      scheduleExpiresAt: schedule,
      lockNow: true,
    });
  }

  // A lock date further off than the cap is sent as "now + cap", which moves
  // every time we look. Keep the date the phone already holds until it is a
  // week short of the cap, so a monthly payer is refreshed weekly, not on
  // every payment event and every morning sweep.
  let target = clamp(schedule);
  const held = device.providerExpiresAt?.getTime();
  if (schedule.getTime() > horizon.getTime() && held && held <= target.getTime() && held >= target.getTime() - HORIZON_REFRESH_MS) {
    target = device.providerExpiresAt as Date;
  }
  return result('EXTEND', next ? `Current — open until instalment ${next.installmentNo} is overdue.` : 'Nothing unpaid — open while the contract completes.', {
    nextRepayTime: target,
    scheduleExpiresAt: schedule,
  });
}
