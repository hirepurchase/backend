/**
 * Commission month-end reminders — LOCAL TEST DATABASE ONLY.
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/monthEndReminderTest.ts
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) { console.error('Refusing to run: not a localhost test database.'); process.exit(2); }
Object.assign(process.env, { ENABLE_SMS_NOTIFICATIONS: 'false', PAYSTACK_SECRET_KEY: '' });
import assert from 'assert';
import prisma from '../config/database';
import { monthEndIssues, monthEndStatus, sendMonthEndReminders } from '../services/monthEndService';

const db = prisma as any;
let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (e: any) { failures++; console.log(`  ✘ ${name}\n      ${e?.message || e}`); }
}

(async () => {
  // "Today" is 5 March 2031, so last month is February 2031.
  const now = new Date(2031, 2, 5, 9, 10);
  const M = '2031-02';
  const boss = await db.adminUser.findFirst({ where: { role: { name: 'SUPER_ADMIN' } } });
  await db.agentCompletionPaySettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', startMonth: '2031-01' }, update: { startMonth: '2031-01' } });
  await db.clusterScorecardSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', effectiveMonth: '2031-01' }, update: { effectiveMonth: '2031-01' } });
  for (const m of [M]) {
    const a = await db.agentCompletionPayPeriod.findUnique({ where: { month: m } });
    if (a) { await db.agentCompletionPayout.deleteMany({ where: { periodId: a.id } }); await db.agentCompletionPayPeriod.delete({ where: { id: a.id } }); }
    const l = await db.clusterScorecardPeriod.findUnique({ where: { month: m } });
    if (l) { await db.clusterPayout.deleteMany({ where: { periodId: l.id } }); await db.clusterScorecardLine.deleteMany({ where: { periodId: l.id } }); await db.clusterScorecardPeriod.delete({ where: { id: l.id } }); }
  }
  await db.auditLog.deleteMany({ where: { action: 'MONTH_END_REMINDER', entityId: M } });

  console.log('\nMonth-end status');
  await check('nothing closed: both months reported as not closed', async () => {
    const s = await monthEndStatus(now);
    assert.equal(s.month, M);
    assert.equal(s.agent.stage, 'NOT_CLOSED');
    assert.equal(s.leader.stage, 'NOT_CLOSED');
    const issues = monthEndIssues(s);
    assert.ok(issues.some((i) => /Agent completion commission for February 2031: not closed/.test(i)));
  });
  await check('closed but not approved, then approved and unpaid, then paid', async () => {
    const p = await db.agentCompletionPayPeriod.create({ data: { month: M, status: 'CLOSED', closedById: boss.id, settingsSnapshot: {} } });
    assert.equal((await monthEndStatus(now)).agent.stage, 'NOT_APPROVED');
    await db.agentCompletionPayPeriod.update({ where: { id: p.id }, data: { status: 'APPROVED' } });
    const row = await db.agentCompletionPayout.create({ data: { periodId: p.id, agentId: boss.id, completedToDate: 10, qualified: true, count: 10, rate: 20, total: 200, contracts: [] } });
    const s = await monthEndStatus(now);
    assert.equal(s.agent.stage, 'UNPAID');
    assert.ok(s.unpaidTotal >= 200);
    await db.agentCompletionPayout.update({ where: { id: row.id }, data: { status: 'PAID' } });
    assert.equal((await monthEndStatus(now)).agent.stage, 'DONE');
  });
  await check('reminders only go on the 2nd, 5th and 8th', async () => {
    const r = await sendMonthEndReminders(new Date(2031, 2, 4, 9, 10));
    assert.equal(r.issues.length, 0);
    assert.equal(await db.auditLog.count({ where: { action: 'MONTH_END_REMINDER', entityId: M } }), 0);
  });
  await check('on the 5th with leader pay still not closed: one reminder recorded, not repeated the same day', async () => {
    const r1 = await sendMonthEndReminders(now);
    assert.ok(r1.issues.some((i) => /Cluster leader pay for February 2031: not closed/.test(i)));
    await sendMonthEndReminders(now);
    assert.equal(await db.auditLog.count({ where: { action: 'MONTH_END_REMINDER', entityId: M } }), 1);
  });
  await check('nothing outstanding: no reminder', async () => {
    const l = await db.clusterScorecardPeriod.create({ data: { month: M, status: 'APPROVED', rulesSnapshot: {}, closedById: boss.id } });
    await db.auditLog.deleteMany({ where: { action: 'MONTH_END_REMINDER', entityId: M } });
    const s = await monthEndStatus(now);
    assert.equal(s.leader.stage, 'DONE');
    const r = await sendMonthEndReminders(new Date(2031, 2, 8, 9, 10));
    // Other approved months on this test database may still be unpaid; only this month's lines must be gone.
    assert.ok(!r.issues.some((i) => /February 2031/.test(i)));
    void l;
  });

  await prisma.$disconnect();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
