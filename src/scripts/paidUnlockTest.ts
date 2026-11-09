/**
 * Paid temporary unlock — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db KNOX_GUARD_DRY_RUN=true PAYTRIGGER_DRY_RUN=true \
 *     npx ts-node --transpile-only src/scripts/paidUnlockTest.ts
 *
 * Hubtel's Receive Money is a local mock; Knox runs dry; no SMS leaves the
 * machine (sendSMS is replaced by a recorder). Synthetic data only.
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
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.stack?.split('\n').slice(0, 3).join('\n      ') || err}`); }
}
const DAY = 86400_000;
const day = (o: number) => new Date(Date.now() + o * DAY);
const near = (a: Date | null | undefined, b: Date, slackMs = 120_000) => !!a && Math.abs(a.getTime() - b.getTime()) <= slackMs;

async function main() {
  const prompts: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      prompts.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ResponseCode: '0001', Message: 'Transaction pending', Data: { TransactionId: `mock-${prompts.length}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    HUBTEL_RECEIVE_MONEY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/receive`,
    HUBTEL_POS_SALES_ID: 'test', HUBTEL_API_KEY: 'test', HUBTEL_API_SECRET: 'test',
    USSD_PROMPT_DELAY_MS: '20', ENABLE_SMS_NOTIFICATIONS: 'false', ENABLE_EMAIL_NOTIFICATIONS: 'false', NALO_API_KEY: '',
    KNOX_GUARD_DRY_RUN: 'true', PAYTRIGGER_DRY_RUN: 'true',
  });

  // Record texts instead of sending them.
  const texts: Array<{ to: string; message: string }> = [];
  const notifications = require('../services/notificationService');
  notifications.sendSMS = async (o: { to: string; message: string }) => { texts.push(o); return true; };

  const { default: prisma } = require('../config/database');
  const { handleUssdSession, deleteManualPayment, recordManualPayment, updateManualPayment } = require('../controllers/paymentController');
  const { processHubtelCallback } = require('../services/hubtelService');
  const paid = require('../services/paidUnlockService');
  const { customerRequestTemporaryUnlock, takeCashForTemporaryUnlock, getStaffTemporaryUnlockOffer } = require('../controllers/paidUnlockController');
  const { relockEndedPaidWindows } = require('../services/paidUnlockRelock');
  const { decide } = require('../services/payTrigger/decide');
  const { updateKnoxGuardSettings } = require('../controllers/knoxGuardSettingsController');

  const call = (fn: any, req: any): Promise<{ status: number; body: any }> => new Promise((resolve) => {
    let status = 200;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => resolve({ status, body: b }) };
    fn({ ip: '127.0.0.1', headers: {}, params: {}, body: {}, ...req }, res);
  });
  const dial = (body: any): Promise<any> => new Promise((resolve) => {
    const res: any = { status: () => res, json: (b: any) => resolve(b) };
    handleUssdSession({ body: { SessionId: `S${Date.now()}`, Operator: 'mtn', ClientState: '', ...body } }, res);
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
  const waitFor = async (fn: () => Promise<boolean>, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timed out waiting');
  };
  const callback = (ref: string, amount: number, ok = true) =>
    processHubtelCallback({ ResponseCode: ok ? '0000' : '2001', Data: { ClientReference: ref, Amount: amount, TransactionId: `tx-${ref}` } });

  // ── Data ──────────────────────────────────────────────────────────────────
  const T = `pu${Date.now()}`;
  const n = String(Date.now()).slice(-6);
  const role = (name: string) => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const agentRole = await role('AGENT');
  const adminRole = await role('ADMIN');
  const agent = await prisma.adminUser.create({ data: { email: `${T}a@t.local`, password: 'x', firstName: 'Ama', lastName: 'Agent', roleId: agentRole.id } });
  const officer = await prisma.adminUser.create({ data: { email: `${T}o@t.local`, password: 'x', firstName: 'Kofi', lastName: 'Office', roleId: adminRole.id } });
  const staff = { id: officer.id, email: officer.email, role: 'SUPER_ADMIN', permissions: [] };
  const agentStaff = { id: agent.id, email: agent.email, role: 'AGENT', permissions: ['RECORD_PAYMENT'] };

  let knox = await prisma.knoxGuardSettings.findFirst();
  if (!knox) knox = await prisma.knoxGuardSettings.create({ data: { id: 'singleton' } });
  const knoxBefore = { ...knox };
  await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { lockAfterOverdueDays: 5, temporaryUnlockEnabled: false, temporaryUnlockMaxUses: 2 } });

  async function makeContract(tag: string, opts: { status?: string; dues: number[]; ledgerOwed?: number | null; device?: 'KNOX' | 'PAYTRIGGER' | null }) {
    const phone = `05${tag}${n}`.slice(0, 10);
    const customer = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}${tag}`, firstName: `CUST${tag}`, lastName: 'TEST', phone, isActivated: true, createdById: agent.id } });
    const total = opts.dues.length * 300;
    const contract = await prisma.hirePurchaseContract.create({ data: {
      contractNumber: `CON${tag}${n}`, customerId_uuid: customer.id_uuid, totalPrice: total + 300, depositAmount: 300, financeAmount: total, installmentAmount: 300,
      paymentFrequency: 'WEEKLY', totalInstallments: opts.dues.length, startDate: day(-30), endDate: day(60), status: opts.status ?? 'ACTIVE',
      outstandingBalance: total, totalPaid: 300, createdById: agent.id, approvedAt: day(-31), gracePeriodDays: 0 } });
    for (const [i, o] of opts.dues.entries()) {
      await prisma.installmentSchedule.create({ data: { contractId: contract.id, installmentNo: i + 1, amount: 300, dueDate: day(o), status: o < 0 ? 'OVERDUE' : 'PENDING' } });
    }
    if (opts.ledgerOwed !== null) {
      const owed = opts.ledgerOwed ?? 0;
      await prisma.agentDepositLedger.create({ data: { contractId: contract.id, agentId: agent.id, contractNumber: contract.contractNumber, customerName: 'CUST TEST',
        depositAmount: 300, commissionAmount: 50, amountDueCompany: 250, amountPaid: 250 - owed, outstandingBalance: owed, status: owed > 0 ? 'PENDING' : 'PAID' } });
    }
    let device: any = null;
    if ((opts.device === undefined ? 'KNOX' : opts.device) === 'KNOX') {
      device = await prisma.managedDevice.create({ data: { contractId: contract.id, customerId_uuid: customer.id_uuid, deviceUid: `SN${tag}${n}`, approveId: `AP${tag}${n}`,
        enrollmentStatus: 'ACTIVE', desiredState: 'LOCKED', actualState: 'LOCKED', isActive: true } });
    }
    return { customer, contract, device, phone };
  }

  // Both overdue instalments are past the 5-day lock threshold, so the phone
  // stays lockable after part payments.
  const A = await makeContract('11', { dues: [-10, -8, 4, 11] });          // locked, GHS 600 overdue
  const B = await makeContract('22', { dues: [-2, 5] });                   // overdue, not yet past the lock date
  const C = await makeContract('33', { status: 'DEFAULTED', dues: [-40, -33, -26] });
  const D = await makeContract('44', { dues: [-10, 4], ledgerOwed: 100 });  // agent still owes the deposit
  const E = await makeContract('55', { dues: [-10, 4], device: null });     // no device at all
  await prisma.penalty.create({ data: { contractId: A.contract.id, amount: 45, reason: 'Late', kind: 'LATE_INSTALLMENT' } });
  await prisma.hirePurchaseContract.update({ where: { id: A.contract.id }, data: { penaltyOutstanding: 45 } });

  console.log('\nPaid temporary unlock');

  // ── Offer ─────────────────────────────────────────────────────────────────
  await check('nothing is offered while the feature is off', async () => {
    assert.equal(await paid.getTemporaryUnlockOffer(A.contract.id), null);
  });

  // Tier 1 carries a 5% charge on top of its 25% share; the rest charge nothing.
  const CHARGED = paid.DEFAULT_UNLOCK_TIERS.map((t: any, i: number) => ({ ...t, feePercent: i === 0 ? 5 : 0 }));

  await check('settings refuse bad tiers and charges, then switch it on', async () => {
    const bad = await call(updateKnoxGuardSettings, { userType: 'admin', user: staff, body: { temporaryUnlockTiers: [{ percent: 25, hours: 24 }, { percent: 20, hours: 48 }, { percent: 75, hours: 120 }, { percent: 90, hours: 168 }] } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /higher percentage/);
    for (const feePercent of [-1, 2.5, 51]) {
      const badFee = await call(updateKnoxGuardSettings, { userType: 'admin', user: staff, body: { temporaryUnlockTiers: CHARGED.map((t: any, i: number) => (i === 1 ? { ...t, feePercent } : t)) } });
      assert.equal(badFee.status, 400, `charge ${feePercent}`);
      assert.match(badFee.body.error, /Tier 2: the charge/);
    }
    const tooMuch = await call(updateKnoxGuardSettings, { userType: 'admin', user: staff, body: { temporaryUnlockTiers: CHARGED.map((t: any, i: number) => (i === 3 ? { ...t, feePercent: 10 } : t)) } });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.body.error, /Tier 4: the share and the charge together \(100%\) must be less than 100%/);
    const ok = await call(updateKnoxGuardSettings, { userType: 'admin', user: staff, body: { temporaryUnlockEnabled: true, temporaryUnlockMaxUses: 2, temporaryUnlockTiers: CHARGED } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.settings.temporaryUnlockEnabled, true);
  });

  await check('tier validation: count, ordering and horizon', async () => {
    const t = paid.DEFAULT_UNLOCK_TIERS;
    assert.equal(paid.validateTiers(t, 45 * 24), null);
    assert.match(paid.validateTiers(t.slice(0, 3), 1000), /between 4 and 6/);
    assert.match(paid.validateTiers([...t, { percent: 95, hours: 200 }, { percent: 97, hours: 300 }, { percent: 98, hours: 400 }], 1000), /between 4 and 6/);
    assert.match(paid.validateTiers([t[0], { percent: 50, hours: 24 }, t[2], t[3]], 1000), /more hours/);
    assert.match(paid.validateTiers([{ percent: 0, hours: 5 }, t[1], t[2], t[3]], 1000), /1 to 99/);
    assert.match(paid.validateTiers(t, 100), /longer than a phone can be opened ahead/);
    assert.match(paid.validateMaxUses(21), /1 to 20/);
  });

  await check('tiers are priced from instalments, leaving late charges out', async () => {
    const offer = await paid.getTemporaryUnlockOffer(A.contract.id);
    assert.ok(offer?.available, JSON.stringify(offer));
    assert.equal(offer.overdue, 600);
    assert.deepEqual(offer.options.map((o: any) => o.amount), [150, 300, 450, 540]);
    assert.deepEqual(offer.options.map((o: any) => o.feePercent), [5, 0, 0, 0]);
    assert.deepEqual(offer.options.map((o: any) => o.fee), [30, 0, 0, 0], '5% of GHS 600');
    assert.deepEqual(offer.options.map((o: any) => o.total), [180, 300, 450, 540], '25% + 5% = 30% of GHS 600');
    assert.equal(offer.usesLeft, 2);
    assert.equal(offer.activeUntil, null);
  });

  await check('tier amounts round up to the pesewa', async () => {
    assert.equal(paid.tierAmount(333.33, 25), 83.34);
    assert.equal(paid.tierAmount(100, 33), 33);
  });

  await check('nothing is offered while an approved (cluster-leader) temporary unlock holds the phone open', async () => {
    const approved = await prisma.temporaryUnlockRequest.create({ data: {
      contractId: A.contract.id, agentId: agent.id, requestedById: officer.id, requestedWeeks: 2, reason: 'Vouched by cluster leader',
      status: 'APPROVED', approvedWeeks: 2, expiresAt: day(14), reviewedById: officer.id, reviewedAt: new Date() } });
    assert.equal(await paid.getTemporaryUnlockOffer(A.contract.id), null);
    const s = await session(A.phone, ['1']);
    assert.match(s[1].Message, /^AIDOO TECH\nHi CUST11/, 'the normal balance screen');
    assert.doesNotMatch(s[1].Message, /Open phone/);
    await prisma.temporaryUnlockRequest.update({ where: { id: approved.id }, data: { status: 'FULFILLED', expiresAt: day(-1) } });
    assert.ok((await paid.getTemporaryUnlockOffer(A.contract.id))?.available, 'offered again once it has ended');
  });

  await check('nothing is offered before the lock date, without a device, or to a contract that is up to date', async () => {
    assert.equal(await paid.getTemporaryUnlockOffer(B.contract.id), null);
    assert.equal(await paid.getTemporaryUnlockOffer(E.contract.id), null);
  });

  await check('closed while the agent has not paid in the deposit', async () => {
    const offer = await paid.getTemporaryUnlockOffer(D.contract.id);
    assert.equal(offer?.available, false);
    assert.equal(offer.message, paid.DEPOSIT_HOLD_MESSAGE);
    assert.deepEqual(offer.options, []);
  });

  // ── USSD ──────────────────────────────────────────────────────────────────
  let ussdRef = '';
  await check('USSD: a locked customer is offered the unlock; screens fit 160 characters', async () => {
    const s = await session(A.phone, ['1', '9', '1', '7', '1']);
    const [menu, choice, notOption, tiers, notListed, confirm] = s;
    assert.match(menu.Message, /1\. Pay for self/);
    assert.equal(choice.ClientState.split('|')[0], 'UNLOCK_CHOICE');
    assert.match(choice.Message, /Phone locked\. Overdue GHS600\n1\. Open phone \(pay part\)\n2\. Pay any amount$/);
    assert.match(notOption.Message, /^Not an option\./);
    assert.equal(tiers.Message, 'Open phone:\n1. GHS180 - 1 day\n2. GHS300 - 3 days\n3. GHS450 - 5 days\n4. GHS540 - 7 days\n0. Back');
    assert.match(notListed.Message, /^Not on the list\./);
    assert.equal(confirm.Message, 'Pay GHS180 (incl. GHS30 charge) to open phone for 1 day? It locks after that unless all overdue is paid.\n1. Confirm\n2. Cancel');
    for (const x of s) assert.ok(x.Message.length <= 160, `${x.Message.length} chars: ${x.Message}`);
    const done = await dial({ Type: 'Response', Mobile: A.phone, Message: '1', ClientState: confirm.ClientState });
    assert.equal(done.Type, 'release');
    assert.match(done.Message, /GHS180 to open your phone for 1 day/);
    const row = await prisma.paidTemporaryUnlock.findFirst({ where: { contractId: A.contract.id, channel: 'USSD' } });
    assert.ok(row);
    assert.equal(row.status, 'PENDING');
    ussdRef = row.clientReference;
    const pay = await prisma.paymentTransaction.findUnique({ where: { transactionRef: ussdRef } });
    assert.equal(pay?.status, 'PENDING');
    assert.equal(pay?.amount, 180);
    assert.equal(pay?.unlockFee, 30);
    await waitFor(async () => prompts.some((p) => p.ClientReference === ussdRef));
  });

  await check('the longest tier screen still fits 160 characters', async () => {
    // Six tiers on a near-GHS 100,000 debt, through the real screens.
    const six = [{ percent: 10, hours: 12 }, { percent: 25, hours: 36 }, { percent: 40, hours: 60 }, { percent: 55, hours: 84 }, { percent: 70, hours: 108 }, { percent: 85, hours: 132 }];
    await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { temporaryUnlockTiers: six } });
    await prisma.installmentSchedule.updateMany({ where: { contractId: B.contract.id }, data: { amount: 49999.99, dueDate: day(-20) } });
    const s = await session(B.phone, ['1', '1']);
    await prisma.installmentSchedule.updateMany({ where: { contractId: B.contract.id }, data: { amount: 300 } });
    await prisma.installmentSchedule.updateMany({ where: { contractId: B.contract.id, installmentNo: 1 }, data: { dueDate: day(-2) } });
    await prisma.installmentSchedule.updateMany({ where: { contractId: B.contract.id, installmentNo: 2 }, data: { dueDate: day(5) } });
    await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { temporaryUnlockTiers: CHARGED } });
    const tiers = s[2];
    assert.equal(tiers.ClientState.split('|')[0], 'UNLOCK_TIER', tiers.Message);
    assert.equal(tiers.Message.split('\n').length, 8);
    for (const x of s) assert.ok(x.Message.length <= 160, `${x.Message.length} chars: ${x.Message}`);
  });

  await check('a second unlock payment is refused while the first prompt is waiting, and is never auto-retried', async () => {
    await assert.rejects(
      paid.requestTemporaryUnlock({ contractId: A.contract.id, percent: 50, channel: 'APP' }),
      /already waiting for approval/,
    );
    const pay = await prisma.paymentTransaction.findUnique({ where: { transactionRef: ussdRef } });
    assert.equal(pay.isAutoRetryEnabled, false);
  });

  await check('nothing opens before the money arrives', async () => {
    assert.equal(await paid.temporaryUnlockUntil(A.contract.id), null);
    const dev = await prisma.managedDevice.findUnique({ where: { id: A.device.id } });
    assert.equal(dev.actualState, 'LOCKED');
  });

  await check('the payment opens the phone for the tier and texts the customer', async () => {
    texts.length = 0;
    await callback(ussdRef, 180);
    const row = await prisma.paidTemporaryUnlock.findUnique({ where: { clientReference: ussdRef } });
    assert.equal(row.status, 'APPLIED');
    assert.ok(near(row.expiresAt, day(1)), String(row.expiresAt));
    const dev = await prisma.managedDevice.findUnique({ where: { id: A.device.id } });
    assert.equal(dev.actualState, 'UNLOCKED');
    assert.equal(texts.length, 1);
    assert.match(texts[0].message, /^Hi CUST11, your phone is open until .+\. Pay the remaining GHS 450\.00 overdue before then or it will lock again\. AIDOO TECH$/);
    assert.equal(texts[0].to, A.phone);
    // The charge is the company's: GHS 150 went to the arrears and the totals, not 180.
    const c = await prisma.hirePurchaseContract.findUnique({ where: { id: A.contract.id } });
    assert.equal(c.totalPaid, 300 + 150);
    const paidOnSchedule = (await prisma.installmentSchedule.findMany({ where: { contractId: A.contract.id } })).reduce((sum: number, i: any) => sum + i.paidAmount, 0);
    assert.equal(paidOnSchedule, 150);
  });

  await check('a repeated callback changes nothing', async () => {
    await callback(ussdRef, 180);
    const pays = await prisma.paymentTransaction.count({ where: { contractId: A.contract.id, status: 'SUCCESS' } });
    assert.equal(pays, 1);
  });

  await check('USSD shows the window running', async () => {
    const s = await session(A.phone, ['1']);
    assert.match(s[1].Message, /Open until \d\d\/\d\d \d\d:\d\d\. Overdue GHS450/);
  });

  // ── App ───────────────────────────────────────────────────────────────────
  await check('app: the contract carries the offer; another customer cannot use it', async () => {
    const offer = await paid.getTemporaryUnlockOffer(A.contract.id);
    assert.equal(offer.usesLeft, 1);
    const other = await call(customerRequestTemporaryUnlock, { user: { id: B.customer.id_uuid }, params: { id: A.contract.id }, body: { percent: 50, network: 'MTN', phoneNumber: A.phone } });
    assert.equal(other.status, 404);
  });

  await check('app: a stale amount is refused', async () => {
    const r = await call(customerRequestTemporaryUnlock, { user: { id: A.customer.id_uuid }, params: { id: A.contract.id }, body: { percent: 50, network: 'MTN', phoneNumber: A.phone, expectedAmount: 300 } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /amount overdue has changed/);
  });

  await check('app: paying lengthens the running window to the new tier', async () => {
    const r = await call(customerRequestTemporaryUnlock, { user: { id: A.customer.id_uuid }, params: { id: A.contract.id }, body: { percent: 50, network: 'MTN', phoneNumber: A.phone, expectedAmount: 225 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 225);
    await callback(r.body.transactionRef, 225);
    const until = await paid.temporaryUnlockUntil(A.contract.id);
    assert.ok(near(until, day(3)), String(until));
  });

  await check('the cap stops it, then only the full amount opens the phone', async () => {
    const offer = await paid.getTemporaryUnlockOffer(A.contract.id);
    assert.equal(offer.available, false);
    assert.equal(offer.usesLeft, 0);
    assert.match(offer.message, /used all your temporary unlocks\. Pay the full overdue amount of GHS 225\.00/);
    await assert.rejects(paid.requestTemporaryUnlock({ contractId: A.contract.id, percent: 25, channel: 'APP' }), /used all/);
  });

  // ── Staff ─────────────────────────────────────────────────────────────────
  let cashPaymentId = '';
  await check('office cash works and never shortens a running window; an agent is refused', async () => {
    await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { temporaryUnlockMaxUses: 5 } });
    const refused = await call(takeCashForTemporaryUnlock, { user: agentStaff, params: { id: A.contract.id }, body: { percent: 25 } });
    assert.equal(refused.status, 403);
    const view = await call(getStaffTemporaryUnlockOffer, { user: staff, params: { id: A.contract.id } });
    assert.equal(view.body.offer.usesLeft, 3);
    const before = await paid.temporaryUnlockUntil(A.contract.id);
    const r = await call(takeCashForTemporaryUnlock, { user: staff, params: { id: A.contract.id }, body: { percent: 25, expectedAmount: 67.5 } }); // 25% of GHS 225 + 5% charge
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'APPLIED');
    assert.equal(new Date(r.body.expiresAt).getTime(), before!.getTime(), 'a 1-day tier must not cut a 3-day window');
    assert.equal(r.body.offer.usesLeft, 2);
    cashPaymentId = (await prisma.paymentTransaction.findUnique({ where: { transactionRef: r.body.transactionRef } })).id;
  });

  await check('an unlock payment cannot be edited in place', async () => {
    const r = await call(updateManualPayment, { user: staff, params: { id: cashPaymentId }, body: { amount: 10 } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cannot be edited/);
  });

  await check('a reversed (deleted) payment removes the unlock and gives the use back', async () => {
    const r = await call(deleteManualPayment, { user: staff, params: { id: cashPaymentId } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const offer = await paid.getTemporaryUnlockOffer(A.contract.id);
    assert.equal(offer.usesLeft, 3);
  });

  // ── Lock decision (PayTrigger) ────────────────────────────────────────────
  await check('PayTrigger decision: opens to the window end, locks once it has passed, never cuts a later schedule', async () => {
    const now = new Date();
    const base = (over: any = {}) => ({
      contract: { id: 'c', contractNumber: 'C', status: 'ACTIVE', gracePeriodDays: 0, totalPrice: 1000, totalPaid: 100, totalInstallments: 3, endDate: day(60), approvedAt: day(-30) },
      installments: [{ installmentNo: 1, dueDate: day(-10), amount: 300, paidAmount: 0, status: 'OVERDUE' }, { installmentNo: 2, dueDate: day(20), amount: 300, paidAmount: 0, status: 'PENDING' }],
      tempUnlocks: [], depositLedger: { outstandingBalance: 0 }, penaltiesOwed: 0,
      device: { enrollmentStatus: 'ACTIVE', providerExpiresAt: day(1), activated: true },
      settings: { lockAfterOverdueDays: 1, lockOnUnpaidAgentDeposit: true, holdOnUnpaidPenalties: false, maxUnlockHorizonDays: 45 },
      now, ...over,
    });
    const open = decide(base({ paidUnlockUntil: day(2) }));
    assert.equal(open.action, 'EXTEND');
    assert.ok(near(open.nextRepayTime, day(2)));
    assert.equal(decide(base({ paidUnlockUntil: day(-0.01) })).action, 'LOCK');
    assert.equal(decide(base({ paidUnlockUntil: new Date(now.getTime() + 30_000) })).action, 'LOCK', 'a window inside the lock-now margin is over');
    const current = base({ installments: [{ installmentNo: 1, dueDate: day(10), amount: 300, paidAmount: 0, status: 'PENDING' }], paidUnlockUntil: day(2) });
    const d = decide(current);
    assert.equal(d.action, 'EXTEND');
    assert.ok(d.nextRepayTime.getTime() > day(9).getTime(), 'the later schedule stands');
    const held = decide(base({ paidUnlockUntil: day(2), depositLedger: { outstandingBalance: 50 } }));
    assert.equal(held.action, 'HOLD', 'the deposit hold outranks a window');
    const defaulted = base({ contract: { ...base().contract, status: 'DEFAULTED' }, paidUnlockUntil: day(2) });
    assert.equal(decide(defaulted).action, 'EXTEND');
    assert.equal(decide({ ...defaulted, paidUnlockUntil: null }).action, 'NONE');
  });

  // ── Knox: window ends ─────────────────────────────────────────────────────
  await check('Knox: the phone locks again once the window has passed', async () => {
    await prisma.paidTemporaryUnlock.updateMany({ where: { contractId: A.contract.id, status: 'APPLIED' }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const r = await relockEndedPaidWindows();
    assert.ok(r.contracts >= 1);
    const dev = await prisma.managedDevice.findUnique({ where: { id: A.device.id } });
    assert.equal(dev.actualState, 'LOCKED');
  });

  // ── Defaulted ─────────────────────────────────────────────────────────────
  await check('works on a defaulted contract, and locks it again after', async () => {
    const offer = await paid.getTemporaryUnlockOffer(C.contract.id);
    assert.ok(offer?.available, JSON.stringify(offer));
    assert.equal(offer.overdue, 900);
    const s = await session(C.phone, ['1', '1', '2', '1']);
    assert.equal(s[1].ClientState.split('|')[0], 'UNLOCK_CHOICE', s[1].Message);
    assert.equal(s[4].Type, 'release', s[4].Message);
    const row = await prisma.paidTemporaryUnlock.findFirst({ where: { contractId: C.contract.id } });
    assert.equal(row.amount, 450);
    await callback(row.clientReference, 450);
    let dev = await prisma.managedDevice.findUnique({ where: { id: C.device.id } });
    assert.equal(dev.actualState, 'UNLOCKED');
    assert.ok(near(await paid.temporaryUnlockUntil(C.contract.id), day(3)));
    await prisma.paidTemporaryUnlock.updateMany({ where: { contractId: C.contract.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await relockEndedPaidWindows();
    dev = await prisma.managedDevice.findUnique({ where: { id: C.device.id } });
    assert.equal(dev.actualState, 'LOCKED');
  });

  await check('a defaulted customer who has used their unlocks is not promised that paying opens the phone', async () => {
    await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { temporaryUnlockMaxUses: 1 } });
    const offer = await paid.getTemporaryUnlockOffer(C.contract.id);
    await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { temporaryUnlockMaxUses: 5 } });
    assert.equal(offer.available, false);
    assert.match(offer.message, /contact customer service/);
    assert.doesNotMatch(offer.message, /Pay the full/);
  });

  await check('a defaulted customer can also pay any amount from the unlock menu', async () => {
    const s = await session(C.phone, ['1', '2', '10']);
    assert.equal(s[2].ClientState.split('|')[0], 'AMOUNT');
    assert.equal(s[3].Type, 'release');
    assert.match(s[3].Message, /Payment of GHS 10\.00/);
  });

  // ── Clearing arrears ──────────────────────────────────────────────────────
  await check('paying everything overdue ends the offer, and the use count starts afresh', async () => {
    const offer = await paid.getTemporaryUnlockOffer(A.contract.id);
    const r = await call(recordManualPayment, { user: staff, body: { contractId: A.contract.id, amount: offer.overdue + 45, paymentMethod: 'CASH' } }); // late charges are taken first
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await paid.getTemporaryUnlockOffer(A.contract.id), null);
    // Time passes: the earlier uses were during the old arrears, then the next
    // instalment falls overdue after them.
    await prisma.paidTemporaryUnlock.updateMany({ where: { contractId: A.contract.id }, data: { activatedAt: day(-9) } });
    await prisma.installmentSchedule.updateMany({ where: { contractId: A.contract.id, installmentNo: 3 }, data: { dueDate: day(-8) } });
    const fresh = await paid.getTemporaryUnlockOffer(A.contract.id);
    assert.equal(fresh.usesLeft, 5);
  });

  await check('late charges are priced on a balance the unlock charge has not reduced', async () => {
    const { planExpiryPenaltiesForContract } = require('../services/penaltyService');
    const contract = { id: `${T}pen`, contractNumber: 'X', endDate: day(-10), outstandingBalance: 1050, status: 'ACTIVE', totalPrice: 1500, depositAmount: 300 };
    const settings = { id: 's', expiryPenaltyEnabled: true, expiryPenaltyMode: 'FIXED', expiryPenaltyRate: 10, expiryGraceDays: 0, maxPenaltyPercentage: 100, activatedAt: day(-30), notifyCustomer: false };
    // GHS 180 paid of which GHS 30 was the unlock charge: GHS 1,050 still owed, so 10% is GHS 105.
    const [charge] = await planExpiryPenaltiesForContract(contract, settings, new Date(), [], [{ amount: 180, unlockFee: 30, paymentDate: day(-20) }]);
    assert.equal(charge.amount, 105);
  });

  await check('USSD for everyone else is unchanged', async () => {
    await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: { temporaryUnlockEnabled: false } });
    const s = await session(A.phone, ['1']);
    assert.match(s[1].Message, /^AIDOO TECH\nHi CUST11, \(CON11/);
    assert.match(s[1].Message, /1\. Pay  0\. Cancel$/);
  });

  // ── Clean up the settings this run changed ────────────────────────────────
  await prisma.knoxGuardSettings.update({ where: { id: knox.id }, data: {
    lockAfterOverdueDays: knoxBefore.lockAfterOverdueDays, temporaryUnlockEnabled: knoxBefore.temporaryUnlockEnabled,
    temporaryUnlockMaxUses: knoxBefore.temporaryUnlockMaxUses, temporaryUnlockTiers: knoxBefore.temporaryUnlockTiers } });

  server.close();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
