/**
 * Welcome calls & shared customer service calls — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/welcomeCallTest.ts
 *
 * Welcome calls as a permission any user can be given; agents moved between
 * the people who have it; verification and approval following that
 * assignment; and each morning's recovery / reminder calls shared among
 * customer service.
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
// Approving contracts sends notifications; a test must never text or email anyone.
process.env.ENABLE_SMS_NOTIFICATIONS = 'false';
process.env.ENABLE_EMAIL_NOTIFICATIONS = 'false';

import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { effectivePermissions, setGrantedPermissions } from '../services/userPermissionService';
import { eligibleOfficers } from '../services/welcomeCallService';
import { getSupervisionBlockers } from '../services/supervisionService';
import { dayKey, officerAllocations, reshareDay, shareDay } from '../services/callAllocationService';
import { transferWelcomeCalls } from '../controllers/welcomeCallController';
import { approveContract, getPendingApprovals } from '../controllers/contractApprovalController';
import { getVerificationQueue, getCsoCallQueue } from '../controllers/customerServiceController';

const TAG = `wc${Date.now()}`;
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

async function call(handler: (req: any, res: any) => Promise<unknown>, user: { id: string; role: string; permissions?: string[] }, opts: { body?: unknown; params?: Record<string, string>; query?: Record<string, string> } = {}) {
  let status = 200;
  let payload: any;
  const res: any = {
    status(s: number) { status = s; return res; },
    json(b: unknown) { payload = b; return res; },
  };
  await handler({ user: { email: 'x', permissions: [], ...user }, body: opts.body ?? {}, params: opts.params ?? {}, query: opts.query ?? {}, ip: '127.0.0.1', headers: {} }, res);
  return { status, body: payload };
}

async function main() {
  // Customer service accounts from earlier runs would join today's share; keep only this run's active.
  await prisma.adminUser.updateMany({ where: { role: { name: 'CUSTOMER_SERVICE' }, NOT: { lastName: TAG } }, data: { isActive: false } });
  await prisma.callAllocation.deleteMany({});

  const perm = await prisma.permission.upsert({ where: { name: 'VERIFY_CUSTOMER' }, create: { name: 'VERIFY_CUSTOMER' }, update: {} });
  const role = (name: string, withVerify = false) =>
    prisma.role.upsert({ where: { name }, create: { name, ...(withVerify ? { permissions: { connect: { id: perm.id } } } : {}) }, update: withVerify ? { permissions: { connect: { id: perm.id } } } : {} });
  const [csoRole, agentRole, otherRole] = await Promise.all([role('CUSTOMER_SERVICE', true), role('AGENT'), role(`${TAG}_STAFF`)]);
  const mk = (name: string, roleId: string) =>
    prisma.adminUser.create({ data: { email: `${TAG}-${name.toLowerCase()}@t.local`, password: 'x', firstName: name, lastName: TAG, phone: '0000000000', roleId } });
  const C1 = await mk('CsoOne', csoRole.id);
  const C2 = await mk('CsoTwo', csoRole.id);
  const C3 = await mk('CsoThree', csoRole.id);
  const W = await mk('Welcomer', otherRole.id); // not customer service; given the permission alone
  const X = await mk('Outsider', otherRole.id); // never given it
  const agents = await Promise.all(['A1', 'A2', 'A3', 'A4'].map((n) => mk(n, agentRole.id)));
  const [A1, A2, A3, A4] = agents;
  // Today: every agent has a customer service officer, as in production.
  await prisma.csoAgentAssignment.createMany({
    data: [
      { csoId: C1.id, agentId: A1.id, assignedById: C1.id },
      { csoId: C1.id, agentId: A2.id, assignedById: C1.id },
      { csoId: C1.id, agentId: A3.id, assignedById: C1.id },
      { csoId: C2.id, agentId: A4.id, assignedById: C1.id },
    ],
  });
  const admin = { id: C3.id, role: 'ADMIN', permissions: ['MANAGE_CSO_ASSIGNMENTS'] };

  console.log('Welcome calls as a permission');
  await check('a role without it has nothing extra', async () => {
    const u = await prisma.adminUser.findUnique({ where: { id: W.id }, include: { role: { include: { permissions: true } } } });
    assert.ok(!(await effectivePermissions(u!)).includes('VERIFY_CUSTOMER'));
  });
  await check('only the welcome-call permission can be given to one user', async () => {
    await assert.rejects(setGrantedPermissions(W.id, ['MANAGE_USERS'], C3.id), /cannot be given/);
  });
  await check('given to one user, it is in their permissions', async () => {
    await setGrantedPermissions(W.id, ['VERIFY_CUSTOMER'], C3.id);
    const u = await prisma.adminUser.findUnique({ where: { id: W.id }, include: { role: { include: { permissions: true } } } });
    assert.ok((await effectivePermissions(u!)).includes('VERIFY_CUSTOMER'));
  });
  await check('eligible: customer service by role, the welcomer by grant, not the outsider', async () => {
    const ids = (await eligibleOfficers()).map((o) => o.id);
    assert.ok(ids.includes(C1.id) && ids.includes(W.id));
    assert.ok(!ids.includes(X.id));
  });

  console.log('Moving agents');
  await check('cannot move agents to someone without the permission', async () => {
    const r = await call(transferWelcomeCalls, admin, { body: { fromOfficerId: C1.id, agentIds: [A1.id], toOfficerId: X.id } });
    assert.strictEqual(r.status, 400);
  });
  await check('cannot move agents that are not with that person', async () => {
    const r = await call(transferWelcomeCalls, admin, { body: { fromOfficerId: C1.id, agentIds: [A4.id], toOfficerId: W.id } });
    assert.strictEqual(r.status, 400);
  });
  await check('move some: 2 of CsoOne’s 3 agents to the welcomer', async () => {
    const r = await call(transferWelcomeCalls, admin, { body: { fromOfficerId: C1.id, agentIds: [A1.id, A2.id], toOfficerId: W.id, reason: 'Transition' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.moved, 2);
    assert.strictEqual(await prisma.csoAgentAssignment.count({ where: { csoId: W.id } }), 2);
    assert.strictEqual(await prisma.csoAgentAssignment.count({ where: { csoId: C1.id } }), 1);
    assert.strictEqual(await prisma.welcomeCallTransfer.count({ where: { toOfficerId: W.id } }), 2);
  });
  await check('move all of CsoTwo’s agents', async () => {
    const r = await call(transferWelcomeCalls, admin, { body: { fromOfficerId: C2.id, all: true, toOfficerId: W.id } });
    assert.strictEqual(r.body.moved, 1);
    assert.strictEqual(await prisma.csoAgentAssignment.count({ where: { csoId: C2.id } }), 0);
  });
  await check('an agent always has one welcome-call person', async () => {
    for (const a of agents) assert.strictEqual(await prisma.csoAgentAssignment.count({ where: { agentId: a.id } }), 1);
  });
  await check('the move is audited', async () => {
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'TRANSFER_WELCOME_CALLS', userId: C3.id } }));
  });

  console.log('Verification and approval follow the welcome-call person');
  const cat = await prisma.productCategory.create({ data: { name: `${TAG}-cat` } });
  const product = await prisma.product.create({ data: { name: 'TEST PHONE', basePrice: 2000, categoryId: cat.id } });
  let n = 0;
  const contract = async (agentId: string, status: string, opts: { frequency?: string; inst?: Array<{ due: Date; status?: string; paid?: number }> } = {}) => {
    n++;
    const uuid = crypto.randomUUID();
    await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}${n}`, firstName: 'C', lastName: `${TAG}${n}`, phone: `${TAG}${n}`, createdById: agentId } });
    const c = await prisma.hirePurchaseContract.create({
      data: {
        contractNumber: `${TAG}-${n}`, customerId_uuid: uuid, totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
        paymentFrequency: opts.frequency ?? 'WEEKLY', totalInstallments: 4, startDate: new Date(), endDate: new Date(Date.now() + 90 * 86400e3),
        status, outstandingBalance: 1600, createdById: agentId,
        installments: { create: (opts.inst ?? []).map((i, k) => ({ installmentNo: k + 1, dueDate: i.due, amount: 400, paidAmount: i.paid ?? 0, status: i.status ?? 'PENDING' })) },
      },
    });
    await prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: `${TAG}i${n}`, status: status === 'PENDING_APPROVAL' ? 'RESERVED' : 'SOLD', contractId: c.id } });
    return { c, uuid };
  };
  const pending1 = await contract(A1.id, 'PENDING_APPROVAL'); // now the welcomer's
  const pending3 = await contract(A3.id, 'PENDING_APPROVAL'); // still CsoOne's
  const welcomer = { id: W.id, role: `${TAG}_STAFF`, permissions: ['VERIFY_CUSTOMER'] };
  const csoOne = { id: C1.id, role: 'CUSTOMER_SERVICE', permissions: ['VERIFY_CUSTOMER', 'APPROVE_CONTRACT', 'VIEW_ASSIGNED_CONTRACTS'] };

  await check('the welcomer’s verification queue has their agent’s new contract only', async () => {
    const r = await call(getVerificationQueue, welcomer);
    const ids = (r.body.contracts ?? r.body.items ?? r.body.queue ?? []).map((c: any) => c.id);
    assert.ok(ids.includes(pending1.c.id), JSON.stringify(Object.keys(r.body)));
    assert.ok(!ids.includes(pending3.c.id));
  });
  await check('CsoOne no longer sees the moved agent’s contract to approve', async () => {
    const r = await call(getPendingApprovals, csoOne);
    const ids = (r.body.contracts ?? []).map((c: any) => c.id);
    assert.ok(ids.includes(pending3.c.id) && !ids.includes(pending1.c.id), JSON.stringify(ids));
  });
  await check('CsoOne cannot approve it', async () => {
    const r = await call(approveContract, csoOne, { params: { id: pending1.c.id } });
    assert.strictEqual(r.status, 403);
  });
  await check('the welcomer must log a successful call before approving', async () => {
    const r = await call(approveContract, welcomer, { params: { id: pending1.c.id } });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /verification/);
  });
  await check('after a verified call the welcomer approves it', async () => {
    await prisma.contactAttempt.create({ data: { customerId_uuid: pending1.uuid, contractId: pending1.c.id, officerId: W.id, purpose: 'VERIFICATION', outcome: 'REACHED', verificationResult: 'VERIFIED' } });
    const r = await call(approveContract, welcomer, { params: { id: pending1.c.id } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await prisma.hirePurchaseContract.findUnique({ where: { id: pending1.c.id } }))?.status, 'ACTIVE');
  });
  await check('an administrator can still approve any', async () => {
    const r = await call(approveContract, { id: X.id, role: 'ADMIN', permissions: ['APPROVE_CONTRACT'] }, { params: { id: pending3.c.id } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });
  await check('selling rule: an agent with nobody for welcome calls is told so', async () => {
    const settings = await prisma.supervisionSettings.findFirst();
    if (settings) await prisma.supervisionSettings.update({ where: { id: settings.id }, data: { requireCso: true, parBlockEnabled: false } });
    else await prisma.supervisionSettings.create({ data: { requireCso: true } });
    assert.deepStrictEqual(await getSupervisionBlockers(A1.id, 'AGENT'), []);
    await prisma.csoAgentAssignment.deleteMany({ where: { agentId: A4.id } });
    const blockers = await getSupervisionBlockers(A4.id, 'AGENT');
    assert.ok(blockers.some((b) => /welcome calls/.test(b)), JSON.stringify(blockers));
    await prisma.csoAgentAssignment.create({ data: { csoId: W.id, agentId: A4.id, assignedById: C3.id } });
  });

  console.log('Sharing the morning’s calls');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const daysAgo = (d: number) => new Date(today.getTime() - d * 86400e3);
  const overdue: Array<{ c: { id: string }; uuid: string }> = [];
  for (let i = 0; i < 9; i++) overdue.push(await contract(A1.id, 'ACTIVE', { inst: [{ due: daysAgo(5 + i), status: 'OVERDUE' }] }));
  const weeklyDue = await contract(A2.id, 'ACTIVE', { frequency: 'WEEKLY', inst: [{ due: new Date(today.getTime() + 86400e3) }] });
  const dailyDue = await contract(A2.id, 'ACTIVE', { frequency: 'DAILY', inst: [{ due: today }] });
  // A promise CsoTwo took for one of the overdue customers, due today.
  await prisma.contactAttempt.create({ data: { customerId_uuid: overdue[0].uuid, officerId: C2.id, purpose: 'COLLECTION', outcome: 'PROMISE_TO_PAY', promiseToPayDate: today, promiseToPayAmount: 400, contactedAt: daysAgo(2) } });

  const share = await shareDay(today);
  const rows = await prisma.callAllocation.findMany({ where: { day: dayKey(today) } });
  const mine = rows.filter((r) => [C1.id, C2.id, C3.id].includes(r.officerId));
  const ofTest = (uuid: string) => rows.find((r) => r.customerId_uuid === uuid);
  await check('shared among the 3 customer service accounts only', () => {
    assert.strictEqual(share.officers, 3);
    assert.ok(rows.every((r) => [C1.id, C2.id, C3.id].includes(r.officerId)));
  });
  await check('every overdue customer is on someone’s list', () => {
    for (const o of overdue) assert.ok(ofTest(o.uuid), 'missing overdue customer');
  });
  await check('the promise goes back to CsoTwo, who took it', () => {
    const r = ofTest(overdue[0].uuid)!;
    assert.strictEqual(r.officerId, C2.id);
    assert.strictEqual(r.kind, 'PROMISE');
  });
  await check('weekly payer due tomorrow gets a reminder; the daily payer does not', () => {
    assert.strictEqual(ofTest(weeklyDue.uuid)?.kind, 'REMINDER');
    assert.ok(!ofTest(dailyDue.uuid));
  });
  await check('shared evenly (no officer more than one call ahead)', () => {
    const counts = [C1.id, C2.id, C3.id].map((id) => mine.filter((r) => r.officerId === id).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, JSON.stringify(counts));
  });
  await check('urgent and promised calls are listed before the rest', () => {
    const promise = ofTest(overdue[0].uuid)!;
    const reminder = ofTest(weeklyDue.uuid)!;
    assert.ok(promise.priority < reminder.priority);
  });
  await check('running again the same day changes nothing', async () => {
    const again = await shareDay(today);
    assert.strictEqual(again.alreadyShared, true);
    assert.strictEqual(await prisma.callAllocation.count({ where: { day: dayKey(today) } }), rows.length);
  });
  await check('a CSO’s call queue is their share, in order, marked when called', async () => {
    const r = await call(getCsoCallQueue, { id: C2.id, role: 'CUSTOMER_SERVICE', permissions: ['MANAGE_CONTACT_ATTEMPTS'] });
    assert.strictEqual(r.body.mode, 'SHARED');
    const theirs = rows.filter((x) => x.officerId === C2.id).length;
    assert.strictEqual(r.body.count, theirs);
    const promised = r.body.customers.find((c: any) => c.customer.uuid === overdue[0].uuid);
    assert.strictEqual(promised?.allocation.kind, 'PROMISE');
    // In the order of the share, which puts promises before ordinary recoveries and reminders.
    const order = r.body.customers.map((c: any) => rows.find((x) => x.customerId_uuid === c.customer.uuid)!.priority);
    assert.deepStrictEqual(order, [...order].sort((a: number, b: number) => a - b));
  });
  await check('reshare: CsoThree is off — their calls not yet made go to the other two', async () => {
    const before = rows.filter((r) => r.officerId === C3.id);
    const calledOne = before[0];
    await prisma.contactAttempt.create({ data: { customerId_uuid: calledOne.customerId_uuid, officerId: C3.id, purpose: 'COLLECTION', outcome: 'NO_ANSWER' } });
    // Calls already made today stay put (earlier runs in this database may have made some).
    const start = new Date(today);
    start.setHours(0, 0, 0, 0);
    const made = new Set(
      (await prisma.contactAttempt.findMany({
        where: { customerId_uuid: { in: before.map((b) => b.customerId_uuid) }, contactedAt: { gte: start }, purpose: { in: ['COLLECTION', 'FOLLOW_UP'] } },
        select: { customerId_uuid: true },
      })).map((x) => x.customerId_uuid),
    );
    const r = await reshareDay([C1.id, C2.id], today);
    assert.strictEqual(r.moved, before.filter((b) => !made.has(b.customerId_uuid)).length);
    const left = await prisma.callAllocation.findMany({ where: { day: dayKey(today), officerId: C3.id } });
    assert.ok(left.some((x) => x.customerId_uuid === calledOne.customerId_uuid));
    assert.ok(left.every((x) => made.has(x.customerId_uuid)));
    const mineNow = (await officerAllocations(C3.id, today)).allocations;
    assert.ok(mineNow.length >= 1 && mineNow.every((a) => a.called));
  });

  await prisma.adminUser.updateMany({ where: { role: { name: 'CUSTOMER_SERVICE' }, lastName: TAG }, data: { isActive: false } });
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    setTimeout(() => process.exit(failures ? 1 : 0), 500);
  });
