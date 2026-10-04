/**
 * Knox offline unlock PIN test — LOCAL TEST DATABASE ONLY, Knox forced to dry run.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/knoxPinTest.ts
 */
process.env.KNOX_GUARD_DRY_RUN = 'true';
process.env.KNOX_GUARD_ENABLE_LIVE_ACTIONS = 'false';
process.env.KNOX_GUARD_BASE_URL = 'http://127.0.0.1:9';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { parseKnoxPinResponse, getKnoxGuardUnlockPin } from '../services/knoxGuardService';
import { enrollManagedDeviceForContract } from '../services/deviceControlPolicyService';
import { issueKnoxPin } from '../controllers/knoxPinController';

const TAG = `kp${Date.now()}`;
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

/** Call the controller as Express would and capture the reply. */
async function call(role: string, contractId: string, body: Record<string, unknown> = {}) {
  let status = 200;
  let json: any = null;
  const res: any = { status(s: number) { status = s; return res; }, json(j: unknown) { json = j; return res; } };
  const req: any = { params: { contractId }, body, user: { id: adminId, role, email: 'x', permissions: [] }, ip: '127.0.0.1', headers: {} };
  await issueKnoxPin(req, res);
  return { status, json };
}
let adminId = '';

async function main() {
  console.log('Response parsing (formats from the Knox Guard v1.1 spec)');
  await check('offlineDeviceLockPin → pinNumber list', () =>
    assert.deepStrictEqual(parseKnoxPinResponse({ result: 'SUCCESS', pinNumber: ['12345678', '87654321'] }).pins, ['12345678', '87654321']));
  await check('getPin → lockPin', () => assert.deepStrictEqual(parseKnoxPinResponse({ result: 'SUCCESS', lockPin: '24681357' }).pins, ['24681357']));
  await check('a numeric lockPin is kept as text', () => assert.deepStrictEqual(parseKnoxPinResponse({ lockPin: 1234567 }).pins, ['1234567']));
  await check('FAIL means no PIN, even if a code is present', () => assert.deepStrictEqual(parseKnoxPinResponse({ result: 'FAIL', lockPin: '1' }).pins, []));
  await check('an empty body means no PIN', () => assert.deepStrictEqual(parseKnoxPinResponse(undefined).pins, []));

  console.log('Client');
  await check('with a passkey it uses offlineDeviceLockPin and sends it as challenge', async () => {
    const r = await getKnoxGuardUnlockPin({ deviceUid: '350000000000001', passkey: '47685852' });
    assert.ok(r.dryRun && r.pins?.length);
    assert.strictEqual((r.data as any).path, '/devices/offlineDeviceLockPin');
  });
  await check('without a passkey it uses getPin', async () => {
    const r = await getKnoxGuardUnlockPin({ deviceUid: '350000000000001' });
    assert.strictEqual((r.data as any).path, '/devices/getPin');
  });

  console.log('Endpoint');
  const role = await prisma.role.upsert({ where: { name: 'SUPER_ADMIN' }, create: { name: 'SUPER_ADMIN' }, update: {} });
  const admin = await prisma.adminUser.create({ data: { email: `${TAG}@t.local`, password: 'x', firstName: 'Pin', lastName: TAG, phone: '0240000000', roleId: role.id } });
  adminId = admin.id;
  const cat = await prisma.productCategory.create({ data: { name: `${TAG}-cat` } });
  const product = await prisma.product.create({ data: { name: 'SAMSUNG A15', basePrice: 2000, categoryId: cat.id } });
  let n = 0;
  const contract = async (firstDueOffsetDays: number) => {
    n++;
    const uuid = crypto.randomUUID();
    await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}${n}`, firstName: 'K', lastName: `${n}`, phone: `${TAG}${n}`, createdById: admin.id } });
    const due = new Date(Date.now() + firstDueOffsetDays * 86400000);
    const c = await prisma.hirePurchaseContract.create({
      data: {
        contractNumber: `${TAG}-${n}`, customerId_uuid: uuid, totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
        paymentFrequency: 'WEEKLY', totalInstallments: 1, startDate: new Date(), endDate: new Date(Date.now() + 30 * 86400000),
        status: 'ACTIVE', outstandingBalance: 1600, createdById: admin.id,
        installments: { create: [{ installmentNo: 1, dueDate: due, amount: 400, status: firstDueOffsetDays < 0 ? 'OVERDUE' : 'PENDING' }] },
      },
    });
    await prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: `35${String(Date.now()).slice(-11)}${n}`, status: 'SOLD', contractId: c.id } });
    await enrollManagedDeviceForContract(c.id, { metadata: { customerExperience: { disclosureAccepted: true, supportPhone: '0300000000', paymentUssd: '*170#' } } });
    return c;
  };

  const current = await contract(5);
  const overdue = await contract(-5);
  const bare = await prisma.hirePurchaseContract.findFirst({ where: { managedDevice: null }, select: { id: true } });

  await check('an agent (or any non-admin role) is refused', async () => {
    const r = await call('SALES_AGENT', current.id);
    assert.strictEqual(r.status, 403);
  });
  await check('Admin role is allowed', async () => assert.strictEqual((await call('ADMIN', current.id)).status, 200));
  await check('a contract with no Knox device → 404', async () => {
    if (!bare) return;
    assert.strictEqual((await call('SUPER_ADMIN', bare.id)).status, 404);
  });
  await check('a malformed passkey is refused', async () => assert.strictEqual((await call('SUPER_ADMIN', current.id, { passkey: '12-34!' })).status, 400));
  await check('overdue → refused, Knox still requires the lock', async () => {
    const r = await call('SUPER_ADMIN', overdue.id);
    assert.strictEqual(r.status, 400, JSON.stringify(r.json));
    assert.match(r.json.error, /still requires/);
  });
  await check('paid up → PIN returned (dry run) with the 24-hour notice', async () => {
    const r = await call('SUPER_ADMIN', current.id, { passkey: '47685852' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual([r.json.pins, r.json.dryRun, r.json.withPasskey], [['00000000'], true, true]);
    assert.match(r.json.notice, /24 hours/);
  });
  await check('customer pays the overdue instalment → PIN allowed', async () => {
    await prisma.installmentSchedule.updateMany({ where: { contractId: overdue.id }, data: { paidAmount: 400, status: 'PAID', paidAt: new Date() } });
    await prisma.hirePurchaseContract.update({ where: { id: overdue.id }, data: { totalPaid: 400, outstandingBalance: 1200 } });
    const r = await call('SUPER_ADMIN', overdue.id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  });
  await check('every PIN request is audited, and the code itself is never stored', async () => {
    const logs = await prisma.auditLog.findMany({ where: { action: 'KNOX_PIN_ISSUED', userId: admin.id } });
    assert.ok(logs.length >= 3, `${logs.length} audit rows`);
    for (const l of logs) assert.ok(!String(l.newValues).includes('00000000'), 'PIN found in audit log');
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll Knox PIN checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
