/**
 * Split-commission integration test — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/completionCommissionTest.ts
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { createAgentDepositLedgerEntry } from '../controllers/agentDepositController';
import { listCompletionCommissions, markCompletionPaid, undoCompletionPaid } from '../services/completionCommissionService';

const TAG = `cc${Date.now()}`;
let failures = 0;
async function check(name: string, fn: () => Promise<unknown> | unknown) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`  ✘ ${name}\n      ${err?.message || err}`);
  }
}

async function main() {
  const role = await prisma.role.upsert({ where: { name: 'AGENT' }, create: { name: 'AGENT' }, update: {} });
  const agent = await prisma.adminUser.create({ data: { email: `${TAG}@t.local`, password: 'x', firstName: 'Comm', lastName: TAG, phone: '0240000000', roleId: role.id } });
  let n = 0;
  const sale = async () => {
    n++;
    const uuid = crypto.randomUUID();
    await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}${n}`, firstName: 'C', lastName: `${n}`, phone: `${TAG}${n}`, createdById: agent.id } });
    const c = await prisma.hirePurchaseContract.create({
      data: {
        contractNumber: `${TAG}-${n}`, customerId_uuid: uuid, totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
        paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000),
        status: 'ACTIVE', outstandingBalance: 1600, createdById: agent.id, approvedAt: new Date(),
      },
    });
    await createAgentDepositLedgerEntry(c.id);
    return c;
  };
  const settingsRow = await prisma.commissionSettings.findFirst();
  const setRates = (fixedAmount: number, deferredAmount: number, completionBonus: number) =>
    settingsRow
      ? prisma.commissionSettings.update({ where: { id: settingsRow.id }, data: { fixedAmount, deferredAmount, completionBonus, effectiveDate: new Date(Date.now() - 1000) } })
      : prisma.commissionSettings.create({ data: { fixedAmount, deferredAmount, completionBonus, effectiveDate: new Date(Date.now() - 1000) } });
  const mine = async () => (await listCompletionCommissions({ agentId: agent.id })).rows;
  const rowFor = async (contractId: string) => (await mine()).find((r) => r.contractId === contractId);

  console.log('Old scheme (100 kept at sale, nothing at completion)');
  await setRates(100, 0, 0);
  const old = await sale();
  await check('ledger: agent remits deposit − 100 = 300', async () => {
    const l = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId: old.id } });
    assert.deepStrictEqual([l.commissionAmount, l.amountDueCompany, l.outstandingBalance], [100, 300, 300]);
  });
  await check('no completion commission is recorded', async () => assert.strictEqual(await rowFor(old.id), undefined));

  console.log('New scheme (70 at sale, 30 held + 40 bonus at completion)');
  await setRates(70, 30, 40);
  const a = await sale();
  await check('ledger: agent remits deposit − 70 = 330', async () => {
    const l = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId: a.id } });
    assert.deepStrictEqual([l.commissionAmount, l.amountDueCompany], [70, 330]);
  });
  await check('completion commission of 70 recorded (30 held + 40 bonus), pending', async () => {
    const r = await rowFor(a.id);
    assert.ok(r);
    assert.deepStrictEqual([r!.upfrontAmount, r!.deferredAmount, r!.bonusAmount, r!.total, r!.status], [70, 30, 40, 70, 'PENDING']);
  });
  await check('the sale before the change still has none', async () => assert.strictEqual(await rowFor(old.id), undefined));
  await check('a second ledger call does not double it', async () => {
    await createAgentDepositLedgerEntry(a.id);
    assert.strictEqual((await mine()).filter((r) => r.contractId === a.id).length, 1);
  });
  await check('rates changed later do not alter what was promised', async () => {
    await setRates(70, 50, 50);
    assert.strictEqual((await rowFor(a.id))!.total, 70);
    await setRates(70, 30, 40);
  });
  await check('cannot be paid before the customer completes', () =>
    assert.rejects(async () => markCompletionPaid((await rowFor(a.id))!.id, agent.id, 'REF'), /not payable/));

  await prisma.hirePurchaseContract.update({ where: { id: a.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  await check('completed → payable', async () => assert.strictEqual((await rowFor(a.id))!.status, 'PAYABLE'));
  await check('paying needs a reference', () => assert.rejects(async () => markCompletionPaid((await rowFor(a.id))!.id, agent.id, '  '), /reference/));
  await check('mark paid', async () => {
    await markCompletionPaid((await rowFor(a.id))!.id, agent.id, 'MOMO-77');
    const r = await rowFor(a.id);
    assert.deepStrictEqual([r!.status, r!.reference], ['PAID', 'MOMO-77']);
  });
  await check('cannot be paid twice', () => assert.rejects(async () => markCompletionPaid((await rowFor(a.id))!.id, agent.id, 'X'), /Already/));
  await check('a completion reversed after payment is flagged for review', async () => {
    await prisma.hirePurchaseContract.update({ where: { id: a.id }, data: { status: 'ACTIVE' } });
    assert.strictEqual((await rowFor(a.id))!.needsReview, true);
    await prisma.hirePurchaseContract.update({ where: { id: a.id }, data: { status: 'COMPLETED' } });
  });
  await check('undo paid → payable again', async () => {
    await undoCompletionPaid((await rowFor(a.id))!.id);
    assert.strictEqual((await rowFor(a.id))!.status, 'PAYABLE');
  });

  const w = await sale();
  await prisma.hirePurchaseContract.update({ where: { id: w.id }, data: { status: 'WRITTEN_OFF', writtenOffAt: new Date() } });
  await check('written off → forfeited, and cannot be paid', async () => {
    assert.strictEqual((await rowFor(w.id))!.status, 'FORFEITED');
    await assert.rejects(async () => markCompletionPaid((await rowFor(w.id))!.id, agent.id, 'X'), /not payable/);
  });
  const cx = await sale();
  await prisma.hirePurchaseContract.update({ where: { id: cx.id }, data: { status: 'CANCELLED' } });
  await check('cancelled → forfeited', async () => assert.strictEqual((await rowFor(cx.id))!.status, 'FORFEITED'));
  const df = await sale();
  await prisma.hirePurchaseContract.update({ where: { id: df.id }, data: { status: 'DEFAULTED' } });
  await check('defaulted → on hold', async () => assert.strictEqual((await rowFor(df.id))!.status, 'ON_HOLD'));
  await prisma.hirePurchaseContract.update({ where: { id: df.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  await check('defaulted, then completed → payable', async () => assert.strictEqual((await rowFor(df.id))!.status, 'PAYABLE'));

  await check('totals and filters', async () => {
    const all = await listCompletionCommissions({ agentId: agent.id });
    assert.deepStrictEqual([all.totals.PAYABLE.count, all.totals.PAYABLE.amount, all.totals.FORFEITED.count], [2, 140, 2]);
    const payable = await listCompletionCommissions({ agentId: agent.id, status: 'PAYABLE' });
    assert.strictEqual(payable.rows.length, 2);
    const d = new Date();
    const thisMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    assert.strictEqual((await listCompletionCommissions({ agentId: agent.id, completedMonth: thisMonth })).rows.length, 2);
    assert.strictEqual((await listCompletionCommissions({ agentId: agent.id, completedMonth: '2020-01' })).rows.length, 0);
  });

  await setRates(100, 0, 0); // leave the test DB as it was found
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll completion commission checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
