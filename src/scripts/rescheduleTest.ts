/**
 * Rescheduling expired contracts — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/rescheduleTest.ts
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
Object.assign(process.env, {
  KNOX_GUARD_DRY_RUN: 'true', KNOX_GUARD_ENABLE_LIVE_ACTIONS: 'false', PAYTRIGGER_DRY_RUN: 'true',
  ENABLE_SMS_NOTIFICATIONS: 'false', ENABLE_EMAIL_NOTIFICATIONS: 'false', NALO_API_KEY: '',
});
import assert from 'assert';
import * as crypto from 'crypto';

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.stack?.split('\n').slice(0, 4).join('\n      ') || err}`); }
}
const utcDay = (o: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + o)); };
const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const { default: prisma } = require('../config/database');
  const svc = require('../services/rescheduleService');
  const penalties = require('../services/penaltyService');
  const { rebuildContractFromPayments, REBUILD_TX } = require('../controllers/paymentController');
  const T = `rs${Date.now()}`;
  const n = String(Date.now()).slice(-6);
  const role = await prisma.role.upsert({ where: { name: 'ADMIN' }, create: { name: 'ADMIN' }, update: {} });
  const asker = await prisma.adminUser.create({ data: { email: `${T}a@t.local`, password: 'x', firstName: 'Asker', lastName: 'Test', roleId: role.id } });
  const approver = await prisma.adminUser.create({ data: { email: `${T}b@t.local`, password: 'x', firstName: 'Approver', lastName: 'Test', roleId: role.id } });
  let k = 0;
  async function makeContract(opts: { endOffset: number; paid: number[]; penalty?: number; status?: string }) {
    k++;
    const customer = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}${k}`, firstName: 'Ama', lastName: 'TEST', phone: `059${n}${k}`.slice(0, 10), isActivated: true, createdById: asker.id } });
    const paid = opts.paid.reduce((s, x) => s + x, 0);
    // 4 weekly instalments of 100 after a deposit of 100; the last one fell due on endOffset.
    const contract = await prisma.hirePurchaseContract.create({ data: {
      contractNumber: `CON9${n}${k}`, customerId_uuid: customer.id_uuid, totalPrice: 500, depositAmount: 100, financeAmount: 400, installmentAmount: 100,
      paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: utcDay(opts.endOffset - 28), endDate: utcDay(opts.endOffset), status: opts.status ?? 'ACTIVE',
      outstandingBalance: 400 - paid, totalPaid: 100 + paid, createdById: asker.id, approvedAt: utcDay(opts.endOffset - 29), gracePeriodDays: 0 } });
    for (let i = 0; i < 4; i++) {
      await prisma.installmentSchedule.create({ data: { contractId: contract.id, installmentNo: i + 1, amount: 100, dueDate: utcDay(opts.endOffset - 21 + i * 7), status: 'PENDING' } });
    }
    for (const [j, a] of opts.paid.entries()) {
      await prisma.paymentTransaction.create({ data: { transactionRef: `${T}${k}P${j}`, contractId: contract.id, customerId_uuid: customer.id_uuid, amount: a, paymentMethod: 'HUBTEL_MOMO', status: 'SUCCESS', paymentDate: utcDay(opts.endOffset - 20) } });
    }
    if (opts.penalty) {
      await prisma.penalty.create({ data: { contractId: contract.id, amount: opts.penalty, reason: 'Contract term expired', kind: 'CONTRACT_EXPIRY', dedupeKey: `expiry:${contract.id}:fixed`, periodDate: utcDay(opts.endOffset + 1) } });
      await penalties.recomputePenaltyOutstanding(contract.id);
    }
    await prisma.$transaction((tx: any) => rebuildContractFromPayments(contract.id, tx), REBUILD_TX);
    return { contract, customer };
  }
  const reload = (id: string) => prisma.hirePurchaseContract.findUnique({ where: { id }, include: { installments: { orderBy: { installmentNo: 'asc' } } } });
  const invariant = async (id: string) => {
    const c = await reload(id);
    const unpaid = r2(c.installments.reduce((s: number, i: any) => s + i.amount - i.paidAmount, 0));
    assert.equal(unpaid, r2(c.outstandingBalance), `unpaid instalments ${unpaid} = outstanding ${c.outstandingBalance}`);
    assert.equal(r2(c.installments.reduce((s: number, i: any) => s + i.amount, 0)), r2(c.totalPrice - c.depositAmount), 'schedule adds up to the price less deposit');
    return c;
  };

  const settingsBefore = await svc.getRescheduleSettings();
  await svc.saveRescheduleSettings({ autoEnabled: false, autoAfterDays: 7, defaultMonthlyRate: 5, maxMonthlyRate: 20, autoFrequency: 'WEEKLY', autoInstallments: 4, maxReschedulesPerContract: 2 }, asker.id);

  console.log('\nFigures');
  await check('months between days: whole months, then days as thirtieths', async () => {
    assert.equal(svc.monthsBetween(new Date('2026-11-24'), new Date('2027-02-24')), 3);
    assert.equal(svc.monthsBetween(new Date('2026-11-24'), new Date('2026-12-22')), 0.93);
    assert.equal(svc.monthsBetween(new Date('2026-11-24'), new Date('2027-01-19')), 1.87);
  });
  await check('quote: balance + late charges, flat interest per month of the new term, last payment takes the rounding', async () => {
    const q = svc.buildQuote(250, 30, { monthlyRate: 5, frequency: 'MONTHLY', installments: 3, firstDueDate: new Date('2026-12-24') }, new Date('2026-11-24'));
    assert.equal(q.principal, 280);
    assert.equal(q.termMonths, 3);
    assert.equal(q.interest, 42);
    assert.equal(q.newTotal, 322);
    assert.deepEqual(q.schedule.map((s: any) => s.amount), [107.34, 107.34, 107.32]);
    assert.equal(q.newEndDate.toISOString().slice(0, 10), '2027-02-24');
  });

  console.log('\nAsking');
  const A = await makeContract({ endOffset: -10, paid: [100, 50], penalty: 30 });
  const device = await prisma.managedDevice.create({ data: { contractId: A.contract.id, customerId_uuid: A.customer.id_uuid, deviceUid: `SN9${n}`, approveId: `AP9${n}`,
    enrollmentStatus: 'ACTIVE', desiredState: 'LOCKED', actualState: 'LOCKED', isActive: true } });
  let requestId = '';

  await check('a contract still in its term cannot be rescheduled', async () => {
    const B = await makeContract({ endOffset: 5, paid: [100] });
    const p = await svc.previewForContract(B.contract.id, {});
    assert.equal(p.eligible, false);
    assert.match(p.reason, /once that date has passed/);
  });
  await check('preview of an expired contract: balance 250, late charges 30, default rate', async () => {
    const p = await svc.previewForContract(A.contract.id, { frequency: 'WEEKLY', installments: 4 });
    assert.equal(p.eligible, true, p.reason);
    assert.equal(p.quote.balance, 250);
    assert.equal(p.quote.lateCharges, 30);
    assert.equal(p.quote.monthlyRate, 5);
    assert.equal(p.quote.schedule.length, 4);
  });
  await check('a rate over the ceiling, a first due date in the past and too many payments are refused', async () => {
    await assert.rejects(svc.requestReschedule({ contractId: A.contract.id, adminId: asker.id, source: 'MANUAL', terms: { monthlyRate: 25, frequency: 'WEEKLY', installments: 4 } }), /from 0 to 20%/);
    await assert.rejects(svc.requestReschedule({ contractId: A.contract.id, adminId: asker.id, source: 'MANUAL', terms: { monthlyRate: 5, frequency: 'WEEKLY', installments: 4, firstDueDate: utcDay(0).toISOString().slice(0, 10) } }), /after today/);
    await assert.rejects(svc.requestReschedule({ contractId: A.contract.id, adminId: asker.id, source: 'MANUAL', terms: { monthlyRate: 5, frequency: 'MONTHLY', installments: 40 } }), /1 to 36/);
  });
  await check('asking changes nothing on the contract', async () => {
    const row = await svc.requestReschedule({ contractId: A.contract.id, adminId: asker.id, source: 'MANUAL', note: 'Customer asked', terms: { monthlyRate: 5, frequency: 'WEEKLY', installments: 4 } });
    requestId = row.id;
    assert.equal(row.status, 'PENDING');
    const c = await reload(A.contract.id);
    assert.equal(c.totalPrice, 500);
    assert.equal(c.installments.length, 4);
    assert.equal(c.rescheduleCount, 0);
  });
  await check('a second request while one is waiting is refused', async () => {
    await assert.rejects(svc.requestReschedule({ contractId: A.contract.id, adminId: approver.id, source: 'MANUAL', terms: { monthlyRate: 5, frequency: 'WEEKLY', installments: 4 } }), /already waiting/);
  });
  await check('the person who asked cannot approve it', async () => {
    await assert.rejects(svc.approveReschedule(requestId, asker.id), /Someone other than/);
  });

  console.log('\nApproving');
  // The customer pays 20 while the request waits.
  await prisma.paymentTransaction.create({ data: { transactionRef: `${T}LATE`, contractId: A.contract.id, customerId_uuid: A.customer.id_uuid, amount: 20, paymentMethod: 'HUBTEL_MOMO', status: 'SUCCESS', paymentDate: new Date() } });
  await check('the figures shown to the approver follow the payment made since', async () => {
    const q = await svc.currentQuoteFor(await prisma.contractReschedule.findUnique({ where: { id: requestId } }));
    assert.equal(q.balance, 230);
    assert.equal(q.principal, 260);
  });
  let applied: any;
  await check('approval: paid instalments kept, part-paid one closed at what was paid, new schedule appended', async () => {
    const firstBefore = await prisma.installmentSchedule.findFirst({ where: { contractId: A.contract.id, installmentNo: 1 } });
    await new Promise((r) => setTimeout(r, 20));
    applied = await svc.approveReschedule(requestId, approver.id);
    const firstAfter = await prisma.installmentSchedule.findFirst({ where: { contractId: A.contract.id, installmentNo: 1 } });
    assert.equal(firstAfter.paidAt.toISOString(), firstBefore.paidAt.toISOString(), 'a paid instalment keeps the day it was paid');
    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.principal, 260);
    const c = await invariant(A.contract.id);
    assert.deepEqual(c.installments.map((i: any) => [i.installmentNo, i.amount, i.status]).slice(0, 2), [[1, 100, 'PAID'], [2, 70, 'PAID']]);
    const fresh = c.installments.slice(2);
    assert.equal(fresh.length, 4);
    assert.deepEqual(fresh.map((i: any) => i.installmentNo), [3, 4, 5, 6]);
    assert.ok(fresh.every((i: any) => i.status === 'PENDING' && i.dueDate > new Date()));
    assert.equal(r2(fresh.reduce((s: number, i: any) => s + i.amount, 0)), applied.newTotal);
    assert.equal(c.outstandingBalance, applied.newTotal);
    assert.equal(c.totalPrice, r2(500 + 30 + applied.interest));
    assert.equal(c.endDate.toISOString(), new Date(applied.newEndDate).toISOString());
    assert.equal(c.originalEndDate.toISOString().slice(0, 10), utcDay(-10).toISOString().slice(0, 10));
    assert.equal(c.rescheduleCount, 1);
    assert.equal(c.paymentFrequency, 'WEEKLY');
    assert.equal(c.totalInstallments, 6);
    assert.equal(c.status, 'ACTIVE');
    assert.equal(JSON.parse(applied.oldSchedule).length, 4);
  });
  await check('the late charge is waived as added to the balance, and no longer owed on its own', async () => {
    const p = await prisma.penalty.findFirst({ where: { contractId: A.contract.id } });
    assert.equal(p.isWaived, true);
    assert.equal(p.waiveReason, penalties.PENALTY_FOLDED_REASON);
    const c = await reload(A.contract.id);
    assert.equal(c.penaltyOutstanding, 0);
  });
  await check('the phone is let go: nothing is overdue now', async () => {
    const d = await prisma.managedDevice.findUnique({ where: { id: device.id } });
    assert.equal(d.desiredState, 'UNLOCKED', `desired ${d.desiredState}, actual ${d.actualState}`);
  });
  await check('approving again is refused', async () => {
    await assert.rejects(svc.approveReschedule(requestId, approver.id), /already applied/);
  });
  await check('an audit entry records the approval', async () => {
    const a = await prisma.auditLog.findFirst({ where: { action: 'APPROVE_CONTRACT_RESCHEDULE', entityId: A.contract.id } });
    assert.ok(a);
    assert.equal(JSON.parse(a.newValues).principal, 260);
  });
  await check('removing a payment afterwards keeps the schedule and balance in step', async () => {
    await prisma.paymentTransaction.update({ where: { transactionRef: `${T}LATE` }, data: { status: 'REVERSED' } });
    await prisma.$transaction((tx: any) => rebuildContractFromPayments(A.contract.id, tx), REBUILD_TX);
    const c = await invariant(A.contract.id);
    assert.equal(c.installments[1].status, 'PARTIAL');
    assert.equal(c.outstandingBalance, r2(applied.newTotal + 20));
    await prisma.paymentTransaction.update({ where: { transactionRef: `${T}LATE` }, data: { status: 'SUCCESS' } });
    await prisma.$transaction((tx: any) => rebuildContractFromPayments(A.contract.id, tx), REBUILD_TX);
    await invariant(A.contract.id);
  });
  await check('late charges for a later expiry start afresh: the folded charge does not count against the cap', async () => {
    const c = await reload(A.contract.id);
    const settings = { expiryPenaltyEnabled: true, expiryPenaltyMode: 'FIXED', expiryPenaltyRate: 10, expiryGraceDays: 0, maxPenaltyPercentage: 10, activatedAt: utcDay(-400), notifyCustomer: false };
    const existing = await prisma.penalty.findMany({ where: { contractId: c.id, kind: 'CONTRACT_EXPIRY' }, select: { dedupeKey: true, amount: true, waiveReason: true } });
    const later = new Date(c.endDate.getTime() + 3 * 86400_000);
    const planned = await penalties.planExpiryPenaltiesForContract({ ...c }, settings, later, existing);
    assert.equal(planned.length, 1, 'a fixed charge for the new term');
    assert.equal(planned[0].dedupeKey, `expiry:${c.id}:fixed:r1`);
  });

  console.log('\nTurning down and the daily job');
  const C = await makeContract({ endOffset: -12, paid: [100] });
  const D = await makeContract({ endOffset: -3, paid: [100] });
  await check('with the switch off the job raises nothing', async () => {
    const r = await svc.raiseAutomaticReschedules();
    assert.equal(r.enabled, false);
    assert.equal(await prisma.contractReschedule.count({ where: { contractId: C.contract.id } }), 0);
  });
  await check('switched on: a request for a contract 12 days past its end, none for one 3 days past', async () => {
    await svc.saveRescheduleSettings({ autoEnabled: true }, asker.id);
    await svc.raiseAutomaticReschedules();
    const rows = await prisma.contractReschedule.findMany({ where: { contractId: C.contract.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'AUTO');
    assert.equal(rows[0].requestedById, null);
    assert.equal(rows[0].installments, 4);
    assert.equal(await prisma.contractReschedule.count({ where: { contractId: D.contract.id } }), 0);
  });
  await check('running again raises no second request', async () => {
    await svc.raiseAutomaticReschedules();
    assert.equal(await prisma.contractReschedule.count({ where: { contractId: C.contract.id } }), 1);
  });
  await check('turned down with a reason, and not raised again for the same end date', async () => {
    const row = await prisma.contractReschedule.findFirst({ where: { contractId: C.contract.id } });
    await assert.rejects(svc.rejectReschedule(row.id, approver.id, ''), /Give a reason/);
    const out = await svc.rejectReschedule(row.id, approver.id, 'Customer will pay in full');
    assert.equal(out.status, 'REJECTED');
    await svc.raiseAutomaticReschedules();
    assert.equal(await prisma.contractReschedule.count({ where: { contractId: C.contract.id } }), 1);
    const c = await reload(C.contract.id);
    assert.equal(c.totalPrice, 500);
  });
  await check('an automatic request can be approved by anyone with the right', async () => {
    await prisma.contractReschedule.deleteMany({ where: { contractId: C.contract.id } });
    await svc.raiseAutomaticReschedules();
    const row = await prisma.contractReschedule.findFirst({ where: { contractId: C.contract.id, status: 'PENDING' } });
    const out = await svc.approveReschedule(row.id, asker.id);
    assert.equal(out.status, 'APPLIED');
    await invariant(C.contract.id);
  });
  await check('a contract already rescheduled is not raised again by the job while in its new term', async () => {
    await svc.raiseAutomaticReschedules();
    assert.equal(await prisma.contractReschedule.count({ where: { contractId: A.contract.id } }), 1);
  });
  await check('a written-off or completed contract cannot be rescheduled', async () => {
    const E = await makeContract({ endOffset: -20, paid: [100], status: 'WRITTEN_OFF' });
    assert.match((await svc.previewForContract(E.contract.id, {})).reason, /written off/);
  });

  await svc.saveRescheduleSettings({ ...settingsBefore, id: undefined, updatedAt: undefined, updatedById: undefined, createdAt: undefined }, asker.id);
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
