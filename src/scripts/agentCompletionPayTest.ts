/**
 * Agent completion commission (monthly) — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/agentCompletionPayTest.ts
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import * as svc from '../services/agentCompletionPayService';

const db = prisma as any;
const TAG = `acp${Date.now()}`;
const d = (iso: string) => new Date(`${iso}T12:00:00`);
let failures = 0;
async function check(name: string, fn: () => Promise<unknown> | unknown) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.message || err}`); }
}

async function main() {
  // A clean slate for the months used here.
  await db.agentCompletionPayout.deleteMany({});
  await db.agentCompletionPayPeriod.deleteMany({});
  const before = await svc.getSettings();

  const role = (name: string) => db.role.upsert({ where: { name }, create: { name }, update: {} });
  const [agentRole, superRole] = [await role('AGENT'), await role('SUPER_ADMIN')];
  const mk = (name: string, roleId: string) => db.adminUser.create({ data: { email: `${TAG}-${name}@t.local`, password: 'x', firstName: name, lastName: TAG, roleId } });
  const A = await mk('AgentA', agentRole.id);
  const B = await mk('AgentB', agentRole.id);
  const C = await mk('AgentC', agentRole.id);
  const S = await mk('Office', superRole.id);
  const ids = [A.id, B.id, C.id, S.id];

  let n = 0;
  const done = async (agentId: string, completedAt: string, endDate = '2026-12-31') => {
    n++;
    const uuid = crypto.randomUUID();
    await db.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}${n}`, firstName: 'C', lastName: `${n}`, phone: `${TAG}${n}`, createdById: agentId } });
    return db.hirePurchaseContract.create({ data: {
      contractNumber: `${TAG}-${n}`, customerId_uuid: uuid, totalPrice: 1000, depositAmount: 200, financeAmount: 800, installmentAmount: 200,
      paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: d('2026-03-01'), endDate: d(endDate), status: 'COMPLETED',
      outstandingBalance: 0, totalPaid: 1000, createdById: agentId, approvedAt: d('2026-03-01'), completedAt: d(completedAt) } });
  };
  const many = async (agentId: string, k: number, day: string) => { const out: any[] = []; for (let i = 0; i < k; i++) out.push(await done(agentId, day)); return out; };

  await many(A.id, 4, '2026-08-10');
  await many(A.id, 3, '2026-09-10');
  await done(A.id, '2026-09-20', '2026-06-30'); // after its contract period: still counts for agents
  await many(A.id, 3, '2026-10-10');
  const bSep = await many(B.id, 10, '2026-09-15');
  await done(B.id, '2026-10-15');
  await many(C.id, 9, '2026-07-15'); // before the start month: never counted
  await done(C.id, '2026-08-15');
  await many(S.id, 12, '2026-08-20'); // an office sale, not an agent's

  await svc.saveSettings({ amountPerCompletion: 20, threshold: 10, startMonth: '2026-08', maxPerMonth: 10 }, A.id);
  const line = (v: svc.MonthView, id: string) => v.agents.find((a) => a.agentId === id);

  console.log('\nPreview and qualifying');
  await check('August: A has 4 so far, not qualified, paid nothing', async () => {
    const v = await svc.getMonth('2026-08', { agentIds: ids });
    const a = line(v, A.id)!;
    assert.deepStrictEqual([a.completedToDate, a.qualified, a.toGo, a.total], [4, false, 6, 0]);
    assert.strictEqual(line(v, C.id)!.completedToDate, 1, 'July completions are before the start month');
    assert.strictEqual(line(v, S.id), undefined, 'office sales are not counted');
  });
  await check('a month before the start shows nothing payable and cannot be closed', async () => {
    const v = await svc.getMonth('2026-07', { agentIds: ids });
    assert.strictEqual(v.beforeStart, true);
    assert.strictEqual(v.canClose, false);
    assert.strictEqual(v.totals.total, 0);
  });
  await check('months close in order: September cannot close before August', async () => {
    await assert.rejects(() => svc.closeMonth('2026-09', A.id), /Close 2026-08 first/);
  });
  await check('the month in progress cannot be closed', async () => {
    const now = new Date();
    const m = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    await assert.rejects(() => svc.closeMonth(m, A.id), /after it has ended|first/);
  });

  console.log('\nClosing');
  await check('close August: nobody qualified, nothing owed', async () => {
    const v = await svc.closeMonth('2026-08', A.id);
    assert.strictEqual(v.status, 'CLOSED');
    assert.strictEqual(line(v, A.id)!.total, 0);
  });
  await check('close September: B reaches 10 and is paid for all 10 (GHS 200); A has 8, still nothing', async () => {
    const v = await svc.closeMonth('2026-09', A.id);
    const b = line(v, B.id)!;
    assert.deepStrictEqual([b.completedToDate, b.qualified, b.count, b.total], [10, true, 10, 200]);
    assert.strictEqual(line(v, A.id)!.total, 0);
  });
  await check('a completion reopened and completed again is not paid twice', async () => {
    await db.hirePurchaseContract.update({ where: { id: bSep[0].id }, data: { completedAt: d('2026-10-20') } });
    const v = await svc.getMonth('2026-10', { agentIds: ids });
    assert.ok(!line(v, B.id)!.contracts.some((c) => c.id === bSep[0].id));
  });
  await check('a new amount applies to months closed after the change', async () => {
    await svc.saveSettings({ amountPerCompletion: 25 }, A.id);
    const v = await svc.closeMonth('2026-10', A.id);
    const a = line(v, A.id)!;
    assert.deepStrictEqual([a.completedToDate, a.qualified, a.count, a.carriedOver, a.total], [11, true, 10, 1, 250], 'A reaches 11: paid for 10 (the monthly limit), 1 carried over');
    assert.ok(a.contracts.every((c) => c.completedAt < '2026-10-11'), 'the oldest ten are paid first');
    const b = line(v, B.id)!;
    assert.deepStrictEqual([b.count, b.total], [1, 25], 'B: only the new one');
    const sep = await svc.getMonth('2026-09', { agentIds: ids });
    assert.strictEqual(line(sep, B.id)!.total, 200, 'September keeps its amount');
  });
  await check('an earlier month cannot be recalculated once a later one is closed', async () => {
    await assert.rejects(() => svc.recomputeMonth('2026-09'), /already closed/);
  });

  console.log('\nApproval and payment');
  await check('payment cannot be recorded before approval', async () => {
    await assert.rejects(() => svc.setPaid('2026-10', A.id, true, B.id, 'MOMO1'), /Approve/);
  });
  await check('approve October; a reference is needed; nothing-owed agents cannot be marked paid', async () => {
    await svc.approveMonth('2026-10', B.id);
    await assert.rejects(() => svc.setPaid('2026-10', A.id, true, B.id, ' '), /reference/);
    await assert.rejects(() => svc.setPaid('2026-10', C.id, true, B.id, 'X'), /Nothing is owed/);
    const v = await svc.setPaid('2026-10', A.id, true, B.id, 'MOMO1');
    assert.strictEqual(line(v, A.id)!.status, 'PAID');
    assert.strictEqual(v.totals.paid, 250);
  });
  await check('an approved month cannot be reopened or recalculated', async () => {
    await assert.rejects(() => svc.reopenMonth('2026-10'), /approved/);
    await assert.rejects(() => svc.recomputeMonth('2026-10'), /approved/);
  });
  await check('an agent sees their own progress and pay history', async () => {
    const p = await svc.myProgress(A.id);
    assert.strictEqual(p.qualified, true);
    assert.ok(p.history.some((h: any) => h.month === '2026-10' && h.total === 250 && h.status === 'PAID'));
    const c = await svc.myProgress(C.id);
    assert.strictEqual(c.toGo, 9);
  });

  console.log('\nMonthly limit');
  await check('the one carried over from October is paid first in November', async () => {
    const v = await svc.getMonth('2026-11', { agentIds: ids });
    const a = line(v, A.id)!;
    assert.deepStrictEqual([a.count, a.carriedOver], [1, 0]);
    assert.ok(a.contracts[0].completedAt.startsWith('2026-10-1'), 'October’s last completion');
  });
  await check('a lower limit pays fewer and carries the rest; changing it back restores', async () => {
    await svc.saveSettings({ maxPerMonth: 3 }, A.id);
    const C2 = await mk('AgentC2', agentRole.id);
    await many(C2.id, 12, '2026-11-05');
    let v = await svc.getMonth('2026-11', { agentIds: [C2.id] });
    assert.deepStrictEqual([line(v, C2.id)!.count, line(v, C2.id)!.carriedOver], [3, 9]);
    await svc.saveSettings({ maxPerMonth: 10 }, A.id);
    v = await svc.getMonth('2026-11', { agentIds: [C2.id] });
    assert.deepStrictEqual([line(v, C2.id)!.count, line(v, C2.id)!.carriedOver], [10, 2]);
  });
  await check('the limit must be a whole number from 1', async () => {
    await assert.rejects(() => svc.saveSettings({ maxPerMonth: 0 }, A.id), /from 1/);
    await assert.rejects(() => svc.saveSettings({ maxPerMonth: 2.5 }, A.id), /from 1/);
  });
  await check('a closed month keeps its limit and how many it carried', async () => {
    const oct = await db.agentCompletionPayPeriod.findUnique({ where: { month: '2026-10' } });
    assert.strictEqual((oct.settingsSnapshot as any).maxPerMonth, 10);
    const v = await svc.getMonth('2026-10', { agentIds: ids });
    assert.strictEqual(line(v, A.id)!.carriedOver, 1);
  });

  await db.agentCompletionPayout.deleteMany({});
  await db.agentCompletionPayPeriod.deleteMany({});
  await svc.saveSettings({ amountPerCompletion: before.amountPerCompletion, threshold: before.threshold, startMonth: before.startMonth, maxPerMonth: before.maxPerMonth ?? 10 }, A.id);
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
