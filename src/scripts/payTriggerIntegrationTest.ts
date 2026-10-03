/**
 * PayTrigger sidecar integration test — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/payTriggerIntegrationTest.ts
 *
 * Builds synthetic contracts, runs the event inbox, reconcile, callbacks and
 * the morning sweep in dry run, and checks Phase 4's "done when" list.
 * Refuses to run against anything but localhost.
 */
process.env.PAYTRIGGER_DRY_RUN = 'true';
process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = 'false';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

import assert from 'assert';
import prisma from '../config/database';
import { notifyPayTrigger, eventStats } from '../services/payTrigger/events';
import { refreshTranssionContracts } from '../services/payTrigger/registry';
import { runMorningSweep } from '../services/payTrigger/sweep';
import { spoolCallback, processCallback } from '../services/payTrigger/callbacks';
import { isPayTriggerProduct, invalidatePayTriggerProducts } from '../services/payTrigger/guard';
import { invalidatePayTriggerSettings } from '../services/payTrigger/settings';
import { issuePin, getIssues } from '../services/payTrigger/admin';

const TAG = `pttest-${Date.now()}`;
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
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const day = (offset: number) => new Date(Date.now() + offset * 86400_000);

let queryCount = 0;
(prisma as any).$use(async (params: any, next: any) => {
  queryCount++;
  return next(params);
});

let seq = 0;
async function makeContract(opts: { transsion: boolean; ledger?: number | null; approved?: boolean; activated?: boolean; dueOffset?: number }) {
  seq++;
  const role = await prisma.role.upsert({ where: { name: 'SALES_AGENT' }, create: { name: 'SALES_AGENT' }, update: {} });
  const agent = await prisma.adminUser.upsert({
    where: { email: `${TAG}-agent@test.local` },
    create: { email: `${TAG}-agent@test.local`, password: 'x', firstName: 'Ama', lastName: 'Agent', phone: '0240000000', roleId: role.id },
    update: {},
  });
  const category = await prisma.productCategory.upsert({ where: { name: `${TAG}-phones` }, create: { name: `${TAG}-phones` }, update: {} });
  const product = await prisma.product.create({
    data: { name: opts.transsion ? `TECNO SPARK ${seq}` : `SAMSUNG A${seq}`, basePrice: 2000, categoryId: category.id },
  });
  const uuid = crypto.randomUUID();
  const customer = await prisma.customer.create({
    data: { id_uuid: uuid, membershipId: `${TAG}-m${seq}`, firstName: 'Kofi', lastName: `Test${seq}`, phone: `${TAG}-${seq}`, createdById: agent.id },
  });
  const contract = await prisma.hirePurchaseContract.create({
    data: {
      contractNumber: `${TAG}-C${seq}`,
      customerId_uuid: uuid,
      totalPrice: 2000,
      depositAmount: 400,
      financeAmount: 1600,
      installmentAmount: 400,
      paymentFrequency: 'WEEKLY',
      totalInstallments: 4,
      startDate: day(-10),
      endDate: day(20),
      status: 'ACTIVE',
      outstandingBalance: 1600,
      totalPaid: 400,
      createdById: agent.id,
      approvedAt: opts.approved === false ? null : day(-1),
      installments: {
        create: [0, 1, 2, 3].map((n) => ({
          installmentNo: n + 1,
          dueDate: day((opts.dueOffset ?? 3) + n * 7),
          amount: 400,
        })),
      },
    },
  });
  if (opts.ledger !== undefined && opts.ledger !== null) {
    await prisma.agentDepositLedger.create({
      data: {
        contractId: contract.id, agentId: agent.id, contractNumber: contract.contractNumber, customerName: 'Kofi',
        depositAmount: 400, commissionAmount: 0, amountDueCompany: opts.ledger, outstandingBalance: opts.ledger,
      },
    });
  }
  const item = await prisma.inventoryItem.create({
    data: { productId: product.id, serialNumber: `35${String(Date.now()).slice(-10)}${String(seq).padStart(3, '0')}`, status: 'SOLD', contractId: contract.id },
  });
  let device: Awaited<ReturnType<typeof prisma.payTriggerDevice.create>> | null = null;
  if (opts.transsion) {
    await prisma.payTriggerProduct.create({ data: { productId: product.id, brand: 'TECNO' } });
    device = await prisma.payTriggerDevice.create({
      data: {
        inventoryItemId: item.id,
        imei: item.serialNumber,
        contractId: contract.id,
        enrollmentStatus: opts.activated === false ? 'QUEUED' : 'ACTIVE',
      },
    });
  }
  return { contract, item, product, device, agent };
}

async function main() {
  console.log(`Fixture tag ${TAG}`);
  const samsung = await makeContract({ transsion: false });
  const t1 = await makeContract({ transsion: true, ledger: 0 });
  await refreshTranssionContracts();
  invalidatePayTriggerProducts();
  invalidatePayTriggerSettings();

  console.log('Guard');
  await check('Transsion product is recognised; Samsung is not', async () => {
    assert.strictEqual(await isPayTriggerProduct(t1.product.id), true);
    assert.strictEqual(await isPayTriggerProduct(samsung.product.id), false);
    assert.strictEqual(await isPayTriggerProduct(null), false);
  });

  console.log('Events');
  await check('(a) Samsung payment: zero sidecar DB queries, zero reconciles', async () => {
    const before = queryCount;
    const reconciles = eventStats.reconciles;
    notifyPayTrigger(samsung.contract.id, 'PAYMENT');
    notifyPayTrigger(samsung.contract.id, 'TEMP_UNLOCK_APPROVED');
    notifyPayTrigger(undefined, 'PAYMENT');
    await settle();
    assert.strictEqual(queryCount - before, 0, `${queryCount - before} queries`);
    assert.strictEqual(eventStats.reconciles - reconciles, 0);
  });

  await check('(b) Transsion payment: exactly one reconcile, phone told its next lock date', async () => {
    const reconciles = eventStats.reconciles;
    notifyPayTrigger(t1.contract.id, 'PAYMENT');
    await settle(1500);
    assert.strictEqual(eventStats.reconciles - reconciles, 1);
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: t1.device!.id } });
    assert.ok(d.providerExpiresAt && d.providerExpiresAt > new Date(), 'lock date pushed');
    const cmd = await prisma.payTriggerCommand.findFirst({ where: { deviceId: d.id, type: 'EXTEND', status: 'SUCCEEDED' } });
    assert.ok(cmd, 'EXTEND command recorded');
    assert.strictEqual(d.committedState, 'PENDING', 'never recorded as UNLOCKED on a write');
  });

  await check('(c) ten payments in a burst coalesce into at most two reconciles', async () => {
    const reconciles = eventStats.reconciles;
    for (let i = 0; i < 10; i++) notifyPayTrigger(t1.contract.id, 'PAYMENT');
    await settle(1500);
    const ran = eventStats.reconciles - reconciles;
    assert.ok(ran >= 1 && ran <= 2, `${ran} reconciles`);
  });

  await check('unchanged decision is not resent', async () => {
    const before = await prisma.payTriggerCommand.count({ where: { deviceId: t1.device!.id } });
    notifyPayTrigger(t1.contract.id, 'PAYMENT');
    await settle(1200);
    assert.strictEqual(await prisma.payTriggerCommand.count({ where: { deviceId: t1.device!.id } }), before);
  });

  console.log('Agent deposit hold');
  const held = await makeContract({ transsion: true, ledger: 300 });
  await refreshTranssionContracts();
  await check('deposit unpaid → HOLD: no unlock date sent, "contact your agent" text set', async () => {
    notifyPayTrigger(held.contract.id, 'CONTRACT_ACTIVE');
    await settle(1500);
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: held.device!.id } });
    assert.strictEqual(d.providerExpiresAt, null, 'no lock date pushed');
    assert.strictEqual(d.holdMessageShown, true, 'hold message shown');
    const log = await prisma.payTriggerActionLog.findFirst({ where: { deviceId: d.id, action: 'SYNC' }, orderBy: { createdAt: 'desc' } });
    assert.ok(JSON.stringify(log?.request).includes('Ama Agent'), 'agent named on lock screen');
  });
  await check('agent remits → unlock date pushed, normal text restored', async () => {
    await prisma.agentDepositLedger.update({ where: { contractId: held.contract.id }, data: { outstandingBalance: 0, amountPaid: 300, status: 'PAID' } });
    notifyPayTrigger(held.contract.id, 'DEPOSIT_REMITTED');
    await settle(1500);
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: held.device!.id } });
    assert.ok(d.providerExpiresAt && d.providerExpiresAt > new Date(), 'unlocked');
    assert.strictEqual(d.holdMessageShown, false);
  });

  const noLedger = await makeContract({ transsion: true, ledger: null });
  await refreshTranssionContracts();
  await check('approved with no ledger row yet → held (fail closed)', async () => {
    notifyPayTrigger(noLedger.contract.id, 'CONTRACT_ACTIVE');
    await settle(1500);
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: noLedger.device!.id } });
    assert.strictEqual(d.providerExpiresAt, null);
    assert.strictEqual(d.holdMessageShown, true);
  });

  console.log('Linking and activation');
  const unlinked = await makeContract({ transsion: true, ledger: 0, activated: false });
  await prisma.payTriggerDevice.update({ where: { id: unlinked.device!.id }, data: { contractId: null } });
  await refreshTranssionContracts();
  await check('CONTRACT_ACTIVE links an unlinked device by its stock item', async () => {
    notifyPayTrigger(unlinked.contract.id, 'CONTRACT_ACTIVE');
    await settle(1500);
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: unlinked.device!.id } });
    assert.strictEqual(d.contractId, unlinked.contract.id);
    assert.strictEqual(d.providerExpiresAt, null, 'nothing sent before activation');
  });
  await check('activation callback → ACTIVE, then the date is pushed', async () => {
    const id = await spoolCallback({ notifyType: 1000, imei: unlinked.item.serialNumber, deviceTag: 'TAG12345', state: 3000, mobileStatus: 1000, activeTime: Math.floor(Date.now() / 1000) });
    await processCallback(id);
    await settle(1500);
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: unlinked.device!.id } });
    assert.strictEqual(d.enrollmentStatus, 'ACTIVE');
    assert.strictEqual(d.deviceTag, 'TAG12345');
    assert.ok(d.licenceConsumedAt);
    assert.ok(d.providerExpiresAt && d.providerExpiresAt > new Date());
  });
  await check('a repeated callback is processed once', async () => {
    const body = { notifyType: 4000, imei: unlinked.item.serialNumber, tip: 'over limit' };
    const a = await spoolCallback(body);
    await processCallback(a);
    const b = await spoolCallback(body);
    assert.strictEqual(b, '', 'second delivery recognised as already processed');
  });

  console.log('PIN');
  await check('PIN: pushes the date first, returns a code, clears the waiting flag', async () => {
    await prisma.payTriggerDevice.update({ where: { id: t1.device!.id }, data: { awaitingPinSince: new Date() } });
    const issues = await getIssues();
    assert.ok(issues.paidStillLocked.some((r) => r.deviceId === t1.device!.id), 'on the Paid — still locked queue');
    const res: any = await issuePin(t1.device!.id, { id: t1.agent.id, role: 'ADMIN' });
    assert.ok(res.pin, 'code returned');
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: t1.device!.id } });
    assert.strictEqual(d.awaitingPinSince, null);
    assert.strictEqual(d.pinUnlocksUsed, 1);
    const log = await prisma.payTriggerActionLog.findFirst({ where: { deviceId: d.id, action: 'PIN' }, orderBy: { createdAt: 'desc' } });
    assert.ok(!JSON.stringify(log).includes(res.pin), 'the code itself is never stored');
  });
  await check('PIN refused while the deposit is unpaid', async () => {
    await assert.rejects(() => issuePin(noLedger.device!.id, { id: t1.agent.id, role: 'ADMIN' }), /No PIN issued/);
  });

  console.log('Morning sweep');
  await check('(d) change missed by events is caught by the sweep', async () => {
    // Overdue with no event: the phone should be pulled shut.
    await prisma.installmentSchedule.updateMany({ where: { contractId: t1.contract.id, installmentNo: 1 }, data: { dueDate: day(-5), status: 'OVERDUE' } });
    const summary = await runMorningSweep();
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: t1.device!.id } });
    assert.ok(d.providerExpiresAt && d.providerExpiresAt.getTime() < Date.now() + 120_000, 'lock date pulled to now');
    assert.ok(summary.reconciled >= 4, `${summary.reconciled} reconciled`);
    const s = await prisma.payTriggerSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    assert.ok(s.lastSweepAt, 'last sweep recorded');
  });
  await check('completed contract → release scheduled, then released after the hold', async () => {
    await prisma.hirePurchaseContract.update({ where: { id: held.contract.id }, data: { status: 'COMPLETED' } });
    notifyPayTrigger(held.contract.id, 'PAYMENT');
    await settle(1200);
    let d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: held.device!.id } });
    assert.ok(d.releaseAfter && d.releaseAfter > new Date(), 'release scheduled in the future');
    await prisma.payTriggerDevice.update({ where: { id: d.id }, data: { releaseAfter: day(-0.01) } });
    await runMorningSweep();
    d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: d.id } });
    assert.strictEqual(d.enrollmentStatus, 'REMOVED');
  });

  await check('(e) breaker trips on a mass extension', async () => {
    await prisma.payTriggerSettings.update({ where: { id: 'singleton' }, data: { extendBreakerPercent: 1 } });
    invalidatePayTriggerSettings();
    const batch: Awaited<ReturnType<typeof makeContract>>[] = [];
    for (let i = 0; i < 8; i++) batch.push(await makeContract({ transsion: true, ledger: 0 }));
    const summary = await runMorningSweep();
    assert.ok(summary.breakerTripped, 'breaker tripped');
    const extended = await prisma.payTriggerDevice.count({ where: { id: { in: batch.map((b) => b.device!.id) }, providerExpiresAt: { not: null } } });
    assert.ok(extended <= 5, `${extended} of 8 extended`);
    await prisma.payTriggerSettings.update({ where: { id: 'singleton' }, data: { extendBreakerPercent: 20 } });
  });

  console.log('Knox guard proofs (Part D step 3)');
  process.env.KNOX_GUARD_DRY_RUN = 'true';
  process.env.KNOX_GUARD_ENABLE_LIVE_ACTIONS = 'false';
  process.env.KNOX_GUARD_BASE_URL = 'http://127.0.0.1:9';
  const { enrollManagedDeviceForContract } = await import('../services/deviceControlPolicyService');
  const knoxMeta = { metadata: { customerExperience: { disclosureAccepted: true, supportPhone: '0300000000', paymentUssd: '*170#' } } };
  await check('Knox refuses a Transsion contract and creates no Knox row', async () => {
    const t = await makeContract({ transsion: true, ledger: 0 });
    invalidatePayTriggerProducts();
    await assert.rejects(() => enrollManagedDeviceForContract(t.contract.id, knoxMeta), /managed by PayTrigger/);
    assert.strictEqual(await (prisma as any).managedDevice.count({ where: { contractId: t.contract.id } }), 0);
  });
  await check('Samsung still enrols with Knox', async () => {
    const sm = await makeContract({ transsion: false });
    invalidatePayTriggerProducts();
    await enrollManagedDeviceForContract(sm.contract.id, knoxMeta);
    assert.strictEqual(await (prisma as any).managedDevice.count({ where: { contractId: sm.contract.id } }), 1);
  });
  await check('with the PayTrigger table gone, the guard answers false and Samsung still enrols', async () => {
    const sm = await makeContract({ transsion: false });
    await prisma.$executeRawUnsafe('ALTER TABLE "PayTriggerProduct" RENAME TO "PayTriggerProduct_hidden"');
    try {
      invalidatePayTriggerProducts();
      assert.strictEqual(await isPayTriggerProduct(t1.product.id), false, 'fails open');
      await enrollManagedDeviceForContract(sm.contract.id, knoxMeta);
      assert.strictEqual(await (prisma as any).managedDevice.count({ where: { contractId: sm.contract.id } }), 1);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "PayTriggerProduct_hidden" RENAME TO "PayTriggerProduct"');
      invalidatePayTriggerProducts();
    }
  });

  console.log('Kill switch (Part D step 4)');
  await check('a reconcile that always throws never reaches the caller', async () => {
    const mod = require('../services/payTrigger/reconcile');
    const original = mod.reconcileContract;
    mod.reconcileContract = async () => { throw new Error('boom'); };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      assert.doesNotThrow(() => notifyPayTrigger(t1.contract.id, 'PAYMENT'));
      await settle(800);
    } finally {
      mod.reconcileContract = original;
      console.error = quiet;
    }
  });
  await check('a registry that throws never reaches the caller', async () => {
    const reg = require('../services/payTrigger/registry');
    const original = reg.isTranssionContract;
    reg.isTranssionContract = () => { throw new Error('boom'); };
    try {
      assert.doesNotThrow(() => notifyPayTrigger(samsung.contract.id, 'PAYMENT'));
      assert.strictEqual(notifyPayTrigger(t1.contract.id, 'PAYMENT'), undefined);
    } finally {
      reg.isTranssionContract = original;
    }
  });
  await check('with every PayTrigger table gone, announcements are silent and Knox enrols', async () => {
    const tables = ['PayTriggerProduct', 'PayTriggerDevice', 'PayTriggerCommand', 'PayTriggerActionLog', 'PayTriggerWebhookEvent', 'PayTriggerSettings'];
    const sm = await makeContract({ transsion: false });
    for (const t of tables) await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" RENAME TO "${t}_hidden"`);
    const quiet = console.error;
    console.error = () => undefined;
    try {
      invalidatePayTriggerProducts();
      invalidatePayTriggerSettings();
      assert.doesNotThrow(() => {
        notifyPayTrigger(sm.contract.id, 'PAYMENT');
        notifyPayTrigger(t1.contract.id, 'PAYMENT');
        notifyPayTrigger(sm.contract.id, 'CONTRACT_ACTIVE');
      });
      await settle(1000);
      await enrollManagedDeviceForContract(sm.contract.id, knoxMeta);
      assert.strictEqual(await (prisma as any).managedDevice.count({ where: { contractId: sm.contract.id } }), 1);
    } finally {
      console.error = quiet;
      for (const t of tables) await prisma.$executeRawUnsafe(`ALTER TABLE "${t}_hidden" RENAME TO "${t}"`);
      invalidatePayTriggerProducts();
      invalidatePayTriggerSettings();
    }
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll integration checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

import * as crypto from 'crypto';
main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
