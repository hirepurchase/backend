/**
 * PayTrigger messages test — LOCAL TEST DATABASE and a MOCK PayTrigger only.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/payTriggerMessagesTest.ts
 *
 * Runs the sidecar in live mode against a fake PayTrigger API on 127.0.0.1 and
 * checks the personalised lock-screen text, the reminders of an upcoming
 * payment and the one-off message an admin can send.
 */
import * as http from 'http';
import * as crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

const MOCK_PORT = 55991;
process.env.PAYTRIGGER_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.PAYTRIGGER_API_KEY = 'mock-key';
process.env.PAYTRIGGER_DRY_RUN = 'false';
process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = 'true';
process.env.PAYTRIGGER_CANARY_CONTRACTS = '';

interface Call { path: string; body: any }
const calls: Call[] = [];
let pushReply: { code: number; message: string } = { code: 200, message: 'Success' };

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    calls.push({ path: req.url || '', body: json });
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/push/v1/sendPushInfo')) return res.end(JSON.stringify(pushReply));
    res.end(JSON.stringify({ code: 200, message: 'Success', data: [] }));
  });
});

import assert from 'assert';
import prisma from '../config/database';

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
const day = (offset: number) => new Date(Date.now() + offset * 86400_000);
const TAG = `ptmsg-${Date.now()}`;
let seq = 0;

async function makeContract(opts: { dueOffset: number; ledger?: number; open?: boolean; status?: string }) {
  seq++;
  const role = await prisma.role.upsert({ where: { name: 'SALES_AGENT' }, create: { name: 'SALES_AGENT' }, update: {} });
  const agent = await prisma.adminUser.upsert({
    where: { email: `${TAG}-agent@test.local` },
    create: { email: `${TAG}-agent@test.local`, password: 'x', firstName: 'Kojo', lastName: 'Agent', phone: '0240000000', roleId: role.id },
    update: {},
  });
  const category = await prisma.productCategory.upsert({ where: { name: `${TAG}-phones` }, create: { name: `${TAG}-phones` }, update: {} });
  const product = await prisma.product.create({ data: { name: `TECNO SPARK ${TAG}-${seq}`, basePrice: 2000, categoryId: category.id } });
  const uuid = crypto.randomUUID();
  await prisma.customer.create({
    data: { id_uuid: uuid, membershipId: `${TAG}-m${seq}`, firstName: 'Ama', lastName: `Mensah${seq}`, phone: `${TAG}-${seq}`, createdById: agent.id },
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
      endDate: day(40),
      status: opts.status || 'ACTIVE',
      outstandingBalance: 1600,
      totalPaid: 400,
      createdById: agent.id,
      approvedAt: day(-1),
      installments: { create: [0, 1, 2, 3].map((n) => ({ installmentNo: n + 1, dueDate: day(opts.dueOffset + n * 7), amount: 400 })) },
    },
  });
  await prisma.agentDepositLedger.create({
    data: {
      contractId: contract.id, agentId: agent.id, contractNumber: contract.contractNumber, customerName: 'Ama',
      depositAmount: 400, commissionAmount: 0, amountDueCompany: opts.ledger ?? 0, outstandingBalance: opts.ledger ?? 0,
    },
  });
  const item = await prisma.inventoryItem.create({
    data: { productId: product.id, serialNumber: `35${String(Date.now()).slice(-10)}${String(seq).padStart(3, '0')}`, status: 'SOLD', contractId: contract.id },
  });
  await prisma.payTriggerProduct.create({ data: { productId: product.id, brand: 'TECNO' } });
  const device = await prisma.payTriggerDevice.create({
    data: {
      inventoryItemId: item.id,
      imei: item.serialNumber,
      contractId: contract.id,
      enrollmentStatus: 'ACTIVE',
      providerExpiresAt: opts.open === false ? day(-1) : day(5),
    },
  });
  return { contract, device };
}

async function main() {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));
  const messages = await import('../services/payTrigger/messages');
  const { reconcileContract } = await import('../services/payTrigger/reconcile');
  const { invalidatePayTriggerSettings, getPayTriggerSettings } = await import('../services/payTrigger/settings');
  const { runMorningSweep } = await import('../services/payTrigger/sweep');
  const { spoolCallback, processCallback } = await import('../services/payTrigger/callbacks');

  await getPayTriggerSettings();
  const saved = await prisma.payTriggerSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
  const setSettings = async (data: Record<string, unknown>) => {
    await prisma.payTriggerSettings.update({ where: { id: 'singleton' }, data });
    invalidatePayTriggerSettings();
  };
  // Phones from earlier runs must not answer this run's reminders.
  await prisma.payTriggerDevice.updateMany({ where: { imei: { not: '' } }, data: { enrollmentStatus: 'REMOVED' } });
  const ruleCalls = (imei: string) => calls.filter((c) => c.path.endsWith('/setLockRule') && c.body.imei === imei);
  const pushCalls = (imei: string) => calls.filter((c) => c.path.endsWith('/sendPushInfo') && c.body.imei === imei);
  const reconcile = (id: string) => reconcileContract(id, { reasons: ['ADMIN_RECONCILE'] });
  const fresh = (id: string) => prisma.payTriggerDevice.findUniqueOrThrow({ where: { id } });

  console.log('Templates');
  await check('placeholders are filled; unknown ones are reported', () => {
    assert.deepStrictEqual(messages.unknownPlaceholders('Hi {firstName}, pay {amout} by {dueDate}'), ['amout']);
    assert.deepStrictEqual(messages.parseReminderDays('3, 1,0,1,x,45'), [3, 1, 0]);
  });

  console.log('Lock-screen text');
  await setSettings({ lockTitle: null, lockTips: null, reminderEnabled: false });
  const plain = await makeContract({ dueOffset: 3 });
  await check('with no lock message written, nothing is sent to the phone', async () => {
    await reconcile(plain.contract.id);
    assert.strictEqual(ruleCalls(plain.device.imei).length, 0);
  });

  await setSettings({ lockTitle: 'Payment overdue', lockTips: 'Dear {firstName}, your phone is locked. Pay {amount} due {dueDate}. Contract {contractNumber}.' });
  const a = await makeContract({ dueOffset: 3 });
  await check('the lock message is sent with this customer\'s name, amount and date', async () => {
    await reconcile(a.contract.id);
    const sent = ruleCalls(a.device.imei);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].body.deviceTitle, 'Payment overdue');
    assert.match(sent[0].body.deviceTips, /^Dear Ama, your phone is locked\. Pay GHS 400\.00 due \d+ \w{3} \d{4}\. Contract ptmsg-/);
    assert.ok((await fresh(a.device.id)).lockMessageKey);
  });
  await check('it is not sent again while the words are the same', async () => {
    await reconcileContract(a.contract.id, { reasons: ['ADMIN_RECONCILE'], force: true });
    assert.strictEqual(ruleCalls(a.device.imei).length, 1);
  });
  await check('a part payment updates the amount on the phone', async () => {
    await prisma.installmentSchedule.updateMany({ where: { contractId: a.contract.id, installmentNo: 1 }, data: { paidAmount: 150 } });
    await reconcile(a.contract.id);
    const sent = ruleCalls(a.device.imei);
    assert.strictEqual(sent.length, 2);
    assert.match(sent[1].body.deviceTips, /Pay GHS 250\.00/);
  });
  const late = await makeContract({ dueOffset: -9, open: false });
  await check('two instalments overdue → the message names the total owed', async () => {
    await reconcile(late.contract.id);
    assert.match(ruleCalls(late.device.imei)[0].body.deviceTips, /Pay GHS 800\.00/);
  });

  const held = await makeContract({ dueOffset: 3, ledger: 300 });
  await check('agent deposit unpaid → the "contact your agent" text, with the agent filled in', async () => {
    await reconcile(held.contract.id);
    const sent = ruleCalls(held.device.imei);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].body.deviceTips, /Kojo Agent on 0240000000/);
    assert.strictEqual((await fresh(held.device.id)).holdMessageShown, true);
  });
  await check('deposit remitted → the overdue text replaces it', async () => {
    await prisma.agentDepositLedger.update({ where: { contractId: held.contract.id }, data: { outstandingBalance: 0 } });
    await reconcile(held.contract.id);
    const sent = ruleCalls(held.device.imei);
    assert.strictEqual(sent.length, 2);
    assert.match(sent[1].body.deviceTips, /^Dear Ama, your phone is locked/);
    assert.strictEqual((await fresh(held.device.id)).holdMessageShown, false);
  });

  console.log('No active contract');
  const looseDevice = async (status: string) => {
    seq++;
    const category = await prisma.productCategory.upsert({ where: { name: `${TAG}-phones` }, create: { name: `${TAG}-phones` }, update: {} });
    const product = await prisma.product.create({ data: { name: `TECNO POP ${TAG}-${seq}`, basePrice: 900, categoryId: category.id } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: `35${String(Date.now()).slice(-10)}${String(seq).padStart(3, '0')}`, status: 'AVAILABLE' } });
    return prisma.payTriggerDevice.create({ data: { inventoryItemId: item.id, imei: item.serialNumber, enrollmentStatus: status } });
  };
  const unsold = await looseDevice('QUEUED');
  await check('unsold phone switched on → on activation its lock screen gets the "no active contract" text', async () => {
    const id = await spoolCallback({ notifyType: 1000, imei: unsold.imei, deviceTag: 'TAGX', state: 3000, mobileStatus: 1000, activeTime: Math.floor(Date.now() / 1000) });
    await processCallback(id);
    const sent = ruleCalls(unsold.imei);
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0].body.deviceTips, /does not have a contract/);
    const d = await fresh(unsold.id);
    assert.deepStrictEqual([d.enrollmentStatus, d.providerExpiresAt, d.committedState], ['ACTIVE', null, 'LOCKED']);
    assert.strictEqual(calls.filter((c) => c.path.endsWith('/updateRepayInfo') && c.body.imei === unsold.imei).length, 0, 'never opened');
  });
  await check('the sweep covers a phone whose activation callback was missed, and does not repeat', async () => {
    const missed = await looseDevice('ACTIVE');
    const first = await runMorningSweep();
    assert.ok((first.unlinkedMessages || 0) >= 1);
    assert.strictEqual(ruleCalls(missed.imei).length, 1);
    await runMorningSweep();
    assert.strictEqual(ruleCalls(missed.imei).length, 1);
    assert.strictEqual(ruleCalls(unsold.imei).length, 1);
  });
  await check('a phone that activated before this text existed gets it when an admin presses Verify', async () => {
    const old = await looseDevice('ACTIVE');
    const admin = await import('../services/payTrigger/admin');
    const v = await admin.verifyDevice(old.id, 'tester');
    // The mock answers getDevice with an empty body, which reads as "waiting"; send directly as Verify does for an active phone.
    const { sendUnlinkedMessage } = await import('../services/payTrigger/reconcile');
    const r = v.status === 'ACTIVE' ? { sent: ruleCalls(old.imei).length === 1 } : await sendUnlinkedMessage(old.id);
    assert.ok(r.sent, JSON.stringify(r));
    assert.strictEqual(ruleCalls(old.imei)[0].body.deviceTips, 'Your device does not have a contract. Please contact AIDOO TECH on 0303981216.');
    assert.strictEqual(ruleCalls(old.imei)[0].body.deviceTitle, 'No contract on this device');
    assert.deepStrictEqual(await sendUnlinkedMessage(old.id), { sent: false, upToDate: true });
  });
  await check('changing the wording in Settings re-sends it to phones with no contract', async () => {
    const admin = await import('../services/payTrigger/admin');
    await setSettings({ unlinkedTips: 'Your device does not have a contract. Call AIDOO TECH.' });
    const n = await admin.resendUnlinkedMessages();
    assert.ok(n >= 1, `${n} re-sent`);
    await setSettings({ unlinkedTips: 'Your device does not have a contract. Please contact AIDOO TECH on 0303981216.' });
    await admin.resendUnlinkedMessages();
  });
  await check('sold but not approved yet → stays locked with the same text', async () => {
    const pending = await makeContract({ dueOffset: 3, status: 'PENDING', open: false });
    await reconcile(pending.contract.id);
    assert.match(ruleCalls(pending.device.imei)[0].body.deviceTips, /does not have a contract/);
    assert.strictEqual(calls.filter((c) => c.path.endsWith('/updateRepayInfo') && c.body.imei === pending.device.imei).length, 0);
  });
  await check('once the phone is sold on an active contract, the customer\'s own text replaces it', async () => {
    const sale = await makeContract({ dueOffset: 3, open: false });
    await prisma.payTriggerDevice.delete({ where: { id: sale.device.id } });
    await prisma.inventoryItem.updateMany({ where: { contractId: sale.contract.id }, data: { contractId: null } });
    await prisma.inventoryItem.update({ where: { id: unsold.inventoryItemId }, data: { contractId: sale.contract.id, status: 'SOLD' } });
    await reconcile(sale.contract.id);
    const sent = ruleCalls(unsold.imei);
    assert.match(sent[sent.length - 1].body.deviceTips, /^Dear Ama, your phone is locked/);
    assert.strictEqual(calls.filter((c) => c.path.endsWith('/updateRepayInfo') && c.body.imei === unsold.imei).length, 1, 'opened');
  });

  console.log('Reminders');
  const due3 = await makeContract({ dueOffset: 3 });
  const due5 = await makeContract({ dueOffset: 5 });
  const locked = await makeContract({ dueOffset: 3, open: false });
  const heldPhone = await makeContract({ dueOffset: 3, ledger: 300 });
  await prisma.payTriggerDevice.update({ where: { id: heldPhone.device.id }, data: { holdMessageShown: true } });
  await check('switched off → no reminder goes out', async () => {
    const r = await messages.sendPaymentReminders();
    assert.deepStrictEqual([r.due, r.sent], [0, 0]);
    assert.strictEqual(pushCalls(due3.device.imei).length, 0);
  });
  await setSettings({
    reminderEnabled: true, reminderDaysBefore: '3,1,0', reminderChannel: 'POPUP',
    reminderTitle: 'Payment in {daysLeft}', reminderText: 'Dear {firstName}, {amount} is due on {dueDate}. Balance {balance}.',
  });
  await check('3 days before the due date → one pop-up with the customer\'s figures', async () => {
    const r = await messages.sendPaymentReminders();
    const sent = pushCalls(due3.device.imei);
    assert.strictEqual(sent.length, 1, JSON.stringify(r));
    assert.strictEqual(sent[0].body.pushType, 1);
    assert.strictEqual(sent[0].body.title, 'Payment in 3 days');
    assert.match(sent[0].body.content, /^Dear Ama, GHS 400\.00 is due on \d+ \w{3} \d{4}\. Balance GHS 1600\.00\.$/);
  });
  await check('5 days before, a locked phone and a deposit-held phone get none', async () => {
    assert.strictEqual(pushCalls(due5.device.imei).length, 0);
    assert.strictEqual(pushCalls(locked.device.imei).length, 0);
    assert.strictEqual(pushCalls(heldPhone.device.imei).length, 0);
  });
  await check('running again the same day does not repeat it', async () => {
    const r = await messages.sendPaymentReminders();
    assert.strictEqual(pushCalls(due3.device.imei).length, 1);
    assert.strictEqual(r.sent, 0);
  });
  await check('the due day counts as "today"; "both" sends a pop-up and a notification', async () => {
    await setSettings({ reminderChannel: 'BOTH' });
    const today = await makeContract({ dueOffset: 0 });
    // Due later today, so the phone is still open.
    await prisma.installmentSchedule.updateMany({ where: { contractId: today.contract.id, installmentNo: 1 }, data: { dueDate: new Date(new Date().setHours(23, 59, 0, 0)) } });
    await messages.sendPaymentReminders();
    const sent = pushCalls(today.device.imei);
    assert.deepStrictEqual(sent.map((c) => c.body.pushType).sort(), [1, 2]);
    assert.strictEqual(sent[0].body.title, 'Payment in today');
    await setSettings({ reminderChannel: 'POPUP', reminderTitle: 'Payment reminder' });
  });
  await check('a refused reminder is recorded but never marks the phone as faulty', async () => {
    const r1 = await makeContract({ dueOffset: 1 });
    pushReply = { code: 50008, message: 'The number of calls to a single device exceeds the limit.' };
    const r = await messages.sendPaymentReminders();
    pushReply = { code: 200, message: 'Success' };
    assert.ok(r.failed >= 1, JSON.stringify(r));
    assert.strictEqual((await fresh(r1.device.id)).lastError, null);
    const log = await prisma.payTriggerActionLog.findFirst({ where: { deviceId: r1.device.id, action: 'REMIND_POPUP' } });
    assert.strictEqual(log?.success, false);
  });
  await check('the morning sweep sends reminders and reports them', async () => {
    const viaSweep = await makeContract({ dueOffset: 1 });
    const summary = await runMorningSweep();
    assert.ok(summary.reminders && summary.reminders.sent >= 1, JSON.stringify(summary.reminders));
    assert.strictEqual(pushCalls(viaSweep.device.imei).length, 1);
  });

  console.log('Message from an admin');
  const m = await makeContract({ dueOffset: 10 });
  await check('a notification is sent with placeholders filled', async () => {
    const r = await messages.sendDeviceMessage(m.device.id, { channel: 'PUSH', title: 'Hello {firstName}', text: 'Your balance is {balance}.' }, 'tester');
    const sent = pushCalls(m.device.imei);
    assert.deepStrictEqual([sent[0].body.pushType, sent[0].body.title, sent[0].body.content], [2, 'Hello Ama', 'Your balance is GHS 1600.00.']);
    assert.strictEqual(r.dryRun, false);
  });
  await check('the fourth pop-up in 24 hours is refused before it reaches PayTrigger', async () => {
    for (let i = 0; i < 3; i++) await messages.sendDeviceMessage(m.device.id, { channel: 'POPUP', title: 'T', text: `Message ${i}` }, 'tester');
    assert.deepStrictEqual(await messages.sentInLastDay(m.device.id), { POPUP: 3, PUSH: 1 });
    const before = pushCalls(m.device.imei).length;
    await assert.rejects(() => messages.sendDeviceMessage(m.device.id, { channel: 'POPUP', title: 'T', text: 'One more' }, 'tester'), /already had 3 pop-ups/);
    assert.strictEqual(pushCalls(m.device.imei).length, before);
  });
  await check('a phone that has not activated cannot be messaged', async () => {
    await prisma.payTriggerDevice.update({ where: { id: m.device.id }, data: { enrollmentStatus: 'QUEUED' } });
    await assert.rejects(() => messages.sendDeviceMessage(m.device.id, { channel: 'PUSH', title: 'T', text: 'x' }, 'tester'), /not activated/);
  });

  await setSettings({
    lockTitle: saved.lockTitle, lockTips: saved.lockTips, reminderEnabled: saved.reminderEnabled, reminderDaysBefore: saved.reminderDaysBefore,
    reminderChannel: saved.reminderChannel, reminderTitle: saved.reminderTitle, reminderText: saved.reminderText,
  });
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll message checks passed');
  mock.close();
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  mock.close();
  await prisma.$disconnect();
  process.exit(1);
});
