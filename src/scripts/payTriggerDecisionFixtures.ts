import assert from 'assert';
import { decide, DecideInput, LOCK_NOW_LEAD_MS } from '../services/payTrigger/decide';

/**
 * Fixture contracts for decide(). Run from `npm run paytrigger:check`.
 * Each states a situation and the action + lock date it must produce.
 */

const NOW = new Date('2026-10-05T10:00:00');
const day = (offset: number, h = 0, m = 0) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d;
};
const lockAt = (dueOffset: number, grace = 0, after = 1) => day(dueOffset + grace + after, 8, 30);

/** A 4-instalment weekly contract; instalment 1 paid, 2 due in 3 days. */
function base(): DecideInput {
  return {
    contract: {
      id: 'c1',
      contractNumber: 'CON-T1',
      status: 'ACTIVE',
      gracePeriodDays: 0,
      totalPrice: 2000,
      totalPaid: 800,
      totalInstallments: 4,
      endDate: day(17),
      approvedAt: day(-10),
    },
    installments: [
      { installmentNo: 1, dueDate: day(-4), amount: 400, paidAmount: 400, status: 'PAID' },
      { installmentNo: 2, dueDate: day(3), amount: 400, paidAmount: 0, status: 'PENDING' },
      { installmentNo: 3, dueDate: day(10), amount: 400, paidAmount: 0, status: 'PENDING' },
      { installmentNo: 4, dueDate: day(17), amount: 400, paidAmount: 0, status: 'PENDING' },
    ],
    tempUnlocks: [],
    depositLedger: { outstandingBalance: 0 },
    penaltiesOwed: 0,
    device: { enrollmentStatus: 'ACTIVE', providerExpiresAt: day(3, 8, 30), activated: true },
    settings: { lockAfterOverdueDays: 1, lockOnUnpaidAgentDeposit: true, holdOnUnpaidPenalties: false, maxUnlockHorizonDays: 45 },
    now: NOW,
  };
}

type Patch = (i: DecideInput) => void;
const make = (patch: Patch) => {
  const i = base();
  patch(i);
  return i;
};
const overdue = (dueOffset: number): Patch => (i) => {
  i.installments[1].dueDate = day(dueOffset);
  i.installments[1].status = 'OVERDUE';
};
const lockNowAt = new Date(NOW.getTime() + LOCK_NOW_LEAD_MS);

interface Fixture {
  name: string;
  input: DecideInput;
  action: string;
  at?: Date | null; // null = nothing sent
  hold?: boolean;
}

const fixtures: Fixture[] = [
  { name: 'current → open until next instalment is a day late', input: base(), action: 'EXTEND', at: lockAt(3) },
  { name: 'grace period pushes the lock date out', input: make((i) => { i.contract.gracePeriodDays = 2; }), action: 'EXTEND', at: lockAt(3, 2) },
  { name: 'lockAfterOverdueDays = 3 pushes it further', input: make((i) => { i.settings.lockAfterOverdueDays = 3; }), action: 'EXTEND', at: lockAt(3, 0, 3) },
  { name: 'due today → still open until tomorrow 08:30', input: make(overdue(0)), action: 'EXTEND', at: lockAt(0) },
  { name: '1 day late, phone still open → lock in a minute', input: make(overdue(-1)), action: 'LOCK', at: lockNowAt },
  { name: '1 day late, phone already past its date → nothing to send', input: make((i) => { overdue(-1)(i); i.device.providerExpiresAt = day(0, 8, 30); }), action: 'LOCK', at: null },
  { name: '40 days late → locked', input: make((i) => { overdue(-40)(i); i.device.providerExpiresAt = day(-39); }), action: 'LOCK', at: null },
  { name: 'part-paid instalment still counts as unpaid', input: make((i) => { overdue(-2)(i); i.installments[1].paidAmount = 399; i.installments[1].status = 'PARTIAL'; }), action: 'LOCK', at: lockNowAt },
  { name: 'customer pays the late instalment → open to the next one', input: make((i) => { overdue(-2)(i); i.installments[1].paidAmount = 400; i.installments[1].status = 'PAID'; i.device.providerExpiresAt = day(-1); }), action: 'EXTEND', at: lockAt(10) },
  { name: 'temporary unlock live while overdue → open to window end + 6h', input: make((i) => { overdue(-5)(i); i.tempUnlocks = [{ status: 'APPROVED', expiresAt: day(14, 8, 5) }]; }), action: 'EXTEND', at: new Date(day(14, 8, 5).getTime() + 6 * 3600_000) },
  { name: 'temporary unlock expired → back to lock', input: make((i) => { overdue(-5)(i); i.tempUnlocks = [{ status: 'APPROVED', expiresAt: day(-1) }]; }), action: 'LOCK', at: lockNowAt },
  { name: 'temporary unlock revoked → lock in a minute', input: make((i) => { overdue(-5)(i); i.tempUnlocks = [{ status: 'REVOKED', expiresAt: day(14) }]; }), action: 'LOCK', at: lockNowAt },
  { name: 'temporary unlock outranks unpaid deposit', input: make((i) => { i.depositLedger = { outstandingBalance: 300 }; i.tempUnlocks = [{ status: 'APPROVED', expiresAt: day(7) }]; }), action: 'EXTEND', at: new Date(day(7).getTime() + 6 * 3600_000) },
  { name: 'temporary unlock shorter than the schedule keeps the schedule', input: make((i) => { i.tempUnlocks = [{ status: 'APPROVED', expiresAt: day(1) }]; }), action: 'EXTEND', at: lockAt(3) },
  { name: 'agent deposit unpaid, phone locked since activation → held, nothing sent', input: make((i) => { i.depositLedger = { outstandingBalance: 300 }; i.device.providerExpiresAt = null; }), action: 'HOLD', at: null, hold: true },
  { name: 'agent deposit unpaid but phone open → pulled shut', input: make((i) => { i.depositLedger = { outstandingBalance: 300 }; }), action: 'HOLD', at: lockNowAt, hold: true },
  { name: 'approved but ledger not created yet → held (fail closed)', input: make((i) => { i.depositLedger = null; i.device.providerExpiresAt = null; }), action: 'HOLD', at: null, hold: true },
  { name: 'admin-created contract (never approved, no ledger) → not held', input: make((i) => { i.depositLedger = null; i.contract.approvedAt = null; }), action: 'EXTEND', at: lockAt(3) },
  { name: 'deposit hold switched off → not held', input: make((i) => { i.depositLedger = { outstandingBalance: 300 }; i.settings.lockOnUnpaidAgentDeposit = false; }), action: 'EXTEND', at: lockAt(3) },
  { name: 'agent remits → opens to the schedule', input: make((i) => { i.depositLedger = { outstandingBalance: 0 }; i.device.providerExpiresAt = null; }), action: 'EXTEND', at: lockAt(3) },
  { name: 'monthly gap longer than horizon → clamped to 45 days', input: make((i) => { i.installments[1].dueDate = day(80); i.contract.endDate = day(200); }), action: 'EXTEND', at: new Date(NOW.getTime() + 45 * 86400_000) },
  { name: 'never past the contract end', input: make((i) => { i.installments.forEach((x) => { x.status = 'PAID'; x.paidAmount = x.amount; }); i.contract.endDate = day(2); }), action: 'EXTEND', at: lockAt(2) },
  { name: 'unpaid penalties, hold off → open', input: make((i) => { i.penaltiesOwed = 50; }), action: 'EXTEND', at: lockAt(3) },
  { name: 'unpaid penalties, hold on, phone open → never starts a lock', input: make((i) => { i.penaltiesOwed = 50; i.settings.holdOnUnpaidPenalties = true; }), action: 'EXTEND', at: lockAt(3) },
  { name: 'unpaid penalties, hold on, phone locked → stays locked', input: make((i) => { i.penaltiesOwed = 50; i.settings.holdOnUnpaidPenalties = true; i.device.providerExpiresAt = day(-1); }), action: 'LOCK', at: null },
  { name: 'completed → release', input: make((i) => { i.contract.status = 'COMPLETED'; }), action: 'RELEASE' },
  { name: 'cancelled before activation → cancel enrolment', input: make((i) => { i.contract.status = 'CANCELLED'; i.device.activated = false; }), action: 'CANCEL' },
  { name: 'cancelled after activation → nothing, stays locked', input: make((i) => { i.contract.status = 'CANCELLED'; }), action: 'NONE' },
  { name: 'written off → nothing', input: make((i) => { i.contract.status = 'WRITTEN_OFF'; }), action: 'NONE' },
  { name: 'defaulted → nothing', input: make((i) => { i.contract.status = 'DEFAULTED'; }), action: 'NONE' },
  { name: 'pending approval → nothing', input: make((i) => { i.contract.status = 'PENDING_APPROVAL'; }), action: 'NONE' },
];

export async function runDecisionFixtures(check: (name: string, fn: () => void) => Promise<void>): Promise<void> {
  for (const f of fixtures) {
    await check(f.name, () => {
      const d = decide(f.input);
      assert.strictEqual(d.action, f.action, `action ${d.action} (${d.reason})`);
      if (f.at !== undefined) {
        assert.strictEqual(d.nextRepayTime?.toISOString() ?? null, f.at?.toISOString() ?? null, 'lock date');
      }
      if (f.hold !== undefined) assert.strictEqual(d.depositHold, f.hold, 'deposit hold');
      if (d.action === 'EXTEND') assert.ok(d.nextRepayTime && d.nextRepayTime > NOW, 'EXTEND must send a future date');
    });
  }

  await check('fingerprint is stable for "lock now" across calls', () => {
    const a = decide(make(overdue(-2)));
    const b = decide({ ...make(overdue(-2)), now: new Date(NOW.getTime() + 5000) });
    assert.strictEqual(a.fingerprint, b.fingerprint);
  });
  await check('fingerprint changes when a payment lands', () => {
    const a = decide(base());
    const b = decide(make((i) => { i.contract.totalPaid = 1200; i.installments[1].paidAmount = 400; i.installments[1].status = 'PAID'; }));
    assert.notStrictEqual(a.fingerprint, b.fingerprint);
  });
  await check('amounts and terms are always real numbers', () => {
    const d = decide(base());
    assert.deepStrictEqual([d.repayedAmt, d.totalAmt, d.currentTerm, d.totalTerm, d.nextRepayAmt], [800, 2000, 2, 4, 400]);
  });
}
