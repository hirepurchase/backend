/**
 * fixDoublePostedAllocations — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/doublePostRepairTest.ts
 *
 * Builds a contract whose last instalment was marked paid by a payment posted
 * twice, runs the repair with --reschedule-days=7, and checks the result and
 * that a Knox check (dry run) does not lock the phone.
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
import { execFileSync } from 'child_process';

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.stack?.split('\n').slice(0, 3).join('\n      ') || err}`); }
}
const DAY = 86400_000;
const utcDay = (o: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + o)); };

async function main() {
  const { default: prisma } = require('../config/database');
  const policy = require('../services/deviceControlPolicyService');
  const T = `dp${Date.now()}`;
  const n = String(Date.now()).slice(-6);
  const role = await prisma.role.upsert({ where: { name: 'AGENT' }, create: { name: 'AGENT' }, update: {} });
  const agent = await prisma.adminUser.create({ data: { email: `${T}@t.local`, password: 'x', firstName: 'Repair', lastName: 'Test', roleId: role.id } });
  const customer = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: T, firstName: 'C', lastName: 'TEST', phone: `0581${n}`.slice(0, 10), isActivated: true, createdById: agent.id } });
  // 3 weekly instalments of 100; 2 payments of 100 received; all 3 marked paid (one payment posted twice).
  const contract = await prisma.hirePurchaseContract.create({ data: {
    contractNumber: `CON81${n}`, customerId_uuid: customer.id_uuid, totalPrice: 400, depositAmount: 100, financeAmount: 300, installmentAmount: 100,
    paymentFrequency: 'WEEKLY', totalInstallments: 3, startDate: utcDay(-25), endDate: utcDay(-3), status: 'ACTIVE',
    outstandingBalance: 100, totalPaid: 300, createdById: agent.id, approvedAt: utcDay(-26), gracePeriodDays: 0 } });
  for (const [i, o] of [-17, -10, -3].entries()) {
    await prisma.installmentSchedule.create({ data: { contractId: contract.id, installmentNo: i + 1, amount: 100, paidAmount: 100, dueDate: utcDay(o), status: 'PAID', paidAt: new Date() } });
  }
  for (const k of [1, 2]) {
    await prisma.paymentTransaction.create({ data: { transactionRef: `${T}P${k}`, contractId: contract.id, customerId_uuid: customer.id_uuid, amount: 100, paymentMethod: 'HUBTEL_MOMO', status: 'SUCCESS', paymentDate: new Date() } });
  }
  await prisma.agentDepositLedger.create({ data: { contractId: contract.id, agentId: agent.id, contractNumber: contract.contractNumber, customerName: 'C TEST',
    depositAmount: 100, commissionAmount: 20, amountDueCompany: 80, amountPaid: 80, outstandingBalance: 0, status: 'PAID' } });
  const device = await prisma.managedDevice.create({ data: { contractId: contract.id, customerId_uuid: customer.id_uuid, deviceUid: `SN81${n}`, approveId: `AP81${n}`,
    enrollmentStatus: 'ACTIVE', desiredState: 'UNLOCKED', actualState: 'UNLOCKED', isActive: true } });
  let knox = await prisma.knoxGuardSettings.findFirst();
  if (!knox) knox = await prisma.knoxGuardSettings.create({ data: { id: 'singleton' } });
  const lockBefore = knox.lockAfterOverdueDays;
  await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { lockAfterOverdueDays: 1 } });

  console.log('\nDouble-posted instalment repair');
  const run = (...args: string[]) => execFileSync('npx', ['ts-node', '--transpile-only', 'src/scripts/fixDoublePostedAllocations.ts', `--only=${contract.contractNumber}`, ...args], { env: process.env, encoding: 'utf8' });

  await check('preview changes nothing and holds it back as it would become overdue', async () => {
    const out = run();
    assert.match(out, /HELD \(would become overdue[^)]*\): 1/);
    const last = await prisma.installmentSchedule.findFirst({ where: { contractId: contract.id, installmentNo: 3 } });
    assert.equal(last.status, 'PAID');
  });

  await check('apply with --reschedule-days=7: the over-credit is removed and the instalment falls due in 7 days', async () => {
    const out = run('--apply', '--include-overdue', '--reschedule-days=7');
    assert.match(out, /FIXED 1/, out);
    const inst = await prisma.installmentSchedule.findMany({ where: { contractId: contract.id }, orderBy: { installmentNo: 'asc' } });
    assert.deepEqual(inst.map((i: any) => i.status), ['PAID', 'PAID', 'PENDING']);
    assert.equal(inst[2].paidAmount, 0);
    assert.equal(inst[2].dueDate.toISOString().slice(0, 10), utcDay(7).toISOString().slice(0, 10));
    const c = await prisma.hirePurchaseContract.findUnique({ where: { id: contract.id } });
    assert.equal(c.status, 'ACTIVE');
    assert.equal(c.outstandingBalance, 100);
    assert.equal(c.endDate.toISOString().slice(0, 10), utcDay(7).toISOString().slice(0, 10), 'the end date moves with the last instalment');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'CORRECT_DOUBLE_POSTED_INSTALMENTS', entityId: contract.id } });
    const nv = JSON.parse(audit.newValues);
    assert.equal(nv.rescheduled.length, 1);
    assert.equal(JSON.parse(audit.oldValues).instalments.length, 3);
  });

  await check('a Knox check afterwards does not lock the phone (nothing overdue)', async () => {
    await policy.evaluateManagedDeviceForContract(contract.id);
    const d = await prisma.managedDevice.findUnique({ where: { id: device.id } });
    assert.equal(d.actualState, 'UNLOCKED');
  });

  await check('running it again changes nothing (already corrected)', async () => {
    const out = run('--apply', '--include-overdue', '--reschedule-days=7');
    assert.match(out, /FIXED 0/);
  });

  await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { lockAfterOverdueDays: lockBefore } });
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
