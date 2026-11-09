/**
 * Agent deposits on the short code — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db KNOX_GUARD_DRY_RUN=true PAYTRIGGER_DRY_RUN=true \
 *     npx ts-node --transpile-only src/scripts/ussdAgentDepositTest.ts
 *
 * Hubtel (Receive Money and the status check) is a local mock, Knox runs dry,
 * and texts are recorded instead of sent. Synthetic data only.
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
import assert from 'assert';
import http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.message || err}`); }
}
const day = (o: number) => new Date(Date.now() + o * 86400_000);

async function main() {
  const prompts: any[] = [];
  const hubtelStatus = new Map<string, string>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.startsWith('/status')) {
        const ref = new URL(req.url, 'http://x').searchParams.get('clientReference') || '';
        res.end(JSON.stringify({ responseCode: '0000', data: { status: hubtelStatus.get(ref) || 'Pending', transactionId: `st-${ref}` } }));
        return;
      }
      prompts.push(JSON.parse(body || '{}'));
      res.end(JSON.stringify({ ResponseCode: '0001', Message: 'Transaction pending', Data: { TransactionId: `mock-${prompts.length}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    HUBTEL_RECEIVE_MONEY_URL: `${base}/receive`, HUBTEL_TRANSACTION_STATUS_URL: `${base}/status`,
    HUBTEL_CALLBACK_URL: 'https://api.test.local/api/payments/hubtel/callback', WEBHOOK_SHARED_TOKEN: 'local-test-token',
    HUBTEL_POS_SALES_ID: 'test', HUBTEL_API_KEY: 'test', HUBTEL_API_SECRET: 'test',
    USSD_PROMPT_DELAY_MS: '20', ENABLE_SMS_NOTIFICATIONS: 'false', ENABLE_EMAIL_NOTIFICATIONS: 'false', NALO_API_KEY: '',
    KNOX_GUARD_DRY_RUN: 'true', PAYTRIGGER_DRY_RUN: 'true',
  });

  const texts: Array<{ to: string; message: string }> = [];
  const notifications = require('../services/notificationService');
  notifications.sendSMS = async (o: { to: string; message: string }) => { texts.push(o); return true; };

  const { default: prisma } = require('../config/database');
  const { handleUssdSession } = require('../controllers/paymentController');
  const { handleAgentPaymentCallback, adminManualPay, getMyPaymentPin } = require('../controllers/agentDepositController');
  const { createAdminUser, updateAdminUser, getAllAdminUsers } = require('../controllers/adminUserController');
  const pins = require('../services/agentPinService');
  const deposits = require('../services/agentDepositUssdService');

  const call = (fn: any, req: any): Promise<{ status: number; body: any }> => new Promise((resolve) => {
    let status = 200;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => resolve({ status, body: b }), set: () => res };
    fn({ ip: '127.0.0.1', headers: {}, params: {}, body: {}, query: {}, header: () => '', userType: 'admin', ...req }, res);
  });
  let sessionNo = 0;
  const dial = (body: any): Promise<any> => new Promise((resolve) => {
    const res: any = { status: () => res, json: (b: any) => resolve(b) };
    handleUssdSession({ body: { SessionId: `AD${sessionNo}`, Operator: 'mtn', ClientState: '', ...body } }, res);
  });
  async function session(mobile: string, answers: string[]) {
    sessionNo++;
    const screens: any[] = [await dial({ Type: 'Initiation', Mobile: mobile, Message: '*713#' })];
    for (const a of answers) {
      const last = screens[screens.length - 1];
      if (last.Type === 'release') break;
      screens.push(await dial({ Type: 'Response', Mobile: mobile, Message: a, ClientState: last.ClientState }));
    }
    return screens;
  }
  const callback = (ref: string, ok = true) =>
    call(handleAgentPaymentCallback, { query: { token: 'local-test-token' }, body: { ResponseCode: ok ? '0000' : '2001', Message: ok ? 'Success' : 'Declined', Data: { ClientReference: ref, TransactionId: `tx-${ref}` } } });
  const waitFor = async (fn: () => Promise<boolean> | boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timed out waiting');
  };

  // ── Data ──────────────────────────────────────────────────────────────────
  const T = `ad${Date.now()}`;
  const n = String(Date.now()).slice(-6);
  const role = (name: string) => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const agentRole = await role('AGENT');
  const clusterRole = await role('CLUSTER_AGENT');
  const adminRole = await role('ADMIN');
  const superRole = await role('SUPER_ADMIN');
  const boss = await prisma.adminUser.create({ data: { email: `${T}b@t.local`, password: 'x', firstName: 'Boss', lastName: 'Admin', roleId: superRole.id } });
  const superUser = { id: boss.id, email: boss.email, role: 'SUPER_ADMIN', permissions: [] };

  const agentPhone = `0241${n}`;
  const agent = await prisma.adminUser.create({ data: { email: `${T}a@t.local`, password: 'x', firstName: 'Efua', lastName: 'Agent', phone: agentPhone, roleId: agentRole.id } });
  const agentPin = await pins.issuePaymentPin(agent.id);
  const noPhoneAgent = await prisma.adminUser.create({ data: { email: `${T}c@t.local`, password: 'x', firstName: 'Yaw', lastName: 'Cluster', roleId: clusterRole.id } });
  const noPhonePin = await pins.issuePaymentPin(noPhoneAgent.id);
  const idleAgent = await prisma.adminUser.create({ data: { email: `${T}i@t.local`, password: 'x', firstName: 'Idle', lastName: 'Agent', roleId: agentRole.id } });
  const idlePin = await pins.issuePaymentPin(idleAgent.id);
  const goneAgent = await prisma.adminUser.create({ data: { email: `${T}g@t.local`, password: 'x', firstName: 'Gone', lastName: 'Agent', roleId: agentRole.id } });
  const gonePin = await pins.issuePaymentPin(goneAgent.id);
  await prisma.adminUser.update({ where: { id: goneAgent.id }, data: { isActive: false } });

  // Contract numbers shaped like the real ones (CON + 10 characters).
  let saleNo = 0;
  async function sale(owner: any, name: string, owed: number, ageDays: number) {
    const contractNumber = `CON${n}${String.fromCharCode(65 + Math.floor(saleNo / 26))}${String.fromCharCode(65 + (saleNo++ % 26))}`;
    const customer = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}${name}${ageDays}`, firstName: name.split(' ')[0], lastName: name.split(' ')[1] || 'X', phone: `05${String(Math.random()).slice(2, 10)}`, isActivated: true, createdById: owner.id } });
    const contract = await prisma.hirePurchaseContract.create({ data: {
      contractNumber, customerId_uuid: customer.id_uuid, totalPrice: 1500, depositAmount: 300, financeAmount: 1200, installmentAmount: 300,
      paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: day(-ageDays), endDate: day(60), status: 'ACTIVE',
      outstandingBalance: 1200, totalPaid: 300, createdById: owner.id, approvedAt: day(-ageDays) } });
    const ledger = await prisma.agentDepositLedger.create({ data: { contractId: contract.id, agentId: owner.id, contractNumber: contract.contractNumber, customerName: name,
      depositAmount: owed + 50, commissionAmount: 50, amountDueCompany: owed, amountPaid: 0, outstandingBalance: owed, status: 'PENDING', createdAt: day(-ageDays) } });
    return { contract, ledger };
  }
  const s1 = await sale(agent, 'Kwame Mensah', 100, 9);
  const s2 = await sale(agent, 'Abena Owusu', 80, 6);
  const s3 = await sale(agent, 'Kofi Boateng', 50, 3);
  const solo = await sale(noPhoneAgent, 'Akosua Darko', 120, 2);
  const stranger = `0209${n}`;
  const otherPhone = `0277${n}`;

  console.log('\nAgent deposits on the short code');

  // ── Menu and PIN ──────────────────────────────────────────────────────────
  await check('every caller sees 3. Agent deposits, within 160 characters', async () => {
    const [menu] = await session(stranger, []);
    assert.equal(menu.Message, 'AIDOO TECH\n1. Pay for self\n2. Pay for others\n3. Agent deposits\n0. Cancel');
  });

  await check('choosing 3 asks for the PIN; 0 goes back to the menu', async () => {
    const s = await session(stranger, ['3', '0']);
    assert.equal(s[1].Message, 'Enter your agent payment PIN, or 0 to go back:');
    assert.equal(s[1].ClientState.split('|')[0], 'AGENT_PIN');
    assert.match(s[2].Message, /3\. Agent deposits/);
  });

  await check('a stranger cannot get past the PIN; malformed PINs are wrong PINs', async () => {
    const s = await session(stranger, ['3', '123456', '12345', '012345']);
    for (const x of s.slice(2)) assert.equal(x.Message, 'Wrong PIN.\nEnter your agent payment PIN, or 0 to go back:');
    await prisma.agentPinFailure.deleteMany({ where: { msisdn: stranger } });
  });

  await check("an agent's PIN works from any phone; a deactivated agent's PIN fails", async () => {
    const s = await session(otherPhone, ['3', agentPin]);
    assert.equal(s[2].ClientState.split('|')[0], 'AGENT_CHOOSE', s[2].Message);
    const gone = await session(otherPhone, ['3', gonePin]);
    assert.match(gone[2].Message, /^Wrong PIN\./);
    await prisma.agentPinFailure.deleteMany({ where: { msisdn: otherPhone } });
  });

  await check('lockout: four misses still prompt, a right PIN clears them, a fifth blocks even the right PIN, and it lifts after the hour', async () => {
    const phone = `0266${n}`;
    const four = await session(phone, ['3', '111111', '222222', '333333', '444444']);
    assert.equal(four[5].ClientState.split('|')[0], 'AGENT_PIN');
    const ok = await session(phone, ['3', agentPin]);
    assert.notEqual(ok[2].ClientState.split('|')[0], 'AGENT_PIN');
    assert.equal(await prisma.agentPinFailure.count({ where: { msisdn: phone } }), 0);
    const five = await session(phone, ['3', '111111', '222222', '333333', '444444', '555555']);
    assert.equal(five[6].Type, 'release');
    assert.equal(five[6].Message, 'Too many wrong PINs from this phone. Please try again in an hour.');
    const blocked = await session(phone, ['3']);
    assert.equal(blocked[1].Message, 'Too many wrong PINs from this phone. Please try again in an hour.');
    // Even the right PIN, typed in a session that was open before the fifth miss.
    const stale = await dial({ Type: 'Response', Mobile: phone, Message: agentPin, ClientState: `AGENT_PIN|${phone}|MTN` });
    assert.equal(stale.Message, 'Too many wrong PINs from this phone. Please try again in an hour.');
    await prisma.agentPinFailure.updateMany({ where: { msisdn: phone }, data: { createdAt: new Date(Date.now() - 61 * 60_000) } });
    const later = await session(phone, ['3', agentPin]);
    assert.equal(later[2].ClientState.split('|')[0], 'AGENT_CHOOSE');
  });

  await check('a PIN holder with nothing owed is told so', async () => {
    const s = await session(otherPhone, ['3', idlePin]);
    assert.equal(s[2].Type, 'release');
    assert.equal(s[2].Message, 'You have nothing to pay in right now. Any payment you have just approved is still being processed.');
  });

  // ── PIN issue and privacy ─────────────────────────────────────────────────
  await check('a new agent and a move into the role both get a unique PIN; issuing again changes nothing', async () => {
    const created = await call(createAdminUser, { user: superUser, body: { email: `${T}new@t.local`, password: 'Password-123', firstName: 'New', lastName: 'Agent', phone: `0242${n}`, roleId: agentRole.id } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(JSON.stringify(created.body).includes('paymentPin'), false);
    const newPin = (await prisma.adminUser.findUnique({ where: { id: created.body.id } })).paymentPin;
    assert.match(newPin, /^[1-9]\d{5}$/);
    assert.equal(await pins.issuePaymentPin(created.body.id), newPin);
    const office = await prisma.adminUser.create({ data: { email: `${T}mv@t.local`, password: 'x', firstName: 'Moves', lastName: 'Role', roleId: adminRole.id } });
    assert.equal(office.paymentPin, null);
    assert.equal(await pins.issuePaymentPin(office.id), null, 'office staff get no PIN');
    const moved = await call(updateAdminUser, { user: superUser, params: { id: office.id }, body: { roleId: agentRole.id } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const movedPin = (await prisma.adminUser.findUnique({ where: { id: office.id } })).paymentPin;
    assert.match(movedPin, /^[1-9]\d{5}$/);
    const all = await prisma.adminUser.findMany({ where: { paymentPin: { not: null } }, select: { paymentPin: true } });
    assert.equal(new Set(all.map((u: any) => u.paymentPin)).size, all.length, 'PINs are unique');
  });

  await check('the staff list never contains a PIN; only its owner can read it', async () => {
    const list = await call(getAllAdminUsers, { user: superUser, query: { limit: '200' } });
    const text = JSON.stringify(list.body);
    assert.equal(text.includes(agentPin), false);
    assert.equal(text.includes('paymentPin'), false);
    const mine = await call(getMyPaymentPin, { user: { id: agent.id, email: agent.email, role: 'AGENT', permissions: [] } });
    assert.equal(mine.body.pin, agentPin);
    const notAgent = await call(getMyPaymentPin, { user: superUser });
    assert.equal(notAgent.status, 403);
    const audits = await prisma.auditLog.findMany({ where: { OR: [{ newValues: { contains: agentPin } }, { oldValues: { contains: agentPin } }] } });
    assert.equal(audits.length, 0, 'no audit entry holds a PIN');
  });

  await check('staff mobile numbers are validated and unique', async () => {
    const bad = await call(updateAdminUser, { user: superUser, params: { id: noPhoneAgent.id }, body: { phone: '12345' } });
    assert.equal(bad.status, 400);
    const taken = await call(updateAdminUser, { user: superUser, params: { id: noPhoneAgent.id }, body: { phone: agentPhone } });
    assert.equal(taken.status, 400);
    assert.match(taken.body.error, /already uses/);
  });

  // ── Paying in ─────────────────────────────────────────────────────────────
  let allRef = '';
  await check('the list screen fits 160 characters, and refuses bad or too-large amounts', async () => {
    const s = await session(otherPhone, ['3', agentPin, '9', '1', 'abc', '0', '500']);
    const list = s[2];
    assert.equal(list.Message, `You owe GHS230\n1. Pay all\n2. ${s1.contract.contractNumber} Kwame M GHS100\n3. ${s2.contract.contractNumber} Abena O GHS80\n4. ${s3.contract.contractNumber} Kofi B GHS50\n0. Back`);
    assert.match(s[3].Message, /^Not on the list\./);
    assert.equal(s[4].Message, 'You owe GHS230 for all your contracts.\nEnter amount to pay:');
    assert.match(s[5].Message, /^Enter a valid amount\./);
    assert.match(s[6].Message, /^Enter a valid amount\./);
    assert.match(s[7].Message, /^That is more than you owe\./);
    for (const x of s) assert.ok(x.Message.length <= 160, `${x.Message.length}: ${x.Message}`);
  });

  await check('a long list with long names still fits 160 characters', async () => {
    const big = await prisma.adminUser.create({ data: { email: `${T}big@t.local`, password: 'x', firstName: 'Big', lastName: 'Seller', roleId: agentRole.id } });
    const bigPin = await pins.issuePaymentPin(big.id);
    for (let i = 0; i < 6; i++) await sale(big, `Bartholomewson${i} Abrokwah-Mensah`, 12345.67, 20 - i);
    const s = await session(otherPhone, ['3', bigPin, '9', '0', '9', '4']);
    const [, , first, second, back, again, picked] = s;
    for (const x of s) assert.ok(x.Message.length <= 160, `${x.Message.length}: ${x.Message}`);
    assert.equal(first.ClientState.split('|')[0], 'AGENT_CHOOSE');
    assert.match(first.Message, /^You owe GHS74074\.02 \(1\/2\)\n1\. Pay all\n2\. CON/);
    assert.equal(first.Message.split('\n').length, 7, 'three contracts, More and Back');
    assert.match(first.Message, /\n9\. More\n0\. Back$/);
    assert.match(second.Message, /\(2\/2\)/);
    assert.doesNotMatch(second.Message, /More/);
    assert.equal(back.Message, first.Message, '0 goes back a page');
    assert.match(picked.Message, /^You owe GHS12345\.67 for CON\w+ \(Bartholomews A\)\.\nEnter amount to pay:$/, `the third contract on page 2: ${picked.Message}`);
  });

  await check('pay all, part payment: the oldest sales first, and nothing is credited until the money arrives', async () => {
    prompts.length = 0;
    const s = await session(otherPhone, ['3', agentPin, '1', '150']);
    assert.equal(s[4].Message, 'Pay in GHS150 of your deposits?\n1. Confirm\n2. Cancel');
    const done = await dial({ Type: 'Response', Mobile: otherPhone, Message: '1', ClientState: s[4].ClientState });
    assert.equal(done.Type, 'release');
    const rows = await prisma.agentDepositPayment.findMany({ where: { agentId: agent.id, channel: 'USSD' }, orderBy: { transactionRef: 'asc' } });
    assert.deepEqual(rows.map((r: any) => [r.ledgerEntryId, r.amount, r.status]), [[s1.ledger.id, 100, 'PENDING'], [s2.ledger.id, 50, 'PENDING']]);
    allRef = rows[0].clientReference;
    await waitFor(() => prompts.some((p) => p.ClientReference === allRef));
    const prompt = prompts.find((p) => p.ClientReference === allRef);
    assert.equal(prompt.CustomerName, 'Efua Agent');
    assert.equal(prompt.Description, 'Agent deposit');
    assert.equal(prompt.Amount, 150);
    assert.match(prompt.PrimaryCallbackUrl, /\/agent-deposits\/hubtel\/callback\?token=/);
    const l1 = await prisma.agentDepositLedger.findUnique({ where: { id: s1.ledger.id } });
    assert.equal(l1.amountPaid, 0);
  });

  await check('in flight, the same money cannot be paid twice or recorded by hand', async () => {
    const left = await deposits.agentDepositsToPay(agent.id);
    assert.deepEqual(left.map((d: any) => [d.ledgerId, d.payable]), [[s2.ledger.id, 30], [s3.ledger.id, 50]]);
    const manual = await call(adminManualPay, { user: superUser, params: { id: s1.ledger.id }, body: { amount: 100 } });
    assert.equal(manual.status, 400);
    assert.match(manual.body.error, /waiting for a Mobile Money payment/);
    await assert.rejects(deposits.openUssdRemittance({ agentId: agent.id, amount: 100, clientReference: `${T}X`, phone: '233200000000', network: 'MTN' }), /more than you owe/);
  });

  await check('money arriving credits the ledger, writes no customer payment and leaves contract totals alone', async () => {
    texts.length = 0;
    const before = await prisma.hirePurchaseContract.findUnique({ where: { id: s1.contract.id } });
    const r = await callback(allRef);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const l1 = await prisma.agentDepositLedger.findUnique({ where: { id: s1.ledger.id } });
    const l2 = await prisma.agentDepositLedger.findUnique({ where: { id: s2.ledger.id } });
    assert.deepEqual([l1.amountPaid, l1.outstandingBalance, l1.status], [100, 0, 'PAID']);
    assert.deepEqual([l2.amountPaid, l2.outstandingBalance, l2.status], [50, 30, 'PENDING']);
    assert.equal(await prisma.paymentTransaction.count({ where: { contractId: { in: [s1.contract.id, s2.contract.id] } } }), 0);
    const after = await prisma.hirePurchaseContract.findUnique({ where: { id: s1.contract.id } });
    assert.deepEqual([after.totalPaid, after.outstandingBalance], [before.totalPaid, before.outstandingBalance]);
    assert.equal(texts.length, 1);
    assert.equal(texts[0].to, agentPhone);
    assert.equal(texts[0].message, 'Hi Efua, we have received your deposit payment of GHS 150.00. You still have GHS 80.00 to pay in. AIDOO TECH');
  });

  await check('a repeated callback credits nothing more', async () => {
    await callback(allRef);
    const l1 = await prisma.agentDepositLedger.findUnique({ where: { id: s1.ledger.id } });
    assert.equal(l1.amountPaid, 100);
  });

  await check('an unsigned callback is refused', async () => {
    const r = await call(handleAgentPaymentCallback, { body: { ResponseCode: '0000', Data: { ClientReference: allRef } } });
    assert.equal(r.status, 401);
  });

  let failedRef = '';
  await check('paying one chosen sale; a failed charge credits nothing and is payable again', async () => {
    const s = await session(otherPhone, ['3', agentPin, '3', '50', '1']);
    assert.equal(s[3].Message, `You owe GHS50 for ${s3.contract.contractNumber} (Kofi B).\nEnter amount to pay:`);
    const row = await prisma.agentDepositPayment.findFirst({ where: { ledgerEntryId: s3.ledger.id, channel: 'USSD' } });
    failedRef = row.clientReference;
    await callback(failedRef, false);
    assert.equal((await prisma.agentDepositPayment.findFirst({ where: { clientReference: failedRef } })).status, 'FAILED');
    assert.equal((await prisma.agentDepositLedger.findUnique({ where: { id: s3.ledger.id } })).amountPaid, 0);
    const left = await deposits.agentDepositsToPay(agent.id);
    assert.ok(left.some((d: any) => d.ledgerId === s3.ledger.id && d.payable === 50));
  });

  await check('a late success after a failure lands, once', async () => {
    await callback(failedRef);
    await callback(failedRef);
    const l3 = await prisma.agentDepositLedger.findUnique({ where: { id: s3.ledger.id } });
    assert.deepEqual([l3.amountPaid, l3.status], [50, 'PAID']);
  });

  await check('one contract owed is still listed to choose; the receipt goes to the paying phone when none is on record', async () => {
    texts.length = 0;
    const payer = `0501${n}`;
    const s = await session(payer, ['3', noPhonePin, '2', '40', '1']);
    assert.equal(s[2].Message, `You owe GHS120\n1. Pay all\n2. ${solo.contract.contractNumber} Akosua D GHS120\n0. Back`);
    assert.equal(s[3].Message, `You owe GHS120 for ${solo.contract.contractNumber} (Akosua D).\nEnter amount to pay:`);
    const row = await prisma.agentDepositPayment.findFirst({ where: { ledgerEntryId: solo.ledger.id } });
    await callback(row.clientReference);
    assert.equal(texts[0].to, payer);
    assert.match(texts[0].message, /You still have GHS 80\.00 to pay in\./);
  });

  await check('the sweep settles a charge Hubtel never called back about, and leaves an unknown one waiting', async () => {
    const s = await session(otherPhone, ['3', agentPin, '2', '30', '1']);
    assert.equal(s[3].Message, `You owe GHS30 for ${s2.contract.contractNumber} (Abena O).\nEnter amount to pay:`);
    const pending = await prisma.agentDepositPayment.findMany({ where: { agentId: agent.id, status: 'PENDING' } });
    assert.equal(pending.length, 1);
    const ref = pending[0].clientReference;
    await prisma.agentDepositPayment.updateMany({ where: { clientReference: ref }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    let r = await deposits.sweepStuckAgentDeposits();
    assert.equal(r.settled, 0);
    assert.equal((await prisma.agentDepositPayment.findFirst({ where: { clientReference: ref } })).status, 'PENDING');
    hubtelStatus.set(ref, 'Paid');
    r = await deposits.sweepStuckAgentDeposits();
    assert.equal(r.settled, 1);
    const l2 = await prisma.agentDepositLedger.findUnique({ where: { id: s2.ledger.id } });
    assert.deepEqual([l2.amountPaid, l2.status], [80, 'PAID']);
    r = await deposits.sweepStuckAgentDeposits();
    assert.equal(r.checked, 0, 'a settled charge is left alone');
  });

  await check('a forged session cannot skip the PIN', async () => {
    const forged = [
      `AGENT_CHOOSE|${stranger}|MTN|${agent.id}|0`,
      `AGENT_CHOOSE|${stranger}|MTN|${agent.id}~0123456789abcdef|0`,
      // A real tag, but issued to another phone.
      `AGENT_CHOOSE|${stranger}|MTN|${agent.id}~${pins.agentSessionTag(agent.id, otherPhone)}|0`,
      `AGENT_CONFIRM|${stranger}|MTN|${agent.id}|ALL|50`,
    ];
    for (const state of forged) {
      const r = await dial({ Type: 'Response', Mobile: stranger, Message: '1', ClientState: state });
      assert.equal(r.Type, 'release', state);
      assert.equal(r.Message, 'Session error. Please dial again.');
    }
  });

  await check('a charge never confirmed for 48 hours stops blocking the balance, and a late success still lands', async () => {
    const late = await sale(agent, 'Yaa Asante', 70, 1);
    const ref = `${T}LATE`;
    await prisma.agentDepositPayment.create({ data: { ledgerEntryId: late.ledger.id, agentId: agent.id, transactionRef: `${ref}-1`, clientReference: ref, channel: 'USSD',
      amount: 70, phoneNumber: '233200000000', network: 'MTN', status: 'PENDING', createdAt: new Date(Date.now() - 49 * 3600_000) } });
    assert.equal(await deposits.payableOnLedger(late.ledger.id), 0, 'blocked while waiting');
    await deposits.sweepStuckAgentDeposits();
    assert.equal((await prisma.agentDepositPayment.findFirst({ where: { clientReference: ref } })).status, 'FAILED');
    assert.equal(await deposits.payableOnLedger(late.ledger.id), 70, 'payable again');
    await callback(ref);
    const l = await prisma.agentDepositLedger.findUnique({ where: { id: late.ledger.id } });
    assert.deepEqual([l.amountPaid, l.status], [70, 'PAID']);
  });

  await check('a charge stuck for over 7 days is marked not paid without asking Hubtel or crediting anything', async () => {
    const old = await sale(agent, 'Ama Old', 260, 30);
    const ref = `${T}OLD`;
    await prisma.agentDepositPayment.create({ data: { ledgerEntryId: old.ledger.id, agentId: agent.id, transactionRef: ref, amount: 260, phoneNumber: '233200000000', network: 'MTN', status: 'PENDING', createdAt: new Date(Date.now() - 9 * 86400_000) } });
    hubtelStatus.set(ref, 'Paid'); // even if Hubtel would say paid, it is not asked
    assert.equal(await deposits.payableOnLedger(old.ledger.id), 0);
    await deposits.sweepStuckAgentDeposits();
    assert.equal((await prisma.agentDepositPayment.findUnique({ where: { transactionRef: ref } })).status, 'FAILED');
    const l = await prisma.agentDepositLedger.findUnique({ where: { id: old.ledger.id } });
    assert.deepEqual([l.amountPaid, l.status], [0, 'PENDING']);
    assert.equal(await deposits.payableOnLedger(old.ledger.id), 260, 'can be recorded or paid again');
  });

  await check('the agent portal payment still works through the same callback', async () => {
    const extra = await sale(agent, 'Esi Mensah', 60, 1);
    const pay = await prisma.agentDepositPayment.create({ data: { ledgerEntryId: extra.ledger.id, agentId: agent.id, transactionRef: `${T}WEB`, amount: 60, phoneNumber: '233241234567', network: 'MTN', status: 'PENDING' } });
    await callback(pay.transactionRef);
    const l = await prisma.agentDepositLedger.findUnique({ where: { id: extra.ledger.id } });
    assert.deepEqual([l.amountPaid, l.status], [60, 'PAID']);
  });

  server.close();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
