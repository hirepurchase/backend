/**
 * Cluster leader scorecard integration test — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/clusterScorecardIntegrationTest.ts
 *
 * A synthetic two-leader cluster in September 2026, with one agent moving
 * from leader 1 to leader 2 on 16 September. Every indicator is checked
 * against a hand-computed figure, then the month is closed, re-rated,
 * approved and paid.
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { computeIndicators } from '../services/clusterScorecard/indicators';
import { syncAssignmentHistory } from '../services/clusterScorecard/history';
import { approveMonth, closeMonth, getMonth, recomputeMonth, setPaid } from '../services/clusterScorecard/periods';

const TAG = `sc${Date.now()}`;
const MONTH = '2026-09';
const d = (iso: string) => new Date(`${iso}T12:00:00`);
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
  // Start from a clean scorecard state for this month in the test DB.
  const old = await prisma.clusterScorecardPeriod.findUnique({ where: { month: MONTH } });
  if (old) {
    await prisma.clusterScorecardLine.deleteMany({ where: { periodId: old.id } });
    await prisma.clusterPayout.deleteMany({ where: { periodId: old.id } });
    await prisma.clusterScorecardPeriod.delete({ where: { id: old.id } });
  }

  const clusterRole = await prisma.role.upsert({ where: { name: 'CLUSTER_AGENT' }, create: { name: 'CLUSTER_AGENT' }, update: {} });
  const agentRole = await prisma.role.upsert({ where: { name: 'AGENT' }, create: { name: 'AGENT' }, update: {} });
  const mk = (name: string, roleId: string) =>
    prisma.adminUser.create({ data: { email: `${TAG}-${name}@t.local`, password: 'x', firstName: name, lastName: TAG, phone: '0240000000', roleId } });
  const L1 = await mk('Leader1', clusterRole.id);
  const L2 = await mk('Leader2', clusterRole.id);
  const A1 = await mk('Agent1', agentRole.id);
  const A2 = await mk('Agent2', agentRole.id);
  const leaders = [L1.id, L2.id];

  // Live assignments now, and the history that led here.
  await prisma.clusterAgentAssignment.createMany({
    data: [
      { clusterAgentId: L1.id, agentId: A1.id, assignedById: L1.id, createdAt: d('2026-07-01') },
      { clusterAgentId: L2.id, agentId: A2.id, assignedById: L1.id, createdAt: d('2026-09-16') },
    ],
  });
  await prisma.clusterAssignmentHistory.createMany({
    data: [
      { agentId: A1.id, clusterAgentId: L1.id, startedAt: d('2026-07-01') },
      { agentId: A2.id, clusterAgentId: L1.id, startedAt: d('2026-07-01'), endedAt: d('2026-09-16') },
      { agentId: A2.id, clusterAgentId: L2.id, startedAt: d('2026-09-16') },
    ],
  });

  const cat = await prisma.productCategory.create({ data: { name: `${TAG}-cat` } });
  const product = await prisma.product.create({ data: { name: 'TEST PHONE', basePrice: 2000, categoryId: cat.id } });
  let n = 0;
  const contract = async (agentId: string, opts: { approvedAt: string; status?: string; outstanding?: number; writtenOffAt?: string; inst: Array<{ due: string; amount?: number; paid?: number; paidAt?: string; status?: string }> }) => {
    n++;
    const uuid = crypto.randomUUID();
    await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}${n}`, firstName: 'C', lastName: `${n}`, phone: `${TAG}${n}`, createdById: agentId } });
    const c = await prisma.hirePurchaseContract.create({
      data: {
        contractNumber: `${TAG}-${n}`, customerId_uuid: uuid, totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
        paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: d(opts.approvedAt), endDate: d('2026-12-31'),
        status: opts.status ?? 'ACTIVE', outstandingBalance: opts.outstanding ?? 1600, createdById: agentId, approvedAt: d(opts.approvedAt),
        writtenOffAt: opts.writtenOffAt ? d(opts.writtenOffAt) : null,
        installments: {
          create: opts.inst.map((i, k) => ({
            installmentNo: k + 1, dueDate: d(i.due), amount: i.amount ?? 400, paidAmount: i.paid ?? 0,
            paidAt: i.paidAt ? d(i.paidAt) : null, status: i.status ?? ((i.paid ?? 0) >= (i.amount ?? 400) ? 'PAID' : 'PENDING'),
          })),
        },
      },
    });
    return { c, uuid };
  };
  const pay = (k: { c: { id: string }; uuid: string }, amount: number, on: string) =>
    prisma.paymentTransaction.create({
      data: { transactionRef: `${TAG}-p${++n}`, contractId: k.c.id, customerId_uuid: k.uuid, amount, status: 'SUCCESS', paymentDate: d(on) },
    });

  // A1 (Leader 1 all month)
  const C1 = await contract(A1.id, { approvedAt: '2026-09-05', outstanding: 1400, inst: [{ due: '2026-09-10', paid: 400, paidAt: '2026-09-09' }, { due: '2026-09-24', paid: 200, status: 'PARTIAL' }, { due: '2026-10-20' }] });
  await pay(C1, 400, '2026-09-09');
  await pay(C1, 200, '2026-09-25');
  await contract(A1.id, { approvedAt: '2026-07-10', inst: [{ due: '2026-10-15' }] }); // C4: quality (July sale, healthy)
  await contract(A1.id, { approvedAt: '2026-06-01', status: 'WRITTEN_OFF', outstanding: 500, writtenOffAt: '2026-09-15', inst: [] }); // C5
  // A2 (Leader 1 until 16 Sep, then Leader 2)
  const C2 = await contract(A2.id, { approvedAt: '2026-09-20', inst: [{ due: '2026-09-27' }] });
  const C3 = await contract(A2.id, { approvedAt: '2026-07-03', inst: [{ due: '2026-07-20', status: 'OVERDUE' }] }); // 30+ late at 1 Sep
  await pay(C3, 400, '2026-09-10'); // A2 still under Leader 1 on 10 Sep
  void C2;

  // Deposits
  const l1 = await prisma.agentDepositLedger.create({ data: { contractId: C1.c.id, agentId: A1.id, contractNumber: 'x', customerName: 'x', depositAmount: 400, commissionAmount: 100, amountDueCompany: 300, amountPaid: 300, outstandingBalance: 0, status: 'PAID', createdAt: d('2026-09-05') } });
  await prisma.agentDepositPayment.create({ data: { ledgerEntryId: l1.id, agentId: A1.id, transactionRef: `${TAG}-dep1`, amount: 300, phoneNumber: '0', network: 'MTN', status: 'SUCCESS', paidAt: d('2026-09-08') } });
  await prisma.agentDepositLedger.create({ data: { contractId: C2.c.id, agentId: A2.id, contractNumber: 'y', customerName: 'y', depositAmount: 400, commissionAmount: 100, amountDueCompany: 300, outstandingBalance: 300, status: 'PENDING', createdAt: d('2026-09-20') } });

  // Temporary unlocks the leaders vouched for
  await prisma.temporaryUnlockRequest.create({ data: { contractId: C1.c.id, agentId: A1.id, requestedById: L1.id, requestedWeeks: 1, reason: 't', status: 'FULFILLED', resolvedAt: d('2026-09-12') } });
  await prisma.temporaryUnlockRequest.create({ data: { contractId: C3.c.id, agentId: A2.id, requestedById: L2.id, requestedWeeks: 1, reason: 't', status: 'DEFAULTED', resolvedAt: d('2026-09-28') } });

  // Calls: three collection calls by Leader 1 in September, one in August, one verification by Leader 2
  for (const [officer, when, purpose] of [[L1.id, '2026-09-03', 'COLLECTION'], [L1.id, '2026-09-11', 'FOLLOW_UP'], [L1.id, '2026-09-29', 'COLLECTION'], [L1.id, '2026-08-30', 'COLLECTION'], [L2.id, '2026-09-21', 'VERIFICATION']] as const) {
    await prisma.contactAttempt.create({ data: { customerId_uuid: C1.uuid, officerId: officer, purpose, outcome: 'REACHED', contactedAt: d(when) } });
  }

  console.log('Indicator values (hand-computed)');
  const measures = await computeIndicators(MONTH, { depositRemitDays: 7, leaderIds: leaders });
  const v = (leader: string, key: string) => measures.find((m) => m.leaderId === leader)!.values.find((x) => x.key === key)!;
  const expect: Array<[string, string, number | null, number?]> = [
    ['Leader 1', 'COLLECTIONS', 1000, 3],
    ['Leader 2', 'COLLECTIONS', 0, 0],
    ['Leader 1', 'ARREARS_RECOVERED', 400],
    ['Leader 1', 'COLLECTION_RATE', 75],
    ['Leader 2', 'COLLECTION_RATE', 0],
    ['Leader 1', 'NEW_CONTRACTS', 1],
    ['Leader 2', 'NEW_CONTRACTS', 1],
    ['Leader 1', 'ACTIVE_AGENTS', 1],
    ['Leader 2', 'ACTIVE_AGENTS', 1],
    ['Leader 1', 'QUALITY_CONTRACTS', 1],
    ['Leader 2', 'QUALITY_CONTRACTS', 0],
    ['Leader 1', 'DEPOSIT_REMITTANCE', 100],
    ['Leader 2', 'DEPOSIT_REMITTANCE', 0],
    ['Leader 1', 'UNLOCKS_FULFILLED', 1],
    ['Leader 2', 'UNLOCKS_DEFAULTED', 1],
    ['Leader 1', 'WRITE_OFFS', 500],
    ['Leader 1', 'FOLLOW_UP_CALLS', 2 + 1],
    ['Leader 2', 'FOLLOW_UP_CALLS', 0],
    ['Leader 1', 'PAR30', 0],
    ['Leader 2', 'PAR30', 50],
  ];
  for (const [who, key, value, count] of expect) {
    const id = who === 'Leader 1' ? L1.id : L2.id;
    await check(`${who} ${key} = ${value}${count !== undefined ? ` (${count} events)` : ''}`, () => {
      const got = v(id, key);
      assert.strictEqual(got.value, value, `got ${got.value}`);
      if (count !== undefined) assert.strictEqual(got.count, count, `count ${got.count}`);
    });
  }

  console.log('Rates → pay');
  await prisma.clusterScorecardSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton' }, update: {} });
  await getMonth(MONTH, leaders); // seeds indicator rows
  await prisma.clusterScorecardIndicator.updateMany({ data: { enabled: false } });
  await prisma.clusterScorecardIndicator.update({ where: { key: 'COLLECTIONS' }, data: { enabled: true, payoutType: 'RATE', rate: 2 } });
  await prisma.clusterScorecardIndicator.update({ where: { key: 'NEW_CONTRACTS' }, data: { enabled: true, payoutType: 'PER_UNIT', unitAmount: 15 } });
  await prisma.clusterScorecardIndicator.update({ where: { key: 'UNLOCKS_DEFAULTED' }, data: { enabled: true, payoutType: 'PER_UNIT', unitAmount: -50 } });
  await prisma.clusterScorecardSettings.update({ where: { id: 'singleton' }, data: { baseAmount: 100, parGateEnabled: true, parGateCeiling: 25, gateWithholdsBase: false } });
  const pick = (m: Awaited<ReturnType<typeof getMonth>>, id: string) => m.leaders.find((l) => l.leaderId === id)!;

  const preview = await getMonth(MONTH, leaders);
  await check('preview: Leader 1 = 100 base + 20 (2% of 1,000) + 15 (1 contract) = 135', () =>
    assert.deepStrictEqual([pick(preview, L1.id).base, pick(preview, L1.id).variable, pick(preview, L1.id).total], [100, 35, 135]));
  await check('preview: Leader 2 gated at PAR 50% — base 100, deduction −50, total 50', () => {
    const l = pick(preview, L2.id);
    assert.deepStrictEqual([l.gated, l.base, l.variable, l.deductions, l.total], [true, 100, 0, -50, 50]);
  });

  console.log('Lifecycle');
  await check('the month in progress cannot be closed', () => assert.rejects(() => closeMonth('2026-10', L1.id), /after it has ended/));
  const closed = await closeMonth(MONTH, L1.id);
  await check('close freezes September', () => assert.strictEqual(closed.status, 'CLOSED'));
  await prisma.clusterScorecardIndicator.update({ where: { key: 'COLLECTIONS' }, data: { rate: 10 } });
  await check('a rate change after closing leaves the closed month unchanged', async () =>
    assert.strictEqual(pick(await getMonth(MONTH, leaders), L1.id).total, 135));
  await check('recompute with the snapshot rules still pays 135', async () =>
    assert.strictEqual(pick(await recomputeMonth(MONTH, L1.id), L1.id).total, 135));
  await check('recompute with the current rules pays 100 + 100 + 15 = 215', async () =>
    assert.strictEqual(pick(await recomputeMonth(MONTH, L1.id, true), L1.id).total, 215));
  await check('cannot record payment before approval', () => assert.rejects(() => setPaid(MONTH, L1.id, true, L1.id, 'REF1'), /Approve/));
  await approveMonth(MONTH, L1.id);
  await check('an approved month cannot be recomputed', () => assert.rejects(() => recomputeMonth(MONTH, L1.id), /approved/));
  await check('paid needs a reference', () => assert.rejects(() => setPaid(MONTH, L1.id, true, L1.id, ' '), /reference/));
  await check('mark paid with a reference', async () => {
    const m = await setPaid(MONTH, L1.id, true, L1.id, 'MOMO-123');
    const l = pick(m, L1.id);
    assert.deepStrictEqual([l.status, l.reference], ['PAID', 'MOMO-123']);
    assert.strictEqual(m.totals.paid, 215);
  });
  await check('undo paid', async () => assert.strictEqual(pick(await setPaid(MONTH, L1.id, false, L1.id), L1.id).status, 'PENDING'));
  await check('a leader scoped to themselves sees only their own card', async () => {
    const m = await getMonth(MONTH, [L2.id]);
    assert.deepStrictEqual(m.leaders.map((l) => l.leaderId), [L2.id]);
  });

  console.log('Assignment history sync');
  await check('moving an agent closes the old stint at the move and opens a new one', async () => {
    const movedAt = new Date();
    await prisma.clusterAgentAssignment.deleteMany({ where: { agentId: A1.id } });
    await prisma.clusterAgentAssignment.create({ data: { clusterAgentId: L2.id, agentId: A1.id, assignedById: L1.id, createdAt: movedAt } });
    await syncAssignmentHistory();
    const rows = await prisma.clusterAssignmentHistory.findMany({ where: { agentId: A1.id }, orderBy: { startedAt: 'asc' } });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].clusterAgentId, L1.id);
    assert.strictEqual(rows[0].endedAt?.getTime(), movedAt.getTime());
    assert.strictEqual(rows[1].clusterAgentId, L2.id);
    assert.strictEqual(rows[1].endedAt, null);
  });
  await check('re-saving a team without changes keeps the stint open', async () => {
    await prisma.clusterAgentAssignment.deleteMany({ where: { agentId: A1.id } });
    await prisma.clusterAgentAssignment.create({ data: { clusterAgentId: L2.id, agentId: A1.id, assignedById: L1.id } });
    await syncAssignmentHistory();
    assert.strictEqual(await prisma.clusterAssignmentHistory.count({ where: { agentId: A1.id } }), 2);
  });
  await check('removing an agent closes their stint', async () => {
    await prisma.clusterAgentAssignment.deleteMany({ where: { agentId: A1.id } });
    await syncAssignmentHistory();
    assert.strictEqual(await prisma.clusterAssignmentHistory.count({ where: { agentId: A1.id, endedAt: null } }), 0);
  });
  await check('September is still credited to Leader 1 after the move', async () => {
    const again = await computeIndicators(MONTH, { depositRemitDays: 7, leaderIds: leaders });
    assert.strictEqual(again.find((m) => m.leaderId === L1.id)!.values.find((x) => x.key === 'COLLECTIONS')!.value, 1000);
  });

  // Reset shared settings so other runs start clean.
  await prisma.clusterScorecardIndicator.updateMany({ data: { enabled: false, rate: 0, unitAmount: 0 } });
  await prisma.clusterScorecardSettings.update({ where: { id: 'singleton' }, data: { baseAmount: 0, parGateEnabled: false } });

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll integration checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
