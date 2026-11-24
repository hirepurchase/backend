/**
 * Commission payouts through Paystack — LOCAL TEST DATABASE ONLY, fake Paystack.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/commissionPayoutTest.ts
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
Object.assign(process.env, { ENABLE_SMS_NOTIFICATIONS: 'false', ENABLE_EMAIL_NOTIFICATIONS: 'false', PAYSTACK_SECRET_KEY: 'sk_test_fake', HUBTEL_PAYOUTS_ENABLED: 'false' });
import assert from 'assert';
import http from 'http';

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.stack?.split('\n').slice(0, 3).join('\n      ') || err}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── fake Paystack ───────────────────────────────────────────────────────────
type Plan = 'success' | 'pending' | 'failed' | 'otp' | 'noanswer';
const fake = {
  balancePesewas: 1_000_000,
  plan: new Map<string, Plan>(), // by recipient phone
  verify: new Map<string, { status: string; amount: number }>(), // by reference
  transfers: [] as any[],
  recipients: [] as any[],
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code: number, json: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    const u = new URL(req.url || '/', 'http://x');
    const data = body ? JSON.parse(body) : {};
    if (req.headers.authorization !== 'Bearer sk_test_fake') return send(401, { status: false, message: 'Invalid key' });
    if (u.pathname === '/bank') return send(200, { status: true, data: [{ name: 'MTN', code: 'MTN' }, { name: 'Telecel Ghana', code: 'VOD' }, { name: 'AirtelTigo', code: 'ATL' }] });
    if (u.pathname === '/balance') return send(200, { status: true, data: [{ currency: 'GHS', balance: fake.balancePesewas }] });
    if (u.pathname === '/transferrecipient' && req.method === 'POST') {
      fake.recipients.push(data);
      return send(201, { status: true, data: { recipient_code: `RCP_${data.account_number}_${fake.recipients.length}` } });
    }
    if (u.pathname === '/transfer' && req.method === 'POST') {
      fake.transfers.push(data);
      const phone = String(data.recipient).split('_')[1];
      const plan = fake.plan.get(phone) || 'success';
      if (plan === 'noanswer') { fake.verify.set(data.reference, { status: 'success', amount: data.amount }); req.socket.destroy(); return; }
      if (plan === 'failed') return send(400, { status: false, message: 'Recipient wallet is not active' });
      const status = plan === 'otp' ? 'otp' : plan;
      fake.verify.set(data.reference, { status, amount: data.amount });
      return send(200, { status: true, message: 'Transfer queued', data: { status, transfer_code: `TRF_${fake.transfers.length}`, reference: data.reference } });
    }
    const m = /^\/transfer\/verify\/(.+)$/.exec(u.pathname);
    if (m) {
      const v = fake.verify.get(decodeURIComponent(m[1]));
      if (!v) return send(404, { status: false, message: 'Transfer not found' });
      return send(200, { status: true, data: { status: v.status, amount: v.amount, transfer_code: 'TRF_V', reason: v.status === 'failed' ? 'Wallet closed' : '' } });
    }
    send(404, { status: false, message: 'no route' });
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  const { default: prisma } = require('../config/database');
  const db = prisma as any;
  const svc = require('../services/payouts/commissionPayouts');
  const acp = require('../services/agentCompletionPayService');
  const T = `po${Date.now()}`;
  const role = await db.role.upsert({ where: { name: 'AGENT' }, create: { name: 'AGENT' }, update: {} });
  const suRole = await db.role.upsert({ where: { name: 'SUPER_ADMIN' }, create: { name: 'SUPER_ADMIN' }, update: {} });
  const boss = await db.adminUser.create({ data: { email: `${T}-boss@t.local`, password: 'x', firstName: 'Boss', lastName: T, roleId: suRole.id } });
  let n = 0;
  const person = async (first: string, payout: { number?: string; network?: string; name?: string; check?: string }) => db.adminUser.create({ data: {
    email: `${T}-${++n}@t.local`, password: 'x', firstName: first, lastName: 'Test', roleId: role.id,
    payoutMomoNumber: payout.number ?? null, payoutMomoNetwork: payout.network ?? null, payoutMomoName: payout.name ?? null, payoutMomoCheck: payout.check ?? null } });
  const ok = await person('Ok', { number: '0241000001', network: 'MTN', name: 'Ok Test', check: 'MATCHED' });
  const pend = await person('Pend', { number: '0241000002', network: 'MTN', name: 'Pend Test', check: 'MATCHED' });
  const bad = await person('Bad', { number: '0201000003', network: 'TELECEL', name: 'Bad Test', check: 'MATCHED' });
  const otp = await person('Otp', { number: '0261000004', network: 'AIRTELTIGO', name: 'Otp Test', check: 'MATCHED' });
  const lost = await person('Lost', { number: '0241000005', network: 'MTN', name: 'Lost Test', check: 'UNAVAILABLE' });
  const odd = await person('Odd', { number: '0241000006', network: 'MTN', name: 'Somebody Else', check: 'MISMATCH' });
  const none = await person('None', {});
  fake.plan.set('0241000002', 'pending');
  fake.plan.set('0201000003', 'failed');
  fake.plan.set('0261000004', 'otp');
  fake.plan.set('0241000005', 'noanswer');

  // An approved agent completion month with a payout for each person.
  const MONTH = '2031-01';
  const old = await db.agentCompletionPayPeriod.findUnique({ where: { month: MONTH } });
  if (old) { await db.agentCompletionPayout.deleteMany({ where: { periodId: old.id } }); await db.agentCompletionPayPeriod.delete({ where: { id: old.id } }); }
  const period = await db.agentCompletionPayPeriod.create({ data: { month: MONTH, status: 'CLOSED', closedById: boss.id, settingsSnapshot: { amountPerCompletion: 20, threshold: 10, startMonth: '2031-01' } } });
  const payoutFor: Record<string, any> = {};
  for (const [p, amt] of [[ok, 200], [pend, 220], [bad, 240], [otp, 260], [lost, 280], [odd, 300], [none, 320]] as const) {
    payoutFor[(p as any).id] = await db.agentCompletionPayout.create({ data: { periodId: period.id, agentId: (p as any).id, completedToDate: 10, qualified: true, count: 10, rate: 20, total: amt, contracts: [] } });
  }
  const pay = (p: any) => payoutFor[p.id].id;
  const transferOf = async (p: any) => db.commissionTransfer.findFirst({ where: { payoutId: pay(p) }, orderBy: { createdAt: 'desc' } });
  const payoutRow = async (p: any) => db.agentCompletionPayout.findUnique({ where: { id: pay(p) } });
  const settle = async () => { for (let i = 0; i < 50; i++) { const busy = await db.commissionTransfer.count({ where: { month: MONTH, status: 'QUEUED' } }); if (!busy) break; await sleep(100); } await sleep(300); };
  const gw = await db.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' } });
  const gwBefore = gw?.payoutGateway;
  if (gw) await db.paymentGatewaySettings.update({ where: { id: gw.id }, data: { payoutGateway: 'PAYSTACK' } }); else await db.paymentGatewaySettings.create({ data: { payoutGateway: 'PAYSTACK' } });

  console.log('\nBefore sending');
  await check('a month not yet approved cannot be paid', async () => {
    await assert.rejects(svc.sendPayouts({ kind: 'AGENT_COMPLETION', month: MONTH, items: [{ payoutId: pay(ok) }], adminId: boss.id }), /Approve the month/);
  });
  await db.agentCompletionPayPeriod.update({ where: { id: period.id }, data: { status: 'APPROVED' } });
  await check('the list: missing number blocked, other-name wallet needs a tick, Paystack balance shown', async () => {
    const l = await svc.listPayable('AGENT_COMPLETION', MONTH);
    const by = (p: any) => l.lines.find((x: any) => x.recipientId === p.id);
    assert.equal(by(none).block, 'No payout number');
    assert.equal(by(odd).needsConfirm, true);
    assert.equal(by(ok).block, null);
    assert.equal(l.balance, 10000);
    assert.equal(l.gateway, 'PAYSTACK');
  });

  console.log('\nSending');
  let first: any;
  await check('send: missing number and unticked other-name wallet are skipped; the rest are queued', async () => {
    first = await svc.sendPayouts({ kind: 'AGENT_COMPLETION', month: MONTH, adminId: boss.id,
      items: [ok, pend, bad, otp, lost, odd, none].map((p) => ({ payoutId: pay(p) })) });
    assert.equal(first.queued, 5);
    const reasons = first.skipped.map((s: any) => s.reason).sort();
    assert.deepEqual(reasons, ['No payout number', 'Wallet in a different name — tick to confirm']);
    await settle();
  });
  await check('success: the payout is marked paid with the Paystack reference', async () => {
    const t = await transferOf(ok);
    assert.equal(t.status, 'SUCCESS');
    const p = await payoutRow(ok);
    assert.equal(p.status, 'PAID');
    assert.match(p.reference, /^PAYSTACK TRF_/);
    assert.equal(p.paidById, boss.id);
    const sent = fake.transfers.find((x) => x.reference === t.reference);
    assert.equal(sent.amount, 20000, 'GHS 200 in pesewas');
    assert.equal(sent.source, 'balance');
    const rcp = fake.recipients.find((r) => r.account_number === '0241000001');
    assert.deepEqual([rcp.type, rcp.bank_code, rcp.currency], ['mobile_money', 'MTN', 'GHS']);
  });
  await check('Telecel and AirtelTigo wallets use their own network codes', async () => {
    assert.equal(fake.recipients.find((r) => r.account_number === '0201000003').bank_code, 'VOD');
    assert.equal(fake.recipients.find((r) => r.account_number === '0261000004').bank_code, 'ATL');
  });
  await check('pending: waits; not paid until Paystack confirms', async () => {
    assert.equal((await transferOf(pend)).status, 'PENDING');
    assert.equal((await payoutRow(pend)).status, 'PENDING');
  });
  await check('refused: failed with Paystack’s reason, payout still owed', async () => {
    const t = await transferOf(bad);
    assert.equal(t.status, 'FAILED');
    assert.match(t.failureReason, /not active/);
    assert.equal((await payoutRow(bad)).status, 'PENDING');
  });
  await check('OTP on at Paystack: failed with instructions to switch it off', async () => {
    const t = await transferOf(otp);
    assert.equal(t.status, 'FAILED');
    assert.match(t.failureReason, /one-time code/);
  });
  await check('answer lost: left as sending, never resent blindly', async () => {
    const t = await transferOf(lost);
    assert.equal(t.status, 'SENDING');
    assert.equal(fake.transfers.filter((x) => x.reference === t.reference).length, 1);
  });
  await check('sending again to someone in progress or paid is refused', async () => {
    const r = await svc.sendPayouts({ kind: 'AGENT_COMPLETION', month: MONTH, adminId: boss.id, items: [{ payoutId: pay(ok) }, { payoutId: pay(pend) }] });
    assert.equal(r.queued, 0);
    assert.deepEqual(r.skipped.map((s: any) => s.reason).sort(), ['Already paid', 'Payment already in progress']);
  });
  await check('marking by hand is refused while a payment is in progress, and after one went through', async () => {
    await assert.rejects(acp.setPaid(MONTH, pend.id, true, boss.id, 'REF'), /in progress/);
    await assert.rejects(acp.setPaid(MONTH, ok.id, false, boss.id), /paid through the system/);
  });

  console.log('\nResults coming back');
  await check('webhook for the pending one: re-checked with Paystack, then paid', async () => {
    const t = await transferOf(pend);
    fake.verify.set(t.reference, { status: 'success', amount: 22000 });
    assert.equal(await svc.handlePaystackTransferEvent(t.reference), true);
    assert.equal((await transferOf(pend)).status, 'SUCCESS');
    assert.equal((await payoutRow(pend)).status, 'PAID');
  });
  await check('an unknown transfer reference is ignored', async () => {
    assert.equal(await svc.handlePaystackTransferEvent('nope-unknown-ref'), false);
  });
  await check('the sweep finds the lost one went through at Paystack and marks it paid', async () => {
    const t = await transferOf(lost);
    await db.commissionTransfer.update({ where: { id: t.id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    await db.$executeRawUnsafe(`UPDATE "CommissionTransfer" SET "updatedAt" = now() - interval '10 minutes' WHERE id = $1`, t.id);
    await svc.sweepCommissionTransfers();
    assert.equal((await transferOf(lost)).status, 'SUCCESS');
    assert.equal((await payoutRow(lost)).status, 'PAID');
  });
  await check('a send Paystack never received is failed by the sweep (safe to send again)', async () => {
    const row = await db.commissionTransfer.create({ data: { kind: 'AGENT_COMPLETION', month: MONTH, payoutId: pay(bad), recipientId: bad.id, amount: 240, gateway: 'PAYSTACK', phone: '0201000003', network: 'TELECEL', reference: `comm-test-${Date.now()}-never`, status: 'SENDING', initiatedById: boss.id } });
    await db.$executeRawUnsafe(`UPDATE "CommissionTransfer" SET "updatedAt" = now() - interval '10 minutes' WHERE id = $1`, row.id);
    await svc.sweepCommissionTransfers();
    const after = await db.commissionTransfer.findUnique({ where: { id: row.id } });
    assert.equal(after.status, 'FAILED');
    assert.match(after.failureReason, /did not receive/);
  });
  await check('a reversal after success puts the payout back to owed', async () => {
    const t = await transferOf(ok);
    fake.verify.set(t.reference, { status: 'reversed', amount: 20000 });
    await svc.handlePaystackTransferEvent(t.reference);
    assert.equal((await transferOf(ok)).status, 'REVERSED');
    assert.equal((await payoutRow(ok)).status, 'PENDING');
  });

  console.log('\nRetrying and guards');
  await check('a failed one can be sent again once fixed; the other-name wallet goes when ticked', async () => {
    fake.plan.set('0201000003', 'success');
    const r = await svc.sendPayouts({ kind: 'AGENT_COMPLETION', month: MONTH, adminId: boss.id, items: [{ payoutId: pay(bad) }, { payoutId: pay(odd), confirmMismatch: true }] });
    assert.equal(r.queued, 2);
    await settle();
    assert.equal((await payoutRow(bad)).status, 'PAID');
    const t = await transferOf(odd);
    assert.equal(t.status, 'SUCCESS');
    assert.equal(t.confirmedMismatch, true);
  });
  await check('the saved recipient is reused; a changed number gets a new one', async () => {
    const before = fake.recipients.length;
    await db.adminUser.update({ where: { id: otp.id }, data: { payoutMomoNumber: '0271000044' } });
    fake.plan.set('0271000044', 'success');
    await svc.sendPayouts({ kind: 'AGENT_COMPLETION', month: MONTH, adminId: boss.id, items: [{ payoutId: pay(otp) }] });
    await settle();
    assert.equal(fake.recipients.length, before + 1);
    assert.equal(fake.recipients[fake.recipients.length - 1].account_number, '0271000044');
    assert.equal((await payoutRow(otp)).status, 'PAID');
  });
  await check('not enough balance: refused, nothing sent', async () => {
    fake.balancePesewas = 100; // GHS 1
    const sentBefore = fake.transfers.length;
    await assert.rejects(svc.sendPayouts({ kind: 'AGENT_COMPLETION', month: MONTH, adminId: boss.id, items: [{ payoutId: pay(ok) }] }), /Not enough in the Paystack balance/);
    await settle();
    assert.equal(fake.transfers.length, sentBefore);
    assert.equal((await transferOf(ok)).status, 'FAILED');
    fake.balancePesewas = 1_000_000;
  });
  await check('cluster leader pay goes the same way', async () => {
    const LM = '2031-02';
    const oldP = await db.clusterScorecardPeriod.findUnique({ where: { month: LM } });
    if (oldP) { await db.clusterPayout.deleteMany({ where: { periodId: oldP.id } }); await db.clusterScorecardLine.deleteMany({ where: { periodId: oldP.id } }); await db.clusterScorecardPeriod.delete({ where: { id: oldP.id } }); }
    const p2 = await db.clusterScorecardPeriod.create({ data: { month: LM, status: 'APPROVED', rulesSnapshot: {}, closedById: boss.id } });
    const cp = await db.clusterPayout.create({ data: { periodId: p2.id, clusterAgentId: pend.id, total: 480 } });
    const r = await svc.sendPayouts({ kind: 'CLUSTER_LEADER', month: LM, adminId: boss.id, items: [{ payoutId: cp.id }] });
    assert.equal(r.queued, 1);
    fake.plan.set('0241000002', 'success');
    await settle();
    // pend's plan was 'pending' when queued? it is processed after the plan change, so it succeeds
    const row = await db.clusterPayout.findUnique({ where: { id: cp.id } });
    assert.equal(row.status, 'PAID');
    assert.match(row.reference, /^PAYSTACK/);
  });
  await check('every payment sent, failed or reversed has an audit entry', async () => {
    const n = await db.auditLog.count({ where: { action: { in: ['COMMISSION_PAYOUT_SENT', 'COMMISSION_PAYOUT_FAILED', 'COMMISSION_PAYOUT_REVERSED'] }, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
    assert.ok(n >= 10, `got ${n}`);
  });

  const gw2 = await db.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' } });
  if (gw2 && gwBefore) await db.paymentGatewaySettings.update({ where: { id: gw2.id }, data: { payoutGateway: gwBefore } });
  server.close();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
