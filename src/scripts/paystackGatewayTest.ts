/**
 * Paystack as a second gateway — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/paystackGatewayTest.ts
 *
 * Paystack and Hubtel are local mocks; Knox and PayTrigger run dry; no SMS or
 * email leaves the machine. Synthetic data only.
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
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.stack?.split('\n').slice(0, 4).join('\n      ') || err}`); }
}
const DAY = 86400_000;
const day = (o: number) => new Date(Date.now() + o * DAY);
const KEY = 'sk_test_mockkey';

async function main() {
  // ── Mock Hubtel: records every prompt it is asked to send ─────────────────
  const hubtelPrompts: any[] = [];
  const hubtel = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'POST') {
        hubtelPrompts.push(JSON.parse(body || '{}'));
        res.end(JSON.stringify({ ResponseCode: '0001', Message: 'Transaction pending', Data: { TransactionId: `hub-${hubtelPrompts.length}` } }));
      } else res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((r) => hubtel.listen(0, '127.0.0.1', r));
  const hubtelBase = `http://127.0.0.1:${(hubtel.address() as AddressInfo).port}`;

  // ── Mock Paystack ─────────────────────────────────────────────────────────
  const charges = new Map<string, any>();          // reference → charge request
  const outcome = new Map<string, any>();          // reference → what verify answers
  const calls: string[] = [];
  const paystack = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, data: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      calls.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { status: false, message: 'Invalid key' });
      const u = new URL(req.url || '/', 'http://x');
      if (req.method === 'GET' && u.pathname === '/bank') {
        return send(200, { status: true, data: [{ name: 'MTN', code: 'MTN' }, { name: 'Telecel Ghana', code: 'VOD' }, { name: 'AirtelTigo', code: 'ATL' }] });
      }
      if (req.method === 'POST' && u.pathname === '/charge') {
        const b = JSON.parse(body || '{}');
        if (b.mobile_money?.phone === '0200000000') return send(400, { status: false, message: 'Invalid phone number' });
        charges.set(b.reference, b);
        const status = b.mobile_money?.provider === 'vod' ? 'send_otp' : 'pay_offline';
        return send(200, { status: true, data: { reference: b.reference, status, id: 1000 + charges.size, display_text: status === 'send_otp' ? 'Enter the OTP sent to your phone' : 'Please complete authorization on your phone' } });
      }
      if (req.method === 'POST' && u.pathname === '/charge/submit_otp') {
        const b = JSON.parse(body || '{}');
        if (b.otp !== '123456') return send(400, { status: false, message: 'Invalid OTP', data: { status: 'send_otp' } });
        return send(200, { status: true, data: { reference: b.reference, status: 'pay_offline', display_text: 'Approve the prompt on your phone' } });
      }
      if (req.method === 'POST' && u.pathname === '/refund') {
        const b = JSON.parse(body || '{}');
        if (!charges.has(b.transaction)) return send(400, { status: false, message: 'Transaction not found' });
        return send(200, { status: true, message: 'Refund has been queued for processing', data: { status: 'pending', transaction: { reference: b.transaction } } });
      }
      const m = u.pathname.match(/^\/transaction\/verify\/(.+)$/);
      if (req.method === 'GET' && m) {
        const ref = decodeURIComponent(m[1]);
        const charge = charges.get(ref);
        if (!charge) return send(400, { status: false, message: 'Transaction reference not found' });
        const o = outcome.get(ref) ?? { status: 'ongoing' };
        const amount = o.amount ?? charge.amount;
        return send(200, { status: true, data: {
          reference: ref, id: 5000, amount, currency: o.currency ?? 'GHS', status: o.status, gateway_response: o.status,
          fees: o.fees ?? Math.round(Number(charge.amount) * 0.0195),
          ...(o.requested_amount !== undefined ? { requested_amount: o.requested_amount } : {}),
        } });
      }
      send(404, { status: false, message: 'Not found' });
    });
  });
  await new Promise<void>((r) => paystack.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    PAYSTACK_SECRET_KEY: KEY,
    PAYSTACK_BASE_URL: `http://127.0.0.1:${(paystack.address() as AddressInfo).port}`,
    HUBTEL_RECEIVE_MONEY_URL: `${hubtelBase}/receive`,
    HUBTEL_TRANSACTION_STATUS_URL: `${hubtelBase}/status`,
    HUBTEL_POS_SALES_ID: 'test', HUBTEL_API_KEY: 'test', HUBTEL_API_SECRET: 'test',
    HUBTEL_CALLBACK_URL: 'https://backend.test/api/payments/hubtel/callback',
    USSD_PROMPT_DELAY_MS: '20', ENABLE_SMS_NOTIFICATIONS: 'false', ENABLE_EMAIL_NOTIFICATIONS: 'false', NALO_API_KEY: '',
    KNOX_GUARD_DRY_RUN: 'true', PAYTRIGGER_DRY_RUN: 'true',
  });
  const notifications = require('../services/notificationService');
  notifications.sendSMS = async () => true;

  const { default: prisma } = require('../config/database');
  const paymentController = require('../controllers/paymentController');
  const { initiateHubtelPayment, checkHubtelStatus, submitCustomerPaymentOtp, handleUssdSession, reconcileHubtelPayments, cancelCustomerMomoPayment, reverseGatewayPayment, recordManualPayment } = paymentController;
  const { processHubtelCallback } = require('../services/hubtelService');
  const { getIncomeReport } = require('../controllers/reportController');
  const gw = require('../controllers/paymentGatewayController');
  const { payDeposit, submitAgentDepositOtp, getAgentDepositPaymentStatus, cancelAgentDepositPayment } = require('../controllers/agentDepositController');
  const { customerRequestTemporaryUnlock } = require('../controllers/paidUnlockController');
  const { sweepPaystackCustomerPayments } = require('../services/gateways/settle');
  const { sweepStuckAgentDeposits } = require('../services/agentDepositUssdService');
  const { retryPayment } = require('../services/paymentRetryService');
  const pins = require('../services/agentPinService');
  const paid = require('../services/paidUnlockService');

  const call = (fn: any, req: any): Promise<{ status: number; body: any }> => new Promise((resolve) => {
    let status = 200;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => resolve({ status, body: b }) };
    fn({ ip: '127.0.0.1', headers: {}, params: {}, body: {}, query: {}, protocol: 'https', get: () => 'backend.test', ...req }, res);
  });
  const dial = (body: any): Promise<any> => new Promise((resolve) => {
    const res: any = { status: () => res, json: (b: any) => resolve(b) };
    handleUssdSession({ body: { SessionId: `S${Date.now()}${Math.random()}`, Operator: 'mtn', ClientState: '', ...body } }, res);
  });
  async function session(mobile: string, answers: string[]) {
    const screens: any[] = [await dial({ Type: 'Initiation', Mobile: mobile, Message: '*713#' })];
    for (const a of answers) {
      const last = screens[screens.length - 1];
      if (last.Type === 'release') break;
      screens.push(await dial({ Type: 'Response', Mobile: mobile, Message: a, ClientState: last.ClientState }));
    }
    return screens;
  }
  const waitFor = async (fn: () => Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timed out waiting');
  };
  const sign = (raw: string, key = KEY) => crypto.createHmac('sha512', key).update(raw).digest('hex');
  const webhook = (ref: string, opts: { key?: string; event?: string } = {}) => {
    const raw = JSON.stringify({ event: opts.event ?? 'charge.success', data: { reference: ref, status: 'success' } });
    return call(gw.handlePaystackWebhook, { rawBody: Buffer.from(raw), body: JSON.parse(raw), headers: { 'x-paystack-signature': sign(raw, opts.key) } });
  };
  const paymentOf = (ref: string) => prisma.paymentTransaction.findUniqueOrThrow({ where: { transactionRef: ref } });
  const contractOf = (id: string) => prisma.hirePurchaseContract.findUniqueOrThrow({ where: { id } });

  // ── Data ──────────────────────────────────────────────────────────────────
  const T = `ps${Date.now()}`;
  const n = String(Date.now()).slice(-6);
  const role = (name: string) => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const agentRole = await role('AGENT');
  const adminRole = await role('ADMIN');
  const agent = await prisma.adminUser.create({ data: { email: `${T}a@t.local`, password: 'x', firstName: 'Ama', lastName: 'Agent', roleId: agentRole.id, phone: `024${n}9`.slice(0, 10) } });
  const boss = await prisma.adminUser.create({ data: { email: `${T}b@t.local`, password: 'x', firstName: 'Kofi', lastName: 'Boss', roleId: adminRole.id } });
  const superAdmin = { id: boss.id, email: boss.email, role: 'SUPER_ADMIN', permissions: [] };
  const plainAdmin = { id: boss.id, email: boss.email, role: 'ADMIN', permissions: [] };
  const agentUser = { id: agent.id, email: agent.email, role: 'AGENT', permissions: ['PAY_AGENT_DEPOSIT'] };

  async function makeContract(tag: string, opts: { dues: number[]; device?: boolean; ledgerOwed?: number }) {
    const phone = `05${tag}${n}`.slice(0, 10);
    const customer = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}${tag}`, firstName: `CUST${tag}`, lastName: 'TEST', phone, isActivated: true, createdById: agent.id } });
    const total = opts.dues.length * 300;
    const contract = await prisma.hirePurchaseContract.create({ data: {
      contractNumber: `CON${tag}${n}`, customerId_uuid: customer.id_uuid, totalPrice: total + 300, depositAmount: 300, financeAmount: total, installmentAmount: 300,
      paymentFrequency: 'WEEKLY', totalInstallments: opts.dues.length, startDate: day(-30), endDate: day(60), status: 'ACTIVE',
      outstandingBalance: total, totalPaid: 300, createdById: agent.id, approvedAt: day(-31), gracePeriodDays: 0 } });
    for (const [i, o] of opts.dues.entries()) {
      await prisma.installmentSchedule.create({ data: { contractId: contract.id, installmentNo: i + 1, amount: 300, dueDate: day(o), status: o < 0 ? 'OVERDUE' : 'PENDING' } });
    }
    const owed = opts.ledgerOwed ?? 0;
    const ledger = await prisma.agentDepositLedger.create({ data: { contractId: contract.id, agentId: agent.id, contractNumber: contract.contractNumber, customerName: `CUST${tag} TEST`,
      depositAmount: 300, commissionAmount: 50, amountDueCompany: 250, amountPaid: 250 - owed, outstandingBalance: owed, status: owed > 0 ? 'PENDING' : 'PAID' } });
    if (opts.device) {
      await prisma.managedDevice.create({ data: { contractId: contract.id, customerId_uuid: customer.id_uuid, deviceUid: `SN${tag}${n}`, approveId: `AP${tag}${n}`,
        enrollmentStatus: 'ACTIVE', desiredState: 'LOCKED', actualState: 'LOCKED', isActive: true } });
    }
    return { customer, contract, ledger, phone };
  }
  const P = await makeContract('61', { dues: [-3, 7, 14] });            // plain customer payments
  const Q = await makeContract('62', { dues: [-3, 7, 14] });            // short code
  const U = await makeContract('63', { dues: [-10, -8, 4], device: true }); // locked phone, paid unlock
  const W = await makeContract('64', { dues: [5, 12], ledgerOwed: 120 });   // agent deposit, web
  const V = await makeContract('65', { dues: [5, 12], ledgerOwed: 80 });    // agent deposit, short code
  const R = await makeContract('66', { dues: [-3, 7, 14] });            // reversals
  const X = await makeContract('67', { dues: [5, 12], ledgerOwed: 60 });    // agent deposit, cancel
  const customer = (c: any) => ({ userType: 'customer', user: { id: c.customer.id_uuid } });

  const gwBefore = await prisma.paymentGatewaySettings.findFirst();
  let knox = await prisma.knoxGuardSettings.findFirst();
  if (!knox) knox = await prisma.knoxGuardSettings.create({ data: { id: 'singleton' } });
  const knoxBefore = { ...knox };

  console.log('\nPaystack gateway');

  // ── Switch ────────────────────────────────────────────────────────────────
  await check('everything starts on Hubtel: an app payment goes to Hubtel', async () => {
    await prisma.paymentGatewaySettings.deleteMany({});
    const before = hubtelPrompts.length;
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 50, phoneNumber: P.phone, network: 'MTN', otpCapable: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.gateway, 'HUBTEL');
    assert.equal(hubtelPrompts.length, before + 1);
    const p = await paymentOf(r.body.transactionRef);
    assert.equal(p.gateway, 'HUBTEL');
    assert.equal(p.paymentMethod, 'HUBTEL_MOMO');
  });

  await check('only a super admin can see or change the switch', async () => {
    const get = await call(gw.getPaymentGatewaySettings, { userType: 'admin', user: plainAdmin });
    assert.equal(get.status, 403);
    const put = await call(gw.putPaymentGatewaySettings, { userType: 'admin', user: plainAdmin, body: { customerGateway: 'PAYSTACK' } });
    assert.equal(put.status, 403);
  });

  await check('Paystack cannot be chosen without a key; bad values are refused', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    const r = await call(gw.putPaymentGatewaySettings, { userType: 'admin', user: superAdmin, body: { customerGateway: 'PAYSTACK' } });
    process.env.PAYSTACK_SECRET_KEY = KEY;
    assert.equal(r.status, 400);
    assert.match(r.body.error, /PAYSTACK_SECRET_KEY/);
    const bad = await call(gw.putPaymentGatewaySettings, { userType: 'admin', user: superAdmin, body: { customerGateway: 'STRIPE' } });
    assert.equal(bad.status, 400);
  });

  await check('settings page: key mode, webhook URL, connection check, switch saved and audited', async () => {
    const r = await call(gw.putPaymentGatewaySettings, { userType: 'admin', user: superAdmin, body: { customerGateway: 'PAYSTACK', agentDepositGateway: 'PAYSTACK' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.customerGateway, 'PAYSTACK');
    assert.equal(r.body.agentDepositGateway, 'PAYSTACK');
    assert.equal(r.body.updatedBy, 'Kofi Boss');
    assert.equal(r.body.paystack.mode, 'TEST');
    assert.equal(r.body.paystack.configured, true);
    assert.equal(r.body.paystack.webhookUrl, 'https://backend.test/api/payments/paystack/webhook');
    assert.ok(!JSON.stringify(r.body).includes(KEY), 'the key is never returned');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'SET_PAYMENT_GATEWAY', userId: boss.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit);
    const conn = await call(gw.checkPaymentGateway, { userType: 'admin', user: superAdmin });
    assert.equal(conn.body.ok, true, JSON.stringify(conn.body));
    assert.deepEqual(conn.body.providers.sort(), ['AIRTELTIGO', 'MTN', 'VODAFONE']);
  });

  // ── Customer payments ─────────────────────────────────────────────────────
  let ref1 = '';
  await check('app payment on Paystack: pesewas, local phone, the provider code from Paystack\'s list', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 120.5, phoneNumber: `233${P.phone.slice(1)}`, network: 'MTN', otpCapable: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.gateway, 'PAYSTACK');
    assert.equal(r.body.otpRequired, false);
    ref1 = r.body.transactionRef;
    const sent = charges.get(ref1);
    assert.equal(sent.amount, 12050);
    assert.equal(sent.currency, 'GHS');
    assert.equal(sent.mobile_money.phone, P.phone);
    assert.equal(sent.mobile_money.provider, 'mtn', 'sent in lower case, as the charge takes it');
    assert.match(sent.email, /^pay\+[A-Za-z0-9]+@aidootechsolutions\.com$/);
    const p = await paymentOf(ref1);
    assert.equal(p.gateway, 'PAYSTACK');
    assert.equal(p.paymentMethod, 'PAYSTACK_MOMO');
    assert.equal(p.isAutoRetryEnabled, false);
    assert.equal(p.status, 'PENDING');
    assert.match(String(p.externalRef), /^10\d\d$/, 'Paystack\'s charge id is kept');
  });

  await check('a webhook with a bad signature is refused and changes nothing', async () => {
    outcome.set(ref1, { status: 'success' });
    const r = await webhook(ref1, { key: 'sk_test_wrong' });
    assert.equal(r.status, 401);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((await paymentOf(ref1)).status, 'PENDING');
  });

  await check('a webhook, a status poll and the sweep together credit once', async () => {
    await prisma.paymentTransaction.update({ where: { transactionRef: ref1 }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    const before = await contractOf(P.contract.id);
    await Promise.all([
      webhook(ref1),
      call(checkHubtelStatus, { ...customer(P), params: { transactionRef: ref1 } }),
      sweepPaystackCustomerPayments(),
      webhook(ref1),
    ]);
    await waitFor(async () => (await contractOf(P.contract.id)).totalPaid > before.totalPaid);
    // Long enough for any second posting to have landed, if one were going to.
    await new Promise((res) => setTimeout(res, 800));
    const after = await contractOf(P.contract.id);
    assert.equal(Math.round((after.totalPaid - before.totalPaid) * 100), 12050);
    const inst = await prisma.installmentSchedule.findFirst({ where: { contractId: P.contract.id, installmentNo: 1 } });
    assert.equal(inst.paidAmount, 120.5);
    const settings = await prisma.paymentGatewaySettings.findFirst();
    assert.ok(settings.lastPaystackEventAt, 'the webhook is recorded as seen');
  });

  await check('status poll answers SUCCESS once settled; metadata keeps the gateway', async () => {
    const r = await call(checkHubtelStatus, { ...customer(P), params: { transactionRef: ref1 } });
    assert.equal(r.body.status, 'SUCCESS');
    assert.equal(r.body.gateway, 'PAYSTACK');
    const meta = JSON.parse((await paymentOf(ref1)).metadata);
    assert.equal(meta.gateway, 'PAYSTACK');
    assert.ok(meta.settledAt);
  });

  await check('paid but for a different amount: never credited, flagged for staff', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 40, phoneNumber: P.phone, network: 'MTN', otpCapable: true } });
    const ref = r.body.transactionRef;
    outcome.set(ref, { status: 'success', amount: 400 });
    const before = await contractOf(P.contract.id);
    await webhook(ref);
    await waitFor(async () => (await paymentOf(ref)).status === 'FAILED');
    assert.equal((await contractOf(P.contract.id)).totalPaid, before.totalPaid);
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'PAYSTACK_AMOUNT_MISMATCH', entityId: ref } }));
  });

  await check('failed, then a late success: lands once', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 30, phoneNumber: P.phone, network: 'MTN', otpCapable: true } });
    const ref = r.body.transactionRef;
    outcome.set(ref, { status: 'failed' });
    await sweepPaystackCustomerPayments(new Date(Date.now() + 5 * 60_000));
    assert.equal((await paymentOf(ref)).status, 'FAILED');
    const before = await contractOf(P.contract.id);
    outcome.set(ref, { status: 'success' });
    await webhook(ref);
    await waitFor(async () => (await contractOf(P.contract.id)).totalPaid > before.totalPaid);
    await webhook(ref);
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(Math.round(((await contractOf(P.contract.id)).totalPaid - before.totalPaid) * 100), 3000);
  });

  await check('a refused prompt fails at once with Paystack\'s reason', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 10, phoneNumber: '0200000000', network: 'MTN', otpCapable: true } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Invalid phone number/);
    assert.equal((await paymentOf(r.body.transactionRef)).status, 'FAILED');
  });

  await check('a webhook for a reference we do not have is recorded', async () => {
    charges.set('UNKNOWN-REF-1', { amount: 100 });
    outcome.set('UNKNOWN-REF-1', { status: 'success' });
    const r = await webhook('UNKNOWN-REF-1');
    assert.equal(r.status, 200);
    await waitFor(async () => !!(await prisma.auditLog.findFirst({ where: { action: 'PAYSTACK_UNMATCHED', entityId: 'UNKNOWN-REF-1' } })));
  });

  // ── Telecel ───────────────────────────────────────────────────────────────
  await check('Telecel on the new app: SMS code step, then the prompt, then credited', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 25, phoneNumber: P.phone, network: 'TELECEL', otpCapable: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.gateway, 'PAYSTACK');
    assert.equal(r.body.otpRequired, true);
    const ref = r.body.transactionRef;
    assert.equal(charges.get(ref).mobile_money.provider, 'vod');
    const waiting = await call(checkHubtelStatus, { ...customer(P), params: { transactionRef: ref } });
    assert.equal(waiting.body.otpRequired, true);
    const wrong = await call(submitCustomerPaymentOtp, { ...customer(P), params: { transactionRef: ref }, body: { otp: '999999' } });
    assert.equal(wrong.body.status, 'PENDING');
    assert.equal(wrong.body.otpRequired, true);
    assert.match(wrong.body.message, /Invalid OTP/);
    const other = await call(submitCustomerPaymentOtp, { ...customer(Q), params: { transactionRef: ref }, body: { otp: '123456' } });
    assert.equal(other.status, 404, 'another customer cannot use it');
    const ok = await call(submitCustomerPaymentOtp, { ...customer(P), params: { transactionRef: ref }, body: { otp: '123456' } });
    assert.equal(ok.body.status, 'PENDING');
    assert.equal(ok.body.otpRequired, false);
    outcome.set(ref, { status: 'success' });
    await webhook(ref);
    await waitFor(async () => (await paymentOf(ref)).status === 'SUCCESS');
  });

  await check('an app installed before Paystack (no code box) pays through Hubtel on every network', async () => {
    const before = hubtelPrompts.length;
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 20, phoneNumber: P.phone, network: 'VODAFONE' } });
    assert.equal(r.body.gateway, 'HUBTEL');
    assert.equal(hubtelPrompts.length, before + 1);
    const mtn = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 20, phoneNumber: P.phone, network: 'MTN' } });
    assert.equal(mtn.body.gateway, 'HUBTEL', 'live Paystack can ask MTN payers for a code too');
  });

  // ── Switching mid-flight ──────────────────────────────────────────────────
  await check('switching back to Hubtel leaves a waiting Paystack payment on Paystack', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 15, phoneNumber: P.phone, network: 'MTN', otpCapable: true } });
    const ref = r.body.transactionRef;
    await call(gw.putPaymentGatewaySettings, { userType: 'admin', user: superAdmin, body: { customerGateway: 'HUBTEL' } });
    const next = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 15, phoneNumber: P.phone, network: 'MTN', otpCapable: true } });
    assert.equal(next.body.gateway, 'HUBTEL');
    outcome.set(ref, { status: 'success' });
    await webhook(ref);
    await waitFor(async () => (await paymentOf(ref)).status === 'SUCCESS');
    await call(gw.putPaymentGatewaySettings, { userType: 'admin', user: superAdmin, body: { customerGateway: 'PAYSTACK' } });
  });

  await check('admin reconcile checks Paystack payments on Paystack (dry run)', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(P), body: { contractId: P.contract.id, amount: 12, phoneNumber: P.phone, network: 'MTN', otpCapable: true } });
    const ref = r.body.transactionRef;
    await prisma.paymentTransaction.update({ where: { transactionRef: ref }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    outcome.set(ref, { status: 'success' });
    const rec = await call(reconcileHubtelPayments, { userType: 'admin', user: superAdmin, query: { dryRun: 'true' } });
    const row = (rec.body.results || []).find((x: any) => x.transactionRef === ref);
    assert.ok(row, JSON.stringify(rec.body).slice(0, 300));
    assert.equal(row.action, 'dry_run');
    assert.match(row.hubtelStatus, /^PAYSTACK SUCCESS/);
    assert.equal((await paymentOf(ref)).status, 'PENDING', 'dry run changes nothing');
  });

  await check('a failed Paystack payment is never retried through Hubtel', async () => {
    const failed = await prisma.paymentTransaction.findFirst({ where: { contractId: P.contract.id, gateway: 'PAYSTACK', status: 'FAILED' } });
    const before = hubtelPrompts.length;
    const r = await retryPayment(failed.id);
    assert.equal(r.success, false);
    assert.match(r.message, /not retried/);
    assert.equal(hubtelPrompts.length, before);
  });

  // ── Short code: always Hubtel ─────────────────────────────────────────────
  await check('short code pay for self stays on Hubtel with both switches on Paystack', async () => {
    const before = hubtelPrompts.length;
    const s = await session(Q.phone, ['1', '1', '50']);
    assert.equal(s[3].Type, 'release', JSON.stringify(s.map((x) => x.Message)));
    await waitFor(async () => hubtelPrompts.length === before + 1);
    const p = await prisma.paymentTransaction.findFirstOrThrow({ where: { contractId: Q.contract.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(p.gateway, 'HUBTEL');
    assert.ok(!charges.has(p.transactionRef));
  });

  await check('short code agent deposit stays on Hubtel', async () => {
    const pin = await pins.issuePaymentPin(agent.id);
    const before = hubtelPrompts.length;
    const s = await session('0277000111', ['3', pin, '1', '80']);
    const done = await dial({ Type: 'Response', Mobile: '0277000111', Message: '1', ClientState: s[s.length - 1].ClientState });
    assert.equal(done.Type, 'release', done.Message);
    await waitFor(async () => hubtelPrompts.length === before + 1);
    const rows = await prisma.agentDepositPayment.findMany({ where: { agentId: agent.id, channel: 'USSD' } });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r: any) => r.gateway === 'HUBTEL'));
    await prisma.agentDepositPayment.updateMany({ where: { agentId: agent.id, channel: 'USSD' }, data: { status: 'FAILED' } });
  });

  // ── Agent deposits on the web ─────────────────────────────────────────────
  await check('web agent deposit through Paystack: the ledger is credited once', async () => {
    const r = await call(payDeposit, { userType: 'admin', user: agentUser, params: { id: W.ledger.id }, body: { amount: 120, phoneNumber: '0244000222', network: 'MTN', otpCapable: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.gateway, 'PAYSTACK');
    const ref = r.body.transactionRef;
    assert.equal(charges.get(ref).amount, 12000);
    const row = await prisma.agentDepositPayment.findUniqueOrThrow({ where: { transactionRef: ref } });
    assert.equal(row.gateway, 'PAYSTACK');
    outcome.set(ref, { status: 'success' });
    await Promise.all([webhook(ref), webhook(ref)]);
    await waitFor(async () => (await prisma.agentDepositPayment.findUniqueOrThrow({ where: { transactionRef: ref } })).status === 'SUCCESS');
    await new Promise((res) => setTimeout(res, 300));
    const ledger = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { id: W.ledger.id } });
    assert.equal(ledger.amountPaid, 250);
    assert.equal(ledger.outstandingBalance, 0);
    assert.equal(ledger.status, 'PAID');
    const st = await call(getAgentDepositPaymentStatus, { userType: 'admin', user: agentUser, params: { ref } });
    assert.equal(st.body.status, 'SUCCESS');
  });

  await check('web agent deposit, Telecel: code step, and the sweep settles it', async () => {
    const r = await call(payDeposit, { userType: 'admin', user: agentUser, params: { id: V.ledger.id }, body: { amount: 30, phoneNumber: '0204000333', network: 'TELECEL', otpCapable: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.otpRequired, true);
    const ref = r.body.transactionRef;
    const ok = await call(submitAgentDepositOtp, { userType: 'admin', user: agentUser, params: { ref }, body: { otp: '123456' } });
    assert.equal(ok.body.status, 'PENDING');
    outcome.set(ref, { status: 'success' });
    await prisma.agentDepositPayment.update({ where: { transactionRef: ref }, data: { createdAt: new Date(Date.now() - 15 * 60_000) } });
    await sweepStuckAgentDeposits();
    const row = await prisma.agentDepositPayment.findUniqueOrThrow({ where: { transactionRef: ref } });
    assert.equal(row.status, 'SUCCESS');
    const ledger = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { id: V.ledger.id } });
    assert.equal(ledger.outstandingBalance, 50);
  });

  // ── Paid unlock from the app ──────────────────────────────────────────────
  await check('app paid unlock through Paystack opens the window once paid', async () => {
    await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { lockAfterOverdueDays: 5, temporaryUnlockEnabled: true, temporaryUnlockMaxUses: 2, temporaryUnlockTiers: paid.DEFAULT_UNLOCK_TIERS } });
    const offer = await paid.getTemporaryUnlockOffer(U.contract.id);
    assert.ok(offer?.available, JSON.stringify(offer));
    const tier = offer.options[0];
    const r = await call(customerRequestTemporaryUnlock, { ...customer(U), params: { id: U.contract.id }, body: { percent: tier.percent, network: 'MTN', phoneNumber: U.phone, expectedAmount: tier.total, otpCapable: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.gateway, 'PAYSTACK');
    const ref = r.body.transactionRef;
    outcome.set(ref, { status: 'success' });
    await webhook(ref);
    await waitFor(async () => (await prisma.paidTemporaryUnlock.findUnique({ where: { clientReference: ref } }))?.status === 'APPLIED');
    const unlock = await prisma.paidTemporaryUnlock.findUnique({ where: { clientReference: ref } });
    assert.ok(unlock.expiresAt > new Date());
  });

  // ── Fixes from the gap review ─────────────────────────────────────────────
  await check('fee passed to the payer: credited on what we asked for; the fee is kept', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(R), body: { contractId: R.contract.id, amount: 100, phoneNumber: R.phone, network: 'MTN', otpCapable: true } });
    const ref = r.body.transactionRef;
    outcome.set(ref, { status: 'success', amount: 10195, requested_amount: 10000, fees: 195 });
    const before = await contractOf(R.contract.id);
    await webhook(ref);
    // The webhook answers Paystack first and posts after: wait for the posting itself.
    await waitFor(async () => (await contractOf(R.contract.id)).totalPaid > before.totalPaid);
    const p = await paymentOf(ref);
    assert.equal(p.status, 'SUCCESS');
    assert.equal(p.gatewayFee, 1.95);
    assert.equal(Math.round(((await contractOf(R.contract.id)).totalPaid - before.totalPaid) * 100), 10000, 'credited what we asked for, not the fee');
  });

  await check('less taken than asked (requested matches, amount short): not credited', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(R), body: { contractId: R.contract.id, amount: 20, phoneNumber: R.phone, network: 'MTN', otpCapable: true } });
    const ref = r.body.transactionRef;
    outcome.set(ref, { status: 'success', amount: 1500, requested_amount: 2000 });
    await webhook(ref);
    await waitFor(async () => (await paymentOf(ref)).status === 'FAILED');
  });

  await check('Paystack\'s own instructions reach the payer', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(R), body: { contractId: R.contract.id, amount: 5, phoneNumber: R.phone, network: 'MTN', otpCapable: true } });
    assert.equal(r.body.message, 'Please complete authorization on your phone');
    outcome.set(r.body.transactionRef, { status: 'failed' });
    await sweepPaystackCustomerPayments(new Date(Date.now() + 5 * 60_000));
  });

  await check('cancel: unpaid becomes not paid; already paid is credited instead', async () => {
    const a = await call(initiateHubtelPayment, { ...customer(R), body: { contractId: R.contract.id, amount: 6, phoneNumber: R.phone, network: 'TELECEL', otpCapable: true } });
    const c1 = await call(cancelCustomerMomoPayment, { ...customer(R), params: { transactionRef: a.body.transactionRef } });
    assert.equal(c1.body.status, 'FAILED', JSON.stringify(c1.body));
    const other = await call(cancelCustomerMomoPayment, { ...customer(P), params: { transactionRef: a.body.transactionRef } });
    assert.equal(other.status, 404);
    const b = await call(initiateHubtelPayment, { ...customer(R), body: { contractId: R.contract.id, amount: 7, phoneNumber: R.phone, network: 'MTN', otpCapable: true } });
    outcome.set(b.body.transactionRef, { status: 'success' });
    const c2 = await call(cancelCustomerMomoPayment, { ...customer(R), params: { transactionRef: b.body.transactionRef } });
    assert.equal(c2.body.status, 'SUCCESS');
    assert.match(c2.body.message, /already went through/);
  });

  await check('agent cancels the SMS-code step: the sale can be paid again at once', async () => {
    const r = await call(payDeposit, { userType: 'admin', user: agentUser, params: { id: X.ledger.id }, body: { amount: 60, phoneNumber: '0204000444', network: 'VODAFONE', otpCapable: true } });
    assert.equal(r.body.otpRequired, true);
    const blocked = await call(payDeposit, { userType: 'admin', user: agentUser, params: { id: X.ledger.id }, body: { amount: 60, phoneNumber: '0244000444', network: 'MTN', otpCapable: true } });
    assert.equal(blocked.status, 409, 'blocked while it waits');
    const c = await call(cancelAgentDepositPayment, { userType: 'admin', user: agentUser, params: { ref: r.body.transactionRef } });
    assert.equal(c.body.status, 'FAILED');
    const again = await call(payDeposit, { userType: 'admin', user: agentUser, params: { id: X.ledger.id }, body: { amount: 60, phoneNumber: '0244000444', network: 'MTN', otpCapable: true } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    outcome.set(again.body.transactionRef, { status: 'success', fees: 117 });
    await webhook(again.body.transactionRef);
    // The fee is written just after the rows are settled.
    await waitFor(async () => (await prisma.agentDepositPayment.findUniqueOrThrow({ where: { transactionRef: again.body.transactionRef } })).gatewayFee != null);
    const row = await prisma.agentDepositPayment.findUniqueOrThrow({ where: { transactionRef: again.body.transactionRef } });
    assert.equal(row.status, 'SUCCESS');
    assert.equal(row.gatewayFee, 1.17);
  });

  let reversedRef = '';
  await check('reverse: super admins only, a reason, never a hand-recorded payment', async () => {
    const paid = await prisma.paymentTransaction.findFirst({ where: { contractId: R.contract.id, gateway: 'PAYSTACK', status: 'SUCCESS' }, orderBy: { createdAt: 'asc' } });
    reversedRef = paid.transactionRef;
    const notSuper = await call(reverseGatewayPayment, { userType: 'admin', user: plainAdmin, params: { id: paid.id }, body: { reason: 'Refunded at Paystack' } });
    assert.equal(notSuper.status, 403);
    const noReason = await call(reverseGatewayPayment, { userType: 'admin', user: superAdmin, params: { id: paid.id }, body: { reason: '' } });
    assert.equal(noReason.status, 400);
    const manual = await call(recordManualPayment, { userType: 'admin', user: superAdmin, body: { contractId: R.contract.id, amount: 10, paymentMethod: 'CASH' } });
    assert.ok([200, 201].includes(manual.status), JSON.stringify(manual.body));
    const manualRow = await prisma.paymentTransaction.findFirst({ where: { contractId: R.contract.id, paymentMethod: 'CASH' }, orderBy: { createdAt: 'desc' } });
    const m = await call(reverseGatewayPayment, { userType: 'admin', user: superAdmin, params: { id: manualRow.id }, body: { reason: 'Recorded twice' } });
    assert.equal(m.status, 400);
    assert.match(m.body.error, /Delete it instead/);
  });

  await check('reverse: the contract is rebuilt and a late webhook or Hubtel callback never credits it again', async () => {
    const paid = await paymentOf(reversedRef);
    const before = await contractOf(R.contract.id);
    const r = await call(reverseGatewayPayment, { userType: 'admin', user: superAdmin, params: { id: paid.id }, body: { reason: 'Refunded at Paystack' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = await contractOf(R.contract.id);
    assert.equal(Math.round((before.totalPaid - after.totalPaid) * 100), Math.round(paid.amount * 100));
    assert.equal((await paymentOf(reversedRef)).status, 'REVERSED');
    const twice = await call(reverseGatewayPayment, { userType: 'admin', user: superAdmin, params: { id: paid.id }, body: { reason: 'Refunded at Paystack' } });
    assert.ok([400, 409].includes(twice.status));
    await webhook(reversedRef);
    await processHubtelCallback({ ResponseCode: '0000', Data: { ClientReference: reversedRef, Amount: paid.amount, TransactionId: 'late' } }).catch(() => undefined);
    await new Promise((res) => setTimeout(res, 400));
    assert.equal((await paymentOf(reversedRef)).status, 'REVERSED');
    assert.equal((await contractOf(R.contract.id)).totalPaid, after.totalPaid);
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'REVERSE_GATEWAY_PAYMENT', entityId: paid.id } }));
  });

  await check('reverse on a defaulted contract keeps it defaulted', async () => {
    await prisma.hirePurchaseContract.update({ where: { id: R.contract.id }, data: { status: 'DEFAULTED' } });
    const paid = await prisma.paymentTransaction.findFirst({ where: { contractId: R.contract.id, status: 'SUCCESS', paymentMethod: 'PAYSTACK_MOMO' } });
    const r = await call(reverseGatewayPayment, { userType: 'admin', user: superAdmin, params: { id: paid.id }, body: { reason: 'Charged back' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await contractOf(R.contract.id)).status, 'DEFAULTED');
    await prisma.hirePurchaseContract.update({ where: { id: R.contract.id }, data: { status: 'ACTIVE' } });
  });

  await check('a refund reported by Paystack flags the payment for staff', async () => {
    const paid = await prisma.paymentTransaction.findFirst({ where: { contractId: P.contract.id, gateway: 'PAYSTACK', status: 'SUCCESS' } });
    const raw = JSON.stringify({ event: 'refund.processed', data: { transaction_reference: paid.transactionRef, amount: 500, status: 'processed' } });
    await call(gw.handlePaystackWebhook, { rawBody: Buffer.from(raw), body: JSON.parse(raw), headers: { 'x-paystack-signature': sign(raw) } });
    await waitFor(async () => !!JSON.parse((await paymentOf(paid.transactionRef)).metadata).refundReported);
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'PAYSTACK_REFUND_REPORTED', entityId: paid.id } }));
    assert.equal((await paymentOf(paid.transactionRef)).status, 'SUCCESS', 'flagged, not reversed');
  });

  await check('income report: totals and fees by gateway', async () => {
    const r = await call(getIncomeReport, { userType: 'admin', user: superAdmin, query: { paymentMethod: 'PAYSTACK_MOMO', limit: '5', startDate: new Date(Date.now() - DAY).toISOString().slice(0, 10) } });
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const g = r.body.stats.byGateway.PAYSTACK;
    assert.ok(g && g.count > 0 && g.fees > 0, JSON.stringify(r.body.stats.byGateway));
  });

  await check('without the key, waiting Paystack payments are left alone until 48 hours', async () => {
    const r = await call(initiateHubtelPayment, { ...customer(R), body: { contractId: R.contract.id, amount: 3, phoneNumber: R.phone, network: 'MTN', otpCapable: true } });
    delete process.env.PAYSTACK_SECRET_KEY;
    const swept = await sweepPaystackCustomerPayments(new Date(Date.now() + 5 * 60_000));
    assert.equal(swept.checked, 0);
    assert.equal((await paymentOf(r.body.transactionRef)).status, 'PENDING');
    await sweepPaystackCustomerPayments(new Date(Date.now() + 49 * 3600_000));
    assert.equal((await paymentOf(r.body.transactionRef)).status, 'FAILED');
    process.env.PAYSTACK_SECRET_KEY = KEY;
  });

  await check('reversing the payment that bought a paid unlock takes the window away', async () => {
    const unlock = await prisma.paidTemporaryUnlock.findFirst({ where: { contractId: U.contract.id, status: 'APPLIED' }, orderBy: { createdAt: 'desc' } });
    assert.ok(await paid.temporaryUnlockUntil(U.contract.id), 'a window is running');
    const r = await call(reverseGatewayPayment, { userType: 'admin', user: superAdmin, params: { id: unlock.paymentId }, body: { reason: 'Charged back' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await paid.temporaryUnlockUntil(U.contract.id), null);
  });

  await check('statement shows readable payment methods', async () => {
    const { paymentMethodLabel } = require('../services/pdfService');
    assert.equal(paymentMethodLabel('PAYSTACK_MOMO'), 'Mobile Money');
    assert.equal(paymentMethodLabel('HUBTEL_REGULAR'), 'Mobile Money');
    assert.equal(paymentMethodLabel('CASH'), 'Cash');
  });

  // ── The test page ─────────────────────────────────────────────────────────
  await check('test page: super admins only; a test charge touches no contract; its notices are recorded', async () => {
    const tp = require('../controllers/paystackTestController');
    const denied = await call(tp.startTestCharge, { userType: 'admin', user: plainAdmin, body: { amount: 1, phoneNumber: '0244000999', network: 'MTN' } });
    assert.equal(denied.status, 403);
    const tooMuch = await call(tp.startTestCharge, { userType: 'admin', user: superAdmin, body: { amount: 50, phoneNumber: '0244000999', network: 'MTN' } });
    assert.equal(tooMuch.status, 400);
    const paymentsBefore = await prisma.paymentTransaction.count();
    const r = await call(tp.startTestCharge, { userType: 'admin', user: superAdmin, body: { amount: 1, phoneNumber: '0244000999', network: 'MTN' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ref = r.body.reference;
    assert.match(ref, /^PSTEST[A-Z0-9]+$/);
    const kept = await prisma.auditLog.findFirst({ where: { action: 'PAYSTACK_TEST_RESULT', entityId: ref } });
    assert.ok(kept && JSON.parse(kept.newValues).state === 'PENDING', 'Paystack\'s answer is kept with the test');
    assert.equal(charges.get(ref).amount, 100);
    outcome.set(ref, { status: 'success' });
    await webhook(ref);
    await waitFor(async () => !!(await prisma.auditLog.findFirst({ where: { action: 'PAYSTACK_TEST_EVENT', entityId: ref } })));
    assert.equal(await prisma.paymentTransaction.count(), paymentsBefore, 'no payment row is ever created');
    assert.equal(await prisma.auditLog.count({ where: { action: 'PAYSTACK_UNMATCHED', entityId: ref } }), 0);
    const d = await call(tp.getTestCharge, { userType: 'admin', user: superAdmin, params: { reference: ref } });
    assert.equal(d.body.paystack.status, 'success');
    assert.equal(d.body.amountMatches, true);
    assert.equal(d.body.events[0].event, 'charge.success');
    assert.equal(d.body.answers[0].step, 'start');
    assert.ok(d.body.events[0].fields.includes('reference'));
    const refund = await call(tp.refundTestCharge, { userType: 'admin', user: superAdmin, params: { reference: ref } });
    assert.equal(refund.status, 200, JSON.stringify(refund.body));
    const raw = JSON.stringify({ event: 'refund.processed', data: { transaction_reference: ref, amount: 100, status: 'processed' } });
    await call(gw.handlePaystackWebhook, { rawBody: Buffer.from(raw), body: JSON.parse(raw), headers: { 'x-paystack-signature': sign(raw) } });
    await waitFor(async () => (await prisma.auditLog.count({ where: { action: 'PAYSTACK_TEST_EVENT', entityId: ref } })) === 2);
    const list = await call(tp.listTestCharges, { userType: 'admin', user: superAdmin });
    const row = list.body.tests.find((t: any) => t.reference === ref);
    assert.equal(row.webhooks, 2);
    assert.match(row.phone, /^024\*\*\*\*999$/, 'the number is masked in the record');
    const notTest = await call(tp.refundTestCharge, { userType: 'admin', user: superAdmin, params: { reference: P.contract.id } });
    assert.equal(notTest.status, 400, 'only test payments can be refunded from the test page');
  });

  // ── Clean up the settings this run changed ────────────────────────────────
  await prisma.paymentGatewaySettings.deleteMany({});
  if (gwBefore) await prisma.paymentGatewaySettings.create({ data: gwBefore });
  await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: {
    lockAfterOverdueDays: knoxBefore.lockAfterOverdueDays, temporaryUnlockEnabled: knoxBefore.temporaryUnlockEnabled,
    temporaryUnlockMaxUses: knoxBefore.temporaryUnlockMaxUses, temporaryUnlockTiers: knoxBefore.temporaryUnlockTiers ?? undefined,
  } });

  hubtel.close();
  paystack.close();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
