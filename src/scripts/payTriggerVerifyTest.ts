/**
 * PayTrigger verify / re-enrol test — LOCAL TEST DATABASE and a MOCK PayTrigger only.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/payTriggerVerifyTest.ts
 *
 * Starts a fake PayTrigger API on 127.0.0.1 and runs the sidecar in live mode
 * against it, so the real-world answers (unknown IMEI, rejected IMEI, already
 * enrolled, active phone) can be exercised without touching Transsion.
 */
import * as http from 'http';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

const MOCK_PORT = 55990;
process.env.PAYTRIGGER_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.PAYTRIGGER_API_KEY = 'mock-key';
process.env.PAYTRIGGER_DRY_RUN = 'false';
process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = 'true';
process.env.PAYTRIGGER_CANARY_CONTRACTS = '';

// What the mock PayTrigger "holds": imei → serverState (500 pre-enrolled, 3000 active).
const held = new Map<string, number>();
const rejected = new Set<string>(); // IMEIs the mock refuses (blacklist, 50078)
const calls: string[] = [];

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};
    calls.push(req.url || '');
    const reply = (o: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (req.url?.endsWith('/lock/v1/imei/input')) {
      const list = JSON.parse(json.imeiInfo) as Array<{ imei: string }>;
      const failures: Array<{ imei: string; errCode: number; message: string }> = [];
      for (const { imei } of list) {
        if (rejected.has(imei)) failures.push({ imei, errCode: 50078, message: 'The IMEI matches the blacklist' });
        else if (held.has(imei)) failures.push({ imei, errCode: 50015, message: 'This IMEI has been enrolled or activated and cannot be enrolled again.' });
        else held.set(imei, 500);
      }
      return reply(failures.length ? { code: 50021, message: 'Some IMEI entry failed', data: failures } : { code: 200, message: 'Success', data: [] });
    }
    if (req.url?.endsWith('/lock/v1/getDevice')) {
      const state = held.get(json.imei);
      return reply(state === undefined ? { code: 20001, message: 'DeviceTag or imei does not exist' } : { code: 200, message: 'Success', data: { deviceTag: 'TAG' + json.imei.slice(-4), lockState: state, serverState: state } });
    }
    if (req.url?.endsWith('/lock/v1/findLockState')) {
      return reply({ code: 200, message: 'Success', data: { imei: json.imei, mobileStatus: 1000, lockState: 3000, apkVersion: '2.2.7.001', lastConnectTime: Math.floor(Date.now() / 1000) } });
    }
    if (req.url?.endsWith('/model/v1/get')) return reply({ code: 200, message: 'Success', data: { brandName: 'TECNO' } });
    if (req.url?.endsWith('/lock/v1/updateRepayInfo')) return reply({ code: 200, message: 'Success' });
    return reply({ code: 200, message: 'Success', data: [] });
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

async function main() {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));
  const admin = await import('../services/payTrigger/admin');
  const { resendSimulatedEnrolments } = await import('../services/payTrigger/sweep');
  const { invalidatePayTriggerProducts } = await import('../services/payTrigger/guard');

  const TAG = `vt${Date.now()}`;
  const cat = await prisma.productCategory.create({ data: { name: `${TAG}-cat` } });
  const product = await prisma.product.create({ data: { name: `TECNO SPARK ${TAG}`, basePrice: 1800, categoryId: cat.id } });
  await prisma.payTriggerProduct.create({ data: { productId: product.id, brand: 'TECNO' } });
  invalidatePayTriggerProducts();
  let n = 0;
  const imei = () => {
    const body = '35' + String(Date.now()).slice(-8) + String(++n).padStart(4, '0');
    let sum = 0;
    for (let i = 0; i < 14; i++) { let d = Number(body[i]); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
    return body + ((10 - (sum % 10)) % 10);
  };
  const stock = async () => prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: imei(), status: 'AVAILABLE' } });
  const deviceOf = (itemId: string) => prisma.payTriggerDevice.findUniqueOrThrow({ where: { inventoryItemId: itemId } });
  const info = async (itemId: string, productId: string) => (await admin.payTriggerInfoForItems([{ id: itemId, productId }])).get(itemId)!;

  console.log('Enrolment');
  const a = await stock();
  await check('a normal enrolment is sent and confirmed live', async () => {
    const [r] = await admin.enrolItems([a.id], 'tester');
    assert.ok(r.ok, r.message);
    assert.strictEqual((await deviceOf(a.id)).enrollmentStatus, 'QUEUED');
    const i = await info(a.id, product.id);
    assert.strictEqual((i.payTrigger as any).enrolledLive, true);
    assert.strictEqual(i.needsEnrolment, false);
  });

  const b = await stock();
  rejected.add(b.serialNumber);
  await check('a rejected IMEI is recorded as failed with the reason, and offered again', async () => {
    const [r] = await admin.enrolItems([b.id], 'tester');
    assert.ok(!r.ok);
    const d = await deviceOf(b.id);
    assert.strictEqual(d.enrollmentStatus, 'FAILED');
    assert.match(d.lastError || '', /blacklist/i);
    assert.strictEqual((await info(b.id, product.id)).needsEnrolment, true);
  });
  await check('enrolling again after the problem is fixed succeeds', async () => {
    rejected.delete(b.serialNumber);
    const [r] = await admin.enrolItems([b.id], 'tester');
    assert.ok(r.ok, r.message);
    const d = await deviceOf(b.id);
    assert.deepStrictEqual([d.enrollmentStatus, d.lastError], ['QUEUED', null]);
  });

  const c = await stock();
  held.set(c.serialNumber, 500);
  await check('an IMEI PayTrigger already holds counts as enrolled, not as an error', async () => {
    const [r] = await admin.enrolItems([c.id], 'tester');
    assert.ok(r.ok, r.message);
    assert.match(r.message, /Already enrolled/);
  });

  console.log('Verify');
  await check('verify on a pre-enrolled phone → waiting for activation', async () => {
    const v = await admin.verifyDevice((await deviceOf(a.id)).id, 'tester');
    assert.strictEqual(v.status, 'WAITING', v.message);
  });
  const lost = await stock();
  await check('verify on a phone PayTrigger does not hold → not registered, enrol again offered', async () => {
    // Recorded as enrolled, but the mock has never seen it (like a dry-run enrolment).
    const d = await prisma.payTriggerDevice.create({ data: { inventoryItemId: lost.id, imei: lost.serialNumber, enrollmentStatus: 'QUEUED' } });
    const v = await admin.verifyDevice(d.id, 'tester');
    assert.strictEqual(v.status, 'NOT_REGISTERED');
    assert.strictEqual((await deviceOf(lost.id)).enrollmentStatus, 'FAILED');
    assert.strictEqual((await info(lost.id, product.id)).needsEnrolment, true);
  });
  await check('verify on a phone that has been switched on → active, with its lock state', async () => {
    held.set(a.serialNumber, 3000);
    const v = await admin.verifyDevice((await deviceOf(a.id)).id, 'tester');
    assert.strictEqual(v.status, 'ACTIVE');
    const d = await deviceOf(a.id);
    assert.deepStrictEqual([d.enrollmentStatus, d.committedState, d.apkVersion], ['ACTIVE', 'LOCKED', '2.2.7.001']);
  });
  await check('an active phone is never re-enrolled', async () => {
    const [r] = await admin.enrolItems([a.id], 'tester');
    assert.ok(!r.ok);
    assert.match(r.message, /Already active/);
  });

  console.log('Switching to live');
  const sim = await stock();
  await check('a phone enrolled only in dry run is re-sent by the sweep once live', async () => {
    const d = await prisma.payTriggerDevice.create({ data: { inventoryItemId: sim.id, imei: sim.serialNumber, enrollmentStatus: 'QUEUED' } });
    await prisma.payTriggerActionLog.create({ data: { deviceId: d.id, action: 'ENROL', success: true, dryRun: true } });
    assert.strictEqual((await info(sim.id, product.id)).needsEnrolment, true, 'flagged before');
    assert.ok(!held.has(sim.serialNumber));
    const resent = await resendSimulatedEnrolments();
    assert.ok(resent >= 1, `${resent} re-sent`);
    assert.ok(held.has(sim.serialNumber), 'mock PayTrigger now holds it');
    assert.strictEqual((await info(sim.id, product.id)).needsEnrolment, false, 'confirmed after');
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll verify / re-enrol checks passed');
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
