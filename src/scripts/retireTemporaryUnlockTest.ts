/**
 * Retiring approved temporary unlocks — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db KNOX_GUARD_DRY_RUN=true \
 *     npx ts-node --transpile-only src/scripts/retireTemporaryUnlockTest.ts
 *
 * Knox runs dry and texts are recorded, not sent. Synthetic data only.
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
import assert from 'assert';
import * as crypto from 'crypto';

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.message || err}`); }
}
const day = (o: number) => new Date(Date.now() + o * 86400_000);

async function main() {
  Object.assign(process.env, { KNOX_GUARD_DRY_RUN: 'true', PAYTRIGGER_DRY_RUN: 'true', ENABLE_SMS_NOTIFICATIONS: 'false', ENABLE_EMAIL_NOTIFICATIONS: 'false' });
  const texts: any[] = [];
  const notifications = require('../services/notificationService');
  notifications.sendSMS = async (o: any) => { texts.push(o); return true; };
  const { default: prisma } = require('../config/database');
  const c = require('../controllers/temporaryUnlockController');

  const call = (fn: any, req: any): Promise<{ status: number; body: any }> => new Promise((resolve) => {
    let status = 200;
    const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => resolve({ status, body: b }) };
    fn({ ip: '127.0.0.1', headers: {}, params: {}, body: {}, query: {}, ...req }, res);
  });

  const T = `rt${Date.now()}`;
  const role = (name: string) => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const agent = await prisma.adminUser.create({ data: { email: `${T}a@t.local`, password: 'x', firstName: 'Ama', lastName: 'Agent', roleId: (await role('AGENT')).id } });
  const leader = await prisma.adminUser.create({ data: { email: `${T}l@t.local`, password: 'x', firstName: 'Lee', lastName: 'Leader', phone: '0240000001', roleId: (await role('CLUSTER_AGENT')).id } });
  const boss = await prisma.adminUser.create({ data: { email: `${T}b@t.local`, password: 'x', firstName: 'Boss', lastName: 'Admin', roleId: (await role('SUPER_ADMIN')).id } });
  const admin = { id: boss.id, email: boss.email, role: 'SUPER_ADMIN', permissions: [] };
  if (!(await prisma.knoxGuardSettings.findFirst())) await prisma.knoxGuardSettings.create({ data: { id: 'singleton' } });

  async function window(tag: string, overdue: boolean, status = 'APPROVED') {
    const customer = await prisma.customer.create({ data: { id_uuid: crypto.randomUUID(), membershipId: `${T}${tag}`, firstName: `C${tag}`, lastName: 'T', phone: `0550${String(Date.now()).slice(-5)}${tag.length}`, isActivated: true, createdById: agent.id } });
    const contract = await prisma.hirePurchaseContract.create({ data: {
      contractNumber: `CON${T}${tag}`, customerId_uuid: customer.id_uuid, totalPrice: 900, depositAmount: 300, financeAmount: 600, installmentAmount: 300,
      paymentFrequency: 'WEEKLY', totalInstallments: 2, startDate: day(-30), endDate: day(30), status: 'ACTIVE',
      outstandingBalance: overdue ? 600 : 300, totalPaid: overdue ? 300 : 600, createdById: agent.id, approvedAt: day(-31) } });
    await prisma.installmentSchedule.create({ data: { contractId: contract.id, installmentNo: 1, amount: 300, dueDate: day(-10), paidAmount: overdue ? 0 : 300, status: overdue ? 'OVERDUE' : 'PAID' } });
    await prisma.installmentSchedule.create({ data: { contractId: contract.id, installmentNo: 2, amount: 300, dueDate: day(10), status: 'PENDING' } });
    await prisma.agentDepositLedger.create({ data: { contractId: contract.id, agentId: agent.id, contractNumber: contract.contractNumber, customerName: 'C T', depositAmount: 300, commissionAmount: 50, amountDueCompany: 250, amountPaid: 250, outstandingBalance: 0, status: 'PAID' } });
    const device = await prisma.managedDevice.create({ data: { contractId: contract.id, customerId_uuid: customer.id_uuid, deviceUid: `SN${T}${tag}`, approveId: `AP${T}${tag}`, enrollmentStatus: 'ACTIVE', desiredState: 'UNLOCKED', actualState: 'UNLOCKED', isActive: true } });
    const request = await prisma.temporaryUnlockRequest.create({ data: {
      contractId: contract.id, agentId: agent.id, requestedById: leader.id, requestedWeeks: 2, reason: 'Vouched by cluster leader', status,
      ...(status === 'APPROVED' ? { approvedWeeks: 2, expiresAt: day(12), reviewedById: boss.id, reviewedAt: new Date() } : {}) } });
    return { contract, device, request };
  }

  const owing = await window('OWE', true);
  const paidUp = await window('PAID', false);
  const pending = await window('PEND', true, 'PENDING');

  console.log('\nRetiring approved temporary unlocks');

  await check('new requests, approvals and extensions are refused', async () => {
    const created = await call(c.createTemporaryUnlockRequest, { user: { id: leader.id, role: 'CLUSTER_AGENT', permissions: ['REQUEST_TEMPORARY_UNLOCK'] }, body: { contractId: pending.contract.id, requestedWeeks: 1, reason: 'please open it' } });
    assert.equal(created.status, 410);
    assert.match(created.body.error, /requests have ended/);
    assert.equal((await call(c.approveTemporaryUnlockRequest, { user: admin, params: { id: pending.request.id }, body: { approvedWeeks: 1 } })).status, 410);
    assert.equal((await call(c.extendTemporaryUnlockRequest, { user: admin, params: { id: owing.request.id }, body: { weeks: 1, note: 'one more week' } })).status, 410);
    const settings = await call(c.getTemporaryUnlockSettings, { user: admin });
    assert.equal(settings.body.retired, true);
  });

  await check('ending all locks a phone whose customer still owes, keeps a paid-up one open, and rejects pending requests', async () => {
    texts.length = 0;
    const r = await call(c.endAllTemporaryUnlocks, { user: admin, body: { reason: 'Replaced by paid temporary unlock' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.found >= 2);
    const o = await prisma.temporaryUnlockRequest.findUnique({ where: { id: owing.request.id } });
    const p = await prisma.temporaryUnlockRequest.findUnique({ where: { id: paidUp.request.id } });
    const q = await prisma.temporaryUnlockRequest.findUnique({ where: { id: pending.request.id } });
    assert.deepEqual([o.status, p.status, q.status], ['REVOKED', 'FULFILLED', 'REJECTED']);
    assert.equal((await prisma.managedDevice.findUnique({ where: { id: owing.device.id } })).actualState, 'LOCKED');
    assert.equal((await prisma.managedDevice.findUnique({ where: { id: paidUp.device.id } })).actualState, 'UNLOCKED');
    assert.ok(texts.some((t) => t.to === '0240000001'), 'the cluster leader is told');
    const audits = await prisma.auditLog.count({ where: { action: 'REVOKE_TEMPORARY_UNLOCK', entityId: { in: [owing.request.id, paidUp.request.id] } } });
    assert.equal(audits, 2);
    assert.equal(await prisma.auditLog.count({ where: { action: 'END_ALL_TEMPORARY_UNLOCKS', userId: boss.id } }), 1);
  });

  await check('running it again finds nothing to end', async () => {
    const r = await call(c.endAllTemporaryUnlocks, { user: admin, body: { reason: 'Replaced by paid temporary unlock' } });
    assert.equal(r.body.found, 0);
    assert.equal(r.body.locked, 0);
  });

  await check('a reason is required', async () => {
    const r = await call(c.endAllTemporaryUnlocks, { user: admin, body: { reason: 'x' } });
    assert.equal(r.status, 400);
  });

  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
