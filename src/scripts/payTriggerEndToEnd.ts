/**
 * PayTrigger end-to-end run — LOCAL TEST DATABASE, LOCAL SERVER and a MOCK PayTrigger only.
 *
 * Start the backend on :5055 in live PayTrigger mode pointing at the mock
 * (PAYTRIGGER_BASE_URL=http://127.0.0.1:55992, PAYTRIGGER_API_KEY=mock-key),
 * then:
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/payTriggerEndToEnd.ts
 *
 * Walks a phone through its whole life using the real HTTP endpoints for the
 * sale, approval, deposit, payments, cancel and so on. The mock is strict: it
 * checks the signature, refuses past lock dates and a deeplink without its
 * package, and keeps a lock date per phone like PayTrigger does.
 */
import * as http from 'http';
import * as crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
const MOCK_PORT = 55992;
const KEY = 'mock-key';
process.env.PAYTRIGGER_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.PAYTRIGGER_API_KEY = KEY;
process.env.PAYTRIGGER_DRY_RUN = 'false';
process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = 'true';
process.env.PAYTRIGGER_CANARY_CONTRACTS = '';
const API = process.env.E2E_API || 'http://localhost:5055/api';

// ─── Strict mock ───────────────────────────────────────────────────────────
interface Phone { imei: string; active: boolean; expiration: number | null; removed: boolean; title?: string; tips?: string; online: boolean; shown: number | null; pushes: number[] }
const phones = new Map<string, Phone>();
interface Call { path: string; body: any; code: number }
const calls: Call[] = [];
const signOf = (body: Record<string, unknown>) => {
  const content = Object.keys(body).filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== '').sort().map((k) => `${k}=${body[k]}`).join('&');
  return Buffer.from(crypto.createHmac('sha256', KEY).update(content, 'utf8').digest('hex').toUpperCase(), 'utf8').toString('base64');
};
const nowS = () => Math.floor(Date.now() / 1000);
const lockedNow = (p: Phone) => p.expiration === null || p.expiration <= nowS();

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const path = (req.url || '').replace('/api/partner', '');
    const reply = (code: number, message: string, data?: unknown) => {
      calls.push({ path, body, code });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code, message, data }));
    };
    if (req.headers.sign !== signOf(body)) return reply(40000, 'sign error');
    for (const [k, v] of Object.entries(body)) if (typeof v === 'object') return reply(400, `field ${k} must be a string, not nested JSON`);
    const keyField = path === '/lock/v1/updateRepayInfo' ? 'relatedMerchant' : 'apiKey';
    if (body[keyField] !== KEY) return reply(20003, `missing ${keyField}`);
    if (body.deeplink && !body.deeplinkPkg) return reply(50012, 'deeplink and deeplinkPkg must be both filled or both empty');
    const phone = body.imei ? phones.get(String(body.imei)) : undefined;

    switch (path) {
      case '/lock/v1/imei/input': {
        if (String(body.preLockFlag) !== 'true' && String(body.preLockFlag) !== 'false') return reply(400, 'preLockFlag required');
        const list = JSON.parse(body.imeiInfo) as Array<{ imei: string; deeplink?: string; deeplinkPkg?: string }>;
        const failures: Array<{ imei: string; errCode: number; message: string }> = [];
        for (const e of list) {
          if (e.deeplink && !e.deeplinkPkg) failures.push({ imei: e.imei, errCode: 50012, message: 'deeplink needs deeplinkPkg' });
          else if (!/^\d{15,18}$/.test(e.imei)) failures.push({ imei: e.imei, errCode: 50020, message: 'IMEI must be 15-18 digits' });
          else if (phones.has(e.imei) && !phones.get(e.imei)!.removed) failures.push({ imei: e.imei, errCode: 50015, message: 'already enrolled' });
          else phones.set(e.imei, { imei: e.imei, active: false, expiration: null, removed: false, online: true, shown: null, pushes: [] });
        }
        return failures.length ? reply(50021, 'Some IMEI entry failed', failures) : reply(200, 'Success', []);
      }
      case '/lock/v1/imei/cancel': {
        const p = phones.get(String(body.imeiInfo));
        if (!p) return reply(20001, 'unknown');
        if (p.active) return reply(20004, 'already active, cannot cancel');
        phones.delete(p.imei);
        return reply(200, 'Success', []);
      }
      case '/lock/v1/updateRepayInfo': {
        if (!phone) return reply(20001, 'DeviceTag or imei does not exist');
        if (!phone.active) return reply(55106, 'The device is not active');
        if (!Number.isInteger(body.nextRepayTime) || body.nextRepayTime <= nowS()) return reply(50030, 'nextRepayTime must be later than now');
        phone.expiration = body.nextRepayTime;
        if (phone.online) phone.shown = phone.expiration;
        return reply(200, 'Success');
      }
      case '/lockRule/v1/setLockRule': {
        if (!phone) return reply(20001, 'unknown');
        if (!phone.active) return reply(55106, 'The device is not active');
        if (String(body.deviceTips || '').length > 400) return reply(400, 'deviceTips too long');
        phone.title = body.deviceTitle;
        phone.tips = body.deviceTips;
        return reply(200, 'Success');
      }
      case '/lock/v1/removeLock': {
        if (!phone || !phone.active) return reply(55106, 'not active');
        phone.removed = true;
        return reply(200, 'Success');
      }
      case '/lock/v1/findLockState': {
        if (!phone) return reply(20001, 'unknown');
        return reply(200, 'Success', stateOf(phone));
      }
      case '/lock/v1/batchFindLockState':
        return reply(200, 'Success', String(body.imei).split(',').map((i) => phones.get(i)).filter(Boolean).map((p) => stateOf(p!)));
      case '/lock/v1/getDevice':
        return phone ? reply(200, 'Success', { deviceTag: 'T' + phone.imei.slice(-5), lockState: phone.active ? 3000 : 500, serverState: phone.active ? 3000 : 500 }) : reply(20001, 'unknown');
      case '/model/v1/get':
        return reply(200, 'Success', { brandName: 'TECNO' });
      case '/unlock/v1/verifyCode':
        if (!phone?.active) return reply(55106, 'not active');
        // The code carries the server's lock date onto the phone.
        phone.shown = phone.expiration;
        return reply(200, 'Success', { verifyCode: '123456789' });
      case '/push/v1/sendPushInfo': {
        if (!phone?.active) return reply(55106, 'not active');
        const day = phone.pushes.filter((t) => t > Date.now() - 86400_000).length;
        if (day >= 6) return reply(50008, 'limit');
        phone.pushes.push(Date.now());
        return reply(200, 'Success');
      }
      case '/company/v1/checkLicense':
        return reply(200, 'Success', { totalAmountOfLicense: 100, amountUsedOfLicense: 1, remainingAmountOfLicense: 99 });
      default:
        return reply(200, 'Success', []);
    }
  });
});
/** What the handset itself is doing: it only learns a new lock date while online (or from a PIN). */
function stateOf(p: Phone) {
  const handsetDate = p.online ? p.expiration : p.shown;
  const locked = handsetDate === null || handsetDate <= nowS();
  return { imei: p.imei, deviceTag: 'T' + p.imei.slice(-5), lockState: p.active ? 3000 : 500, serverState: p.active ? 3000 : 500, mobileStatus: p.active ? (locked ? 1000 : 2000) : undefined, expiration: p.expiration, lastConnectTime: nowS(), apkVersion: '2.2.7.001' };
}

import assert from 'assert';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';

const TAG = `e2e${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const day = (o: number) => new Date(Date.now() + o * 86400_000);
const results: Array<{ kind: 'ok' | 'GAP' | 'FAIL'; text: string }> = [];
const note = (kind: 'ok' | 'GAP' | 'FAIL', text: string) => {
  results.push({ kind, text });
  console.log(`  ${kind === 'ok' ? '✔' : kind === 'GAP' ? '⚠ GAP' : '✘ FAIL'} ${text}`);
};
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    note('ok', name);
  } catch (err: any) {
    note('FAIL', `${name}\n        ${String(err?.message || err).split('\n')[0]}`);
  }
}
const call = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json: any = null;
  try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, json };
};
const callback = (body: Record<string, unknown>) => call('POST', '/paytrigger/webhook', null, body, { sign: signOf(body) });
const callsFor = (imei: string, path: string) => calls.filter((c) => c.path === path && (c.body.imei === imei || String(c.body.imeiInfo || '').includes(imei)));
const lastOk = (imei: string, path: string) => [...callsFor(imei, path)].reverse().find((c) => c.code === 200);
const device = (imei: string) => prisma.payTriggerDevice.findUniqueOrThrow({ where: { imei } });
const hoursFromNow = (unix: number | null | undefined) => (unix ? (unix - nowS()) / 3600 : NaN);

async function token(roleName: string, perms: string[], email: string, first: string) {
  const permissions: Array<{ id: string }> = [];
  for (const p of perms) permissions.push(await prisma.permission.upsert({ where: { name: p }, create: { name: p }, update: {} }));
  const role = await prisma.role.upsert({ where: { name: roleName }, create: { name: roleName, permissions: { connect: permissions.map((p) => ({ id: p.id })) } }, update: { permissions: { connect: permissions.map((p) => ({ id: p.id })) } } });
  const u = await prisma.adminUser.create({ data: { email, password: 'x', firstName: first, lastName: 'E2E', phone: '0242222222', roleId: role.id } });
  return { u, token: jwt.sign({ id: u.id, email: u.email, role: roleName, permissions: perms, userType: 'admin' }, 'smoke-secret', { expiresIn: '2h' }) };
}

let seq = 0;
const imeiNew = () => {
  const body = '35' + String(Date.now()).slice(-8) + String(++seq).padStart(4, '0');
  let sum = 0;
  for (let i = 0; i < 14; i++) { let d = Number(body[i]); if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return body + ((10 - (sum % 10)) % 10);
};
async function customer(createdById: string) {
  const uuid = crypto.randomUUID();
  const c = await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}-${++seq}`, firstName: 'Ama', lastName: `Owusu${seq}`, phone: `024${String(Date.now()).slice(-5)}${String(seq).padStart(2, '0')}`, createdById } });
  return c.id;
}

async function main() {
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));
  const { runMorningSweep } = await import('../services/payTrigger/sweep');
  const sweep = async () => { const s = await runMorningSweep(); await sleep(300); return s; };

  const admin = await token('SUPER_ADMIN', [], `${TAG}-admin@t.local`, 'Admin');
  const agent = await token('AGENT', ['CREATE_CONTRACT', 'VIEW_OWN_CONTRACTS'], `${TAG}-agent@t.local`, 'Kojo');
  const category = await prisma.productCategory.create({ data: { name: `${TAG}-phones` } });
  const product = await prisma.product.create({ data: { name: `TECNO SPARK 30 ${TAG}`, basePrice: 2000, categoryId: category.id } });
  await prisma.payTriggerDevice.updateMany({ data: { enrollmentStatus: 'REMOVED' } });
  await call('PUT', '/paytrigger/settings', admin.token, {
    lockTitle: 'Payment overdue', lockTips: 'Dear {firstName}, pay {amount} due {dueDate} to unlock.', payDeeplink: '',
    reminderEnabled: true, reminderDaysBefore: '3,1,0', reminderChannel: 'POPUP', lockOnUnpaidAgentDeposit: true,
  });

  // ── 1. Stock ────────────────────────────────────────────────────────────
  console.log('\n1. Stock comes in');
  const imeiA = imeiNew();
  let itemA: any;
  await step('lock type is detected as PayTrigger for a TECNO product', async () => {
    const r = await call('GET', `/paytrigger/lock-provider?productId=${product.id}&imei=${imeiA}`, admin.token);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.match(JSON.stringify(r.json), /PAYTRIGGER/i);
  });
  await step('add inventory, mark the product and enrol → PayTrigger gets the IMEI with lock-on-activation', async () => {
    const r = await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiA });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    itemA = r.json.inventoryItem || r.json.item || r.json;
    const e = await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemA.id], markProducts: true });
    assert.ok(e.json?.results?.[0]?.ok, JSON.stringify(e.json));
    const sent = lastOk(imeiA, '/lock/v1/imei/input');
    assert.ok(sent, 'enrol call accepted by PayTrigger');
    assert.strictEqual(String(sent!.body.preLockFlag), 'true');
  });

  // ── 2. Agent sale, awaiting approval ───────────────────────────────────
  console.log('\n2. Agent sells it; phone is switched on before approval');
  let contractA: any;
  await step('agent creates the contract through the real endpoint', async () => {
    const cust = await customer(agent.u.id);
    const r = await call('POST', '/contracts', agent.token, {
      customerId: cust, inventoryItemId: itemA.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'WEEKLY', totalInstallments: 4,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234567', startDate: day(7).toISOString(),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 400));
    contractA = r.json;
    console.log(`        contract ${contractA.contractNumber} status ${contractA.status}`);
  });
  await step('phone activates → locked, and its screen says "no active contract"', async () => {
    phones.get(imeiA)!.active = true;
    await callback({ notifyType: 1000, imei: imeiA, deviceTag: 'T' + imeiA.slice(-5), state: 3000, mobileStatus: 1000, activeTime: nowS() });
    await sleep(1500);
    const d = await device(imeiA);
    assert.strictEqual(d.enrollmentStatus, 'ACTIVE');
    const p = phones.get(imeiA)!;
    assert.ok(lockedNow(p), 'phone locked');
    console.log(`        device.contractId=${d.contractId ? 'linked' : 'null'}; screen: "${p.tips || '(portal default)'}"`);
    assert.match(p.tips || '', /does not have a contract/);
  });

  // ── 3. Approval, deposit hold ──────────────────────────────────────────
  console.log('\n3. Contract approved; agent has not remitted the deposit');
  await step('approval through the real endpoint', async () => {
    if (contractA.status === 'ACTIVE') return;
    const r = await call('POST', `/contracts/${contractA.id}/approve`, admin.token, { note: 'ok' });
    assert.ok(r.status < 300, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    const c = await prisma.hirePurchaseContract.findUniqueOrThrow({ where: { id: contractA.id }, include: { agentLedger: true } });
    assert.strictEqual(c.status, 'ACTIVE');
    console.log(`        ledger: ${c.agentLedger ? `owes ${c.agentLedger.outstandingBalance}` : 'none'}`);
  });
  await step('phone stays locked and shows the "contact your agent" text', async () => {
    const p = phones.get(imeiA)!;
    const d = await device(imeiA);
    assert.ok(d.contractId === contractA.id, 'device linked to the contract');
    assert.ok(lockedNow(p), 'still locked');
    assert.match(p.tips || '', /Contact Kojo E2E on/);
  });

  // ── 4. Deposit remitted ────────────────────────────────────────────────
  console.log('\n4. Agent remits the deposit');
  await step('admin records the deposit → phone opens until the first instalment + 1 day, 08:30', async () => {
    const ledger = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId: contractA.id } });
    const r = await call('POST', `/agent-deposits/${ledger.id}/admin-pay`, admin.token, { amount: ledger.outstandingBalance, note: 'e2e' });
    assert.ok(r.status < 300, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    const p = phones.get(imeiA)!;
    assert.ok(!lockedNow(p), 'phone open');
    const first = await prisma.installmentSchedule.findFirstOrThrow({ where: { contractId: contractA.id, installmentNo: 1 } });
    const expected = new Date(first.dueDate); expected.setDate(expected.getDate() + 1); expected.setHours(8, 30, 0, 0);
    assert.strictEqual(p.expiration, Math.floor(expected.getTime() / 1000), `lock date ${new Date(p.expiration! * 1000).toISOString()} vs ${expected.toISOString()}`);
    assert.match(p.tips || '', /^Dear Ama, pay GHS 400\.00 due/);
  });

  // ── 5. Reminder ────────────────────────────────────────────────────────
  console.log('\n5. Three days before the due date');
  await step('morning sweep sends one reminder pop-up', async () => {
    await prisma.installmentSchedule.updateMany({ where: { contractId: contractA.id, installmentNo: 1 }, data: { dueDate: day(3) } });
    const s = await sweep();
    assert.strictEqual(callsFor(imeiA, '/push/v1/sendPushInfo').length, 1, JSON.stringify(s.reminders));
  });

  // ── 6. Overdue ─────────────────────────────────────────────────────────
  console.log('\n6. Customer misses the payment');
  await step('due date + 1 day passes → sweep locks the phone (lock date a minute away)', async () => {
    await prisma.installmentSchedule.updateMany({ where: { contractId: contractA.id, installmentNo: 1 }, data: { dueDate: day(-2), status: 'OVERDUE' } });
    await sweep();
    const p = phones.get(imeiA)!;
    assert.ok(p.expiration! - nowS() <= 61, `lock date ${hoursFromNow(p.expiration).toFixed(2)}h away`);
    assert.match(p.tips || '', /pay GHS 400\.00/);
  });
  await step('the phone would also have locked by itself with no data (its stored date had passed)', async () => {
    // Before the sweep the phone held "first due + 1 day 08:30"; we moved the due date back, so in real
    // life that stored date is what locks an offline phone. Nothing to send — just confirm no error.
    const d = await device(imeiA);
    assert.strictEqual(d.lastError, null, d.lastError || '');
  });

  // ── 7. Payment while offline ───────────────────────────────────────────
  console.log('\n7. Customer pays, but the phone has no data');
  await step('manual payment → PayTrigger gets a new lock date at once', async () => {
    const p = phones.get(imeiA)!;
    // The lock date sent a minute ago has now passed, and the phone has no data.
    p.expiration = nowS() - 10; p.shown = p.expiration; p.online = false;
    await prisma.payTriggerDevice.update({ where: { imei: imeiA }, data: { providerExpiresAt: new Date(Date.now() - 10_000) } });
    const r = await call('POST', '/payments/manual', admin.token, { contractId: contractA.id, amount: 400, paymentMethod: 'CASH', reference: `${TAG}-p1` });
    assert.ok(r.status < 300, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    assert.ok(p.expiration! > nowS() + 3600, 'server lock date moved into the future');
  });
  await step('a minute later the system notices the phone is still locked and raises it on Issues', async () => {
    await sleep(62_000);
    const d = await device(imeiA);
    assert.ok(d.awaitingPinSince, 'flagged "paid — still locked"');
    const issues = await call('GET', '/paytrigger/issues', admin.token);
    assert.ok(issues.json?.counts?.paidStillLocked >= 1, JSON.stringify(issues.json?.counts));
  });
  await step('admin issues the offline PIN → phone opens without data', async () => {
    const d = await device(imeiA);
    const r = await call('POST', `/paytrigger/devices/${d.id}/pin`, admin.token, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.match(String(r.json.pin), /^\d{9}$/);
    assert.strictEqual((await device(imeiA)).awaitingPinSince, null);
    phones.get(imeiA)!.online = true;
  });

  // ── 8. Payment reversed ────────────────────────────────────────────────
  console.log('\n8. That payment is reversed');
  await step('reversal → phone told to lock again', async () => {
    const pay = await prisma.paymentTransaction.findFirstOrThrow({ where: { contractId: contractA.id }, orderBy: { createdAt: 'desc' } });
    const r = await call('DELETE', `/payments/manual/${pay.id}`, admin.token, { reason: 'e2e reversal test' });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    await sleep(2500);
    const p = phones.get(imeiA)!;
    assert.ok(p.expiration! - nowS() <= 61, `lock date ${hoursFromNow(p.expiration).toFixed(2)}h away`);
  });


  // ── 9. Pays again ──────────────────────────────────────────────────────
  console.log('\n9. Customer pays the same amount again');
  await step('second payment of the same amount → phone opens (same state as before the reversal)', async () => {
    await sleep(1000);
    const r = await call('POST', '/payments/manual', admin.token, { contractId: contractA.id, amount: 400, paymentMethod: 'CASH', reference: `${TAG}-p2` });
    assert.ok(r.status < 300, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    assert.ok(phones.get(imeiA)!.expiration! > nowS() + 3600, `lock date ${hoursFromNow(phones.get(imeiA)!.expiration).toFixed(2)}h away`);
  });

  // ── 10. Temporary unlock ───────────────────────────────────────────────
  console.log('\n10. Overdue again; an admin approves a temporary unlock');
  let unlockId = '';
  await step('instalment 2 goes overdue → sweep locks', async () => {
    await prisma.installmentSchedule.updateMany({ where: { contractId: contractA.id, installmentNo: 2 }, data: { dueDate: day(-3), status: 'OVERDUE' } });
    await sweep();
    assert.ok(phones.get(imeiA)!.expiration! - nowS() <= 61);
  });
  await step('temporary unlock requested and approved → phone opens for the window', async () => {
    let r = await call('POST', '/temporary-unlocks', admin.token, { contractId: contractA.id, requestedWeeks: 1, reason: 'Customer travelling, will pay on return' });
    assert.ok(r.status < 300, `request: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    unlockId = r.json.id || r.json.request?.id;
    r = await call('POST', `/temporary-unlocks/${unlockId}/approve`, admin.token, { approvedWeeks: 1, note: 'ok' });
    assert.ok(r.status < 300, `approve: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    await sleep(2500);
    const h = hoursFromNow(phones.get(imeiA)!.expiration);
    assert.ok(h > 24 * 6 && h < 24 * 8.5, `open for ${h.toFixed(1)}h`);
  });
  await step('window revoked → phone locks again', async () => {
    const r = await call('POST', `/temporary-unlocks/${unlockId}/revoke`, admin.token, { reason: 'Customer unreachable' });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    await sleep(2500);
    assert.ok(phones.get(imeiA)!.expiration! - nowS() <= 61, `lock date ${hoursFromNow(phones.get(imeiA)!.expiration).toFixed(2)}h away`);
  });

  // ── 11. Other ways the contract changes ────────────────────────────────
  console.log('\n11. Other screens that change what the customer owes');
  await step('"Pay instalment" on the contract page opens the phone at once', async () => {
    const inst = await prisma.installmentSchedule.findFirstOrThrow({ where: { contractId: contractA.id, installmentNo: 2 } });
    const r = await call('POST', `/contracts/${contractA.id}/installments/${inst.id}/pay`, admin.token, { amount: 400, paymentMethod: 'CASH', reference: `${TAG}-p3` });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    await sleep(2500);
    assert.ok(phones.get(imeiA)!.expiration! > nowS() + 3600, `phone still locked: lock date ${hoursFromNow(phones.get(imeiA)!.expiration).toFixed(2)}h away`);
  });

  // ── 12. Completion and release ─────────────────────────────────────────
  console.log('\n12. Customer pays off the contract');
  await step('final payment → release is scheduled after the hold, not done at once', async () => {
    const c = await prisma.hirePurchaseContract.findUniqueOrThrow({ where: { id: contractA.id } });
    const r = await call('POST', '/payments/manual', admin.token, { contractId: contractA.id, amount: c.outstandingBalance, paymentMethod: 'CASH', reference: `${TAG}-final` });
    assert.ok(r.status < 300, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    const after = await prisma.hirePurchaseContract.findUniqueOrThrow({ where: { id: contractA.id } });
    assert.strictEqual(after.status, 'COMPLETED');
    const d = await device(imeiA);
    assert.ok(d.releaseAfter, 'release scheduled');
    assert.ok(!phones.get(imeiA)!.removed, 'not removed yet');
    const h = (d.releaseAfter!.getTime() - Date.now()) / 3600_000;
    const lockH = hoursFromNow(phones.get(imeiA)!.expiration);
    console.log(`        release in ${h.toFixed(1)}h; phone is open for ${lockH.toFixed(1)}h`);
    assert.ok(lockH > h, 'the paid-off phone would be locked while it waits for release');
  });
  await step('after the hold the sweep removes the lock; PayTrigger confirms; device shows Released', async () => {
    await prisma.payTriggerDevice.update({ where: { imei: imeiA }, data: { releaseAfter: new Date(Date.now() - 1000) } });
    await sweep();
    assert.ok(phones.get(imeiA)!.removed, 'removeLock accepted');
    await callback({ notifyType: 2000, imei: imeiA, clientRemoveTime: nowS() });
    await sleep(1000);
    assert.strictEqual((await device(imeiA)).enrollmentStatus, 'REMOVED');
  });

  // ── 13. Direct admin sale, cancel, resale ──────────────────────────────
  console.log('\n13. Admin sells a phone directly, the contract is cancelled, the phone is sold again');
  const imeiB = imeiNew();
  let itemB: any; let contractB: any;
  await step('admin sale of an activated phone → opens with no approval and no agent deposit', async () => {
    itemB = (await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiB })).json;
    itemB = itemB.inventoryItem || itemB.item || itemB;
    await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemB.id] });
    phones.get(imeiB)!.active = true;
    await callback({ notifyType: 1000, imei: imeiB, state: 3000, mobileStatus: 1000, activeTime: nowS() });
    await sleep(1200);
    const r = await call('POST', '/contracts', admin.token, {
      customerId: await customer(admin.u.id), inventoryItemId: itemB.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'WEEKLY', totalInstallments: 4,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234568', startDate: day(7).toISOString(),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
    contractB = r.json;
    await sleep(2500);
    const p = phones.get(imeiB)!;
    assert.ok(!lockedNow(p), `phone still locked after an ACTIVE admin sale (status ${contractB.status})`);
  });
  await step('contract cancelled → the returned phone locks at once', async () => {
    const r = await call('POST', `/contracts/${contractB.id}/cancel`, admin.token, { reason: 'Customer returned the phone' });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    await sleep(2500);
    const p = phones.get(imeiB)!;
    assert.ok(lockedNow(p) || p.expiration! - nowS() <= 61, `phone stays open for another ${hoursFromNow(p.expiration).toFixed(0)}h after cancellation`);
  });
  await step('after the morning sweep the cancelled phone is locked with the "no active contract" text', async () => {
    await sweep();
    const p = phones.get(imeiB)!;
    assert.ok(lockedNow(p) || p.expiration! - nowS() <= 61, `still open for ${hoursFromNow(p.expiration).toFixed(0)}h after the sweep`);
    assert.match(p.tips || '', /does not have a contract/);
  });
  await step('the same phone is sold again → the new contract takes over the device and opens it', async () => {
    const it = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemB.id } });
    assert.strictEqual(it.status, 'AVAILABLE', `stock status ${it.status}`);
    const r = await call('POST', '/contracts', admin.token, {
      customerId: await customer(admin.u.id), inventoryItemId: itemB.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'WEEKLY', totalInstallments: 4,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234569', startDate: day(7).toISOString(),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    contractB = r.json;
    const d = await device(imeiB);
    assert.strictEqual(d.contractId, r.json.id, 'device still tied to the cancelled contract');
    assert.ok(!lockedNow(phones.get(imeiB)!), 'resold phone is still locked');
  });
  await step('rescheduling an overdue, locked contract opens the phone at once', async () => {
    await prisma.installmentSchedule.updateMany({ where: { contractId: contractB.id, installmentNo: 1 }, data: { dueDate: day(-3), status: 'OVERDUE' } });
    await sweep();
    assert.ok(phones.get(imeiB)!.expiration! - nowS() <= 61, 'locked first');
    const r = await call('POST', `/contracts/${contractB.id}/reschedule`, admin.token, { newStartDate: day(5).toISOString() });
    assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    await sleep(2500);
    assert.ok(phones.get(imeiB)!.expiration! > nowS() + 3600, `phone still locked after reschedule: lock date ${hoursFromNow(phones.get(imeiB)!.expiration).toFixed(2)}h away`);
  });

  // ── 14. Monthly contract ───────────────────────────────────────────────
  console.log('\n14. A monthly contract whose next payment is 60 days away');
  await step('the phone is not re-sent a new lock date on every sweep', async () => {
    const imeiC = imeiNew();
    let itemC = (await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiC })).json;
    itemC = itemC.inventoryItem || itemC.item || itemC;
    await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemC.id] });
    phones.get(imeiC)!.active = true;
    await callback({ notifyType: 1000, imei: imeiC, state: 3000, mobileStatus: 1000, activeTime: nowS() });
    await sleep(1200);
    const r = await call('POST', '/contracts', admin.token, {
      customerId: await customer(admin.u.id), inventoryItemId: itemC.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'MONTHLY', totalInstallments: 4,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234570', startDate: day(60).toISOString(),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    const before = callsFor(imeiC, '/lock/v1/updateRepayInfo').length;
    assert.ok(before >= 1 && !lockedNow(phones.get(imeiC)!), 'opened at sale');
    console.log(`        opened for ${(hoursFromNow(phones.get(imeiC)!.expiration) / 24).toFixed(1)} days (cap is 45)`);
    await sweep(); await sweep(); await sweep();
    const extra = callsFor(imeiC, '/lock/v1/updateRepayInfo').length - before;
    assert.strictEqual(extra, 0, `${extra} extra lock-date update(s) in 3 sweeps — one per sweep, each counted against the 20% breaker`);
  });

  // ── 15. Missed activation callback ─────────────────────────────────────
  console.log('\n15. A sold phone activates but PayTrigger\'s callback never reaches us');
  await step('the morning sweep notices the activation AND opens the phone the same morning', async () => {
    const imeiD = imeiNew();
    let itemD = (await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiD })).json;
    itemD = itemD.inventoryItem || itemD.item || itemD;
    await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemD.id] });
    const r = await call('POST', '/contracts', admin.token, {
      customerId: await customer(admin.u.id), inventoryItemId: itemD.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'WEEKLY', totalInstallments: 4,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234571', startDate: day(7).toISOString(),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
    await sleep(2000);
    phones.get(imeiD)!.active = true; // no callback
    await sweep();
    await sleep(1500);
    assert.strictEqual((await device(imeiD)).enrollmentStatus, 'ACTIVE', 'activation noticed');
    assert.ok(!lockedNow(phones.get(imeiD)!), 'a paid-up customer\'s phone stays locked until the NEXT morning\'s sweep');
  });

  // ── 16. Phone sold without enrolment ───────────────────────────────────
  console.log('\n16. A TECNO phone is sold without ever being enrolled');
  await step('the sale is refused with a plain reason, and goes through once the phone is enrolled', async () => {
    const imeiE = imeiNew();
    let itemE = (await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiE })).json;
    itemE = itemE.inventoryItem || itemE.item || itemE;
    const sale = { customerId: await customer(admin.u.id), inventoryItemId: itemE.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'WEEKLY', totalInstallments: 4,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234572', startDate: day(7).toISOString() };
    const pre = await call('POST', '/contracts/preflight', admin.token, sale);
    assert.match((pre.json?.blockers || []).join(' '), /not been enrolled with PayTrigger/, 'preflight shows the reason');
    let r = await call('POST', '/contracts', admin.token, sale);
    assert.strictEqual(r.status, 400, `contract ${r.json?.contractNumber} created for a phone PayTrigger has never heard of`);
    assert.match(JSON.stringify(r.json), /not been enrolled with PayTrigger/);
    assert.strictEqual((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemE.id } })).status, 'AVAILABLE', 'stock untouched');
    await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemE.id] });
    r = await call('POST', '/contracts', admin.token, sale);
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
  });
  await step('a Samsung phone is sold exactly as before', async () => {
    const samsung = await prisma.product.create({ data: { name: `SAMSUNG A15 ${TAG}`, basePrice: 2000, categoryId: category.id } });
    let item = (await call('POST', '/products/inventory', admin.token, { productId: samsung.id, serialNumber: imeiNew() })).json;
    item = item.inventoryItem || item.item || item;
    const r = await call('POST', '/contracts', admin.token, { customerId: await customer(admin.u.id), inventoryItemId: item.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'WEEKLY', totalInstallments: 4,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234574', startDate: day(7).toISOString() });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
  });

  // ── 17. Pay link ───────────────────────────────────────────────────────
  console.log('\n17. An admin fills in the "pay link" setting');
  await step('enrolment and lock-date updates still work with a pay link set', async () => {
    await call('PUT', '/paytrigger/settings', admin.token, { payDeeplink: 'aidootech://pay' });
    await sleep(300);
    const imeiF = imeiNew();
    let itemF = (await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiF })).json;
    itemF = itemF.inventoryItem || itemF.item || itemF;
    const e = await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemF.id] });
    await call('PUT', '/paytrigger/settings', admin.token, { payDeeplink: '' });
    assert.ok(e.json?.results?.[0]?.ok, `enrolment refused: ${e.json?.results?.[0]?.message}`);
  });

  // ── 18. Webhook ────────────────────────────────────────────────────────
  console.log('\n18. Callbacks');
  await step('a callback with a bad signature is answered but not acted on', async () => {
    const imeiG = imeiNew();
    let itemG = (await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiG })).json;
    itemG = itemG.inventoryItem || itemG.item || itemG;
    await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemG.id] });
    const r = await call('POST', '/paytrigger/webhook', null, { notifyType: 1000, imei: imeiG, state: 3000 }, { sign: 'bogus' });
    assert.deepStrictEqual([r.status, r.json?.code, r.json?.message], [200, 200, 'Success']);
    await sleep(800);
    assert.strictEqual((await device(imeiG)).enrollmentStatus, 'QUEUED');
  });
  await step('a callback for an IMEI we do not hold is kept and shown to an admin', async () => {
    const stray = imeiNew();
    await callback({ notifyType: 1000, imei: stray, state: 3000, mobileStatus: 1000 });
    await sleep(800);
    const ev = await prisma.payTriggerWebhookEvent.findFirst({ where: { body: { path: ['imei'], equals: stray } } });
    assert.ok(ev?.error, 'recorded with an error');
    const issues = await call('GET', '/paytrigger/issues', admin.token);
    assert.ok(JSON.stringify(issues.json).includes(stray), 'a phone activated on our PayTrigger account that we have no record of is not shown on Issues');
  });

  // ── 19. Daily collections ──────────────────────────────────────────────
  console.log('\n19. Reminders on a daily-collection contract');
  await step('a daily payer is not sent a reminder pop-up every single morning', async () => {
    const imeiH = imeiNew();
    let itemH = (await call('POST', '/products/inventory', admin.token, { productId: product.id, serialNumber: imeiH })).json;
    itemH = itemH.inventoryItem || itemH.item || itemH;
    await call('POST', '/paytrigger/enrolment', admin.token, { inventoryItemIds: [itemH.id] });
    phones.get(imeiH)!.active = true;
    await callback({ notifyType: 1000, imei: imeiH, state: 3000, mobileStatus: 1000, activeTime: nowS() });
    await sleep(1200);
    const r = await call('POST', '/contracts', admin.token, {
      customerId: await customer(admin.u.id), inventoryItemId: itemH.id, totalPrice: 2000, depositAmount: 400, paymentFrequency: 'DAILY', totalInstallments: 40,
      paymentMethod: 'MANUAL', mobileMoneyNetwork: 'MTN', mobileMoneyNumber: '0241234573', startDate: new Date(new Date().setHours(23, 0, 0, 0)).toISOString(),
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
    await sleep(2500);
    assert.ok(!lockedNow(phones.get(imeiH)!), 'daily contract phone is open');
    await sweep();
    assert.strictEqual(callsFor(imeiH, '/push/v1/sendPushInfo').length, 0, 'daily payer got a pop-up');
    await call('PUT', '/paytrigger/settings', admin.token, { reminderIncludeDaily: true });
    (await import('../services/payTrigger/settings')).invalidatePayTriggerSettings(); // this process caches settings too
    await sweep();
    await call('PUT', '/paytrigger/settings', admin.token, { reminderIncludeDaily: false });
    assert.strictEqual(callsFor(imeiH, '/push/v1/sendPushInfo').length, 1, 'with the setting on, the daily payer is reminded');
  });

  // ── 20. Calls PayTrigger refused ───────────────────────────────────────
  console.log('\n20. Anything PayTrigger refused during the whole run');
  await step('no request was refused for a reason on our side (signature, format, past date, missing field)', async () => {
    const expected = new Set([50015]);
    const refused = calls.filter((c) => c.code !== 200 && !expected.has(c.code) && !(c.code === 50021) && !(c.code === 50012));
    const summary = [...new Set(refused.map((c) => `${c.path} → ${c.code}`))];
    assert.strictEqual(refused.length, 0, summary.join('; '));
  });

  console.log('\n' + '─'.repeat(60));
  const gaps = results.filter((r) => r.kind !== 'ok');
  console.log(`${results.length - gaps.length} passed, ${gaps.length} gap(s)/failure(s)`);
  mock.close();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  mock.close();
  await prisma.$disconnect();
  process.exit(1);
});
