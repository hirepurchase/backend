/**
 * KPI integration test — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/kpiIntegrationTest.ts
 *
 * A synthetic September 2026: one cluster leader who also sells, one agent in
 * their team, two customer service officers chasing the same customers. Every
 * figure is checked against a hand-computed one, then targets, statuses and
 * who-may-see-whom.
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { csoCards, judge, sellerCards, setTargets, teamCards, validateTarget, KpiCard } from '../services/kpi';
import { getMyKpis, getPeopleKpis, putKpiTargets } from '../controllers/kpiController';

const TAG = `kpi${Date.now()}`;
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
const line = (c: KpiCard | undefined, key: string) => {
  const l = c?.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l;
};

/** Call a controller with a fake request; returns { status, body }. */
async function call(handler: (req: any, res: any) => Promise<unknown>, user: { id: string; role: string; permissions?: string[] }, query: Record<string, string> = {}, body?: unknown) {
  let status = 200;
  let payload: any;
  const res: any = {
    status(s: number) { status = s; return res; },
    json(b: unknown) { payload = b; return res; },
  };
  await handler({ user: { email: 'x', permissions: [], ...user }, query, body, params: {}, ip: '127.0.0.1', headers: {} }, res);
  return { status, body: payload };
}

async function main() {
  await prisma.kpiTarget.deleteMany({});

  const role = (name: string) => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const [clusterRole, agentRole, csoRole] = await Promise.all([role('CLUSTER_AGENT'), role('AGENT'), role('CUSTOMER_SERVICE')]);
  const mk = (name: string, roleId: string) =>
    prisma.adminUser.create({ data: { email: `${TAG}-${name}@t.local`, password: 'x', firstName: name, lastName: TAG, phone: '0240000000', roleId } });
  const L1 = await mk('Leader', clusterRole.id);
  const A1 = await mk('Agent', agentRole.id);
  const O1 = await mk('OfficerOne', csoRole.id);
  const O2 = await mk('OfficerTwo', csoRole.id);

  await prisma.clusterAgentAssignment.create({ data: { clusterAgentId: L1.id, agentId: A1.id, assignedById: L1.id, createdAt: d('2026-07-01') } });
  await prisma.clusterAssignmentHistory.create({ data: { agentId: A1.id, clusterAgentId: L1.id, startedAt: d('2026-07-01') } });
  await prisma.csoAgentAssignment.create({ data: { csoId: O1.id, agentId: A1.id, assignedById: L1.id } });

  const cat = await prisma.productCategory.create({ data: { name: `${TAG}-cat` } });
  await prisma.product.create({ data: { name: 'TEST PHONE', basePrice: 2000, categoryId: cat.id } });
  let n = 0;
  const contract = async (agentId: string, opts: { approvedAt: string; status?: string; completedAt?: string; inst: Array<{ due: string; amount?: number; paid?: number; status?: string }> }) => {
    n++;
    const uuid = crypto.randomUUID();
    await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}${n}`, firstName: 'C', lastName: `${n}`, phone: `${TAG}${n}`, createdById: agentId } });
    const c = await prisma.hirePurchaseContract.create({
      data: {
        contractNumber: `${TAG}-${n}`, customerId_uuid: uuid, totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
        paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: d(opts.approvedAt), endDate: d('2026-12-31'),
        status: opts.status ?? 'ACTIVE', outstandingBalance: 1600, createdById: agentId, approvedAt: d(opts.approvedAt),
        completedAt: opts.completedAt ? d(opts.completedAt) : null,
        installments: {
          create: opts.inst.map((i, k) => ({
            installmentNo: k + 1, dueDate: d(i.due), amount: i.amount ?? 400, paidAmount: i.paid ?? 0,
            status: i.status ?? ((i.paid ?? 0) >= (i.amount ?? 400) ? 'PAID' : 'PENDING'),
          })),
        },
      },
    });
    return { c, uuid };
  };
  const pay = (k: { c: { id: string }; uuid: string }, amount: number, on: string) =>
    prisma.paymentTransaction.create({ data: { transactionRef: `${TAG}-p${++n}`, contractId: k.c.id, customerId_uuid: k.uuid, amount, status: 'SUCCESS', paymentDate: d(on), createdAt: d(on) } });
  const callLog = (k: { uuid: string; c?: { id: string } }, officerId: string, on: string, extra: Record<string, unknown>) =>
    prisma.contactAttempt.create({ data: { customerId_uuid: k.uuid, contractId: k.c?.id, officerId, contactedAt: d(on), purpose: 'COLLECTION', outcome: 'REACHED', ...extra } as any });

  // ── The agent's book ──
  const X = await contract(A1.id, { approvedAt: '2026-09-05', inst: [{ due: '2026-09-10', paid: 400 }, { due: '2026-09-24', paid: 200, status: 'PARTIAL' }, { due: '2026-10-22' }] });
  await pay(X, 400, '2026-09-09');
  await pay(X, 200, '2026-09-25');
  await contract(A1.id, { approvedAt: '2026-06-10', status: 'COMPLETED', completedAt: '2026-09-18', inst: [] });
  const W = await contract(A1.id, { approvedAt: '2026-08-01', inst: [{ due: '2026-11-20' }] });
  await pay(W, 150, '2026-10-02'); // after a 29 September call — belongs to September's calls
  const ledger = await prisma.agentDepositLedger.create({ data: { contractId: X.c.id, agentId: A1.id, contractNumber: 'x', customerName: 'x', depositAmount: 400, commissionAmount: 100, amountDueCompany: 300, amountPaid: 300, outstandingBalance: 0, status: 'PAID', createdAt: d('2026-09-05') } });
  await prisma.agentDepositPayment.create({ data: { ledgerEntryId: ledger.id, agentId: A1.id, transactionRef: `${TAG}-dep`, amount: 300, phoneNumber: '0', network: 'MTN', status: 'SUCCESS', paidAt: d('2026-09-08') } });

  // ── The leader's own book ──
  const Y = await contract(L1.id, { approvedAt: '2026-07-15', inst: [{ due: '2026-10-20' }] });
  await pay(Y, 300, '2026-09-04');
  const Z = await contract(L1.id, { approvedAt: '2026-09-12', inst: [{ due: '2026-10-15' }] });

  // ── Calls ──
  // X: O1 rings first (no answer), O2 speaks to them later; X pays → O2's.
  await callLog(X, O1.id, '2026-09-20', { outcome: 'NO_ANSWER' });
  await callLog(X, O2.id, '2026-09-23', {});
  // Y: O1 gets a promise of 300 by the 5th; paid on the 4th → kept, follow-up not needed.
  await callLog(Y, O1.id, '2026-09-02', { outcome: 'PROMISE_TO_PAY', promiseToPayDate: d('2026-09-05'), promiseToPayAmount: 300, nextFollowUpAt: d('2026-09-06') });
  // Z: O1 gets a promise of 500 by the 28th; nothing paid → broken, follow-up never made.
  await callLog(Z, O1.id, '2026-09-26', { outcome: 'PROMISE_TO_PAY', promiseToPayDate: d('2026-09-28'), promiseToPayAmount: 500, nextFollowUpAt: d('2026-09-29') });
  // W: O2 on the 29th; paid 2 October.
  await callLog(W, O2.id, '2026-09-29', { purpose: 'FOLLOW_UP' });
  // Verifications: one real, one "verified" without the customer answering.
  await callLog(Z, O1.id, '2026-09-12', { purpose: 'VERIFICATION', verificationResult: 'VERIFIED' });
  await callLog(X, O1.id, '2026-09-05', { purpose: 'VERIFICATION', outcome: 'NO_ANSWER', verificationResult: 'VERIFIED' });

  console.log('Agent and leader-own figures');
  const sellers = await sellerCards(MONTH, [A1.id, L1.id]);
  const a1 = sellers.find((c) => c.userId === A1.id);
  const l1own = sellers.find((c) => c.userId === L1.id);
  await check('agent collections 600 (400 + 200)', () => assert.strictEqual(line(a1, 'COLLECTIONS').value, 600));
  await check('agent collection rate 75% (600 of 800 due)', () => assert.strictEqual(line(a1, 'COLLECTION_RATE').value, 75));
  await check('agent new contracts 1', () => assert.strictEqual(line(a1, 'NEW_CONTRACTS').value, 1));
  await check('agent completed 1', () => assert.strictEqual(line(a1, 'COMPLETED_CONTRACTS').value, 1));
  await check('agent deposits on time 100%', () => assert.strictEqual(line(a1, 'DEPOSIT_REMITTANCE').value, 100));
  await check('PAR not shown for a past month', () => assert.strictEqual(line(a1, 'PAR30').value, null));
  await check('leader own collections 300, separate from the team', () => assert.strictEqual(line(l1own, 'COLLECTIONS').value, 300));
  await check('leader own new contracts 1', () => assert.strictEqual(line(l1own, 'NEW_CONTRACTS').value, 1));
  await check('leader own quality contracts 1 (July sale, current)', () => assert.strictEqual(line(l1own, 'QUALITY_CONTRACTS').value, 1));
  await check('leader own collection rate: nothing due → not measured', () => assert.strictEqual(line(l1own, 'COLLECTION_RATE').value, null));

  console.log('Team figures (the scorecard measures)');
  const team = (await teamCards(MONTH, [L1.id]))[0];
  await check('team collections 600 — the agent only, not the leader’s own', () => assert.strictEqual(line(team, 'COLLECTIONS').value, 600));
  await check('team new contracts 1', () => assert.strictEqual(line(team, 'NEW_CONTRACTS').value, 1));
  await check('team collection rate 75%', () => assert.strictEqual(line(team, 'COLLECTION_RATE').value, 75));
  await check('team agent count 1', () => assert.strictEqual(team.agentCount, 1));

  console.log('Customer service figures');
  const csos = await csoCards(MONTH, [O1.id, O2.id]);
  const o1 = csos.find((c) => c.userId === O1.id);
  const o2 = csos.find((c) => c.userId === O2.id);
  await check('O1 payment calls 3 (verifications excluded)', () => assert.strictEqual(line(o1, 'CALLS_MADE').value, 3));
  await check('O1 reach rate 66.67% (2 of 3 answered)', () => assert.strictEqual(line(o1, 'REACH_RATE').value, 66.67));
  await check('O1 customers paid after call 1 (Y)', () => assert.strictEqual(line(o1, 'CUSTOMERS_PAID_AFTER_CALL').value, 1));
  await check('O1 collected after calls 300 — X’s payment went to the later caller', () => assert.strictEqual(line(o1, 'COLLECTED_AFTER_CALL').value, 300));
  await check('O1 conversion 33.33% (1 of 3)', () => assert.strictEqual(line(o1, 'CALL_CONVERSION').value, 33.33));
  await check('O1 promises kept 50% (Y kept, Z broken)', () => assert.strictEqual(line(o1, 'PROMISES_KEPT').value, 50));
  await check('O1 follow-ups on time 50% (Y paid first, Z missed)', () => assert.strictEqual(line(o1, 'FOLLOW_UPS_ON_TIME').value, 50));
  await check('O1 verifications 1 — the unanswered "verified" call is not counted', () => assert.strictEqual(line(o1, 'VERIFICATIONS_DONE').value, 1));
  await check('O1 collection rate of covered agent 75%', () => assert.strictEqual(line(o1, 'PORTFOLIO_COLLECTION_RATE').value, 75));
  await check('O2 collected 350 (X 200 + W 150 paid in October after a September call)', () => assert.strictEqual(line(o2, 'COLLECTED_AFTER_CALL').value, 350));
  await check('O2 conversion 100%', () => assert.strictEqual(line(o2, 'CALL_CONVERSION').value, 100));
  await check('O2 no promises → not measured', () => assert.strictEqual(line(o2, 'PROMISES_KEPT').value, null));
  await check('O2 covers no agents → not measured', () => assert.strictEqual(line(o2, 'PORTFOLIO_COLLECTION_RATE').value, null));

  console.log('Targets and status');
  await setTargets('AGENT', [validateTarget('AGENT', 'COLLECTIONS', 500), validateTarget('AGENT', 'COLLECTION_RATE', 80), validateTarget('AGENT', 'PAR30', 10)], L1.id);
  await setTargets('CSO', [validateTarget('CSO', 'CALL_CONVERSION', 50)], L1.id);
  const [a1t] = await sellerCards(MONTH, [A1.id]);
  const [l1t] = await sellerCards(MONTH, [L1.id]);
  const [o1t, o2t] = await csoCards(MONTH, [O1.id, O2.id]);
  await check('600 against 500 → met', () => assert.strictEqual(line(a1t, 'COLLECTIONS').status, 'MET'));
  await check('75% against 80% → near', () => assert.strictEqual(line(a1t, 'COLLECTION_RATE').status, 'NEAR'));
  await check('PAR target on a past month → not measured', () => assert.strictEqual(line(a1t, 'PAR30').status, 'NOT_MEASURED'));
  await check('leader own 300 against 500 → below (month over, no pro-rating)', () => assert.strictEqual(line(l1t, 'COLLECTIONS').status, 'BELOW'));
  await check('agent score 75% (1 met + 1 near of 2)', () => assert.strictEqual(a1t.score.percent, 75));
  await check('conversion 33% vs 50% → below; 100% → met', () => {
    const one = o1t.userId === O1.id ? o1t : o2t;
    const two = one === o1t ? o2t : o1t;
    assert.strictEqual(line(one, 'CALL_CONVERSION').status, 'BELOW');
    assert.strictEqual(line(two, 'CALL_CONVERSION').status, 'MET');
  });
  await check('a null target removes it', async () => {
    await setTargets('CSO', [validateTarget('CSO', 'CALL_CONVERSION', null)], L1.id);
    assert.strictEqual(await prisma.kpiTarget.count({ where: { group: 'CSO' } }), 0);
  });

  console.log('Mid-month judging (pure)');
  const half = { inProgress: true, elapsed: 0.5 };
  const cum = { higherIsBetter: true, cumulative: true };
  await check('55 of 100 at half way → on track, expected 50', () => assert.deepStrictEqual(judge(cum, 55, 100, half), { status: 'ON_TRACK', expected: 50 }));
  await check('46 at half way → near', () => assert.strictEqual(judge(cum, 46, 100, half).status, 'NEAR'));
  await check('30 at half way → below', () => assert.strictEqual(judge(cum, 30, 100, half).status, 'BELOW'));
  await check('rates are not pro-rated: 72% vs 80% → near', () => assert.strictEqual(judge({ higherIsBetter: true, cumulative: false }, 72, 80, half).status, 'NEAR'));
  await check('lower is better: 9 / 10.5 / 12 vs 10', () => {
    const low = { higherIsBetter: false, cumulative: false };
    assert.strictEqual(judge(low, 9, 10, half).status, 'MET');
    assert.strictEqual(judge(low, 10.5, 10, half).status, 'NEAR');
    assert.strictEqual(judge(low, 12, 10, half).status, 'BELOW');
  });
  await check('target validation', () => {
    assert.throws(() => validateTarget('AGENT', 'COLLECTION_RATE', 120), /above 100/);
    assert.throws(() => validateTarget('AGENT', 'COLLECTIONS', -1), /0 or more/);
    assert.throws(() => validateTarget('AGENT', 'NEW_CONTRACTS', 2.5), /whole number/);
    assert.throws(() => validateTarget('AGENT', 'NOPE', 1), /Unknown KPI/);
    assert.throws(() => validateTarget('CSO', 'COLLECTIONS', 1), /Unknown KPI/);
  });

  console.log('Who sees what');
  const agentUser = { id: A1.id, role: 'AGENT' };
  const leaderUser = { id: L1.id, role: 'CLUSTER_AGENT', permissions: ['VIEW_ASSIGNED_CONTRACTS'] };
  const csoUser = { id: O1.id, role: 'CUSTOMER_SERVICE' };
  const admin = { id: L1.id, role: 'ADMIN', permissions: ['VIEW_REPORTS'] };
  await check('agent /me → own card only', async () => {
    const r = await call(getMyKpis, agentUser, { month: MONTH });
    assert.strictEqual(r.body.kind, 'AGENT');
    assert.strictEqual(r.body.own.userId, A1.id);
  });
  await check('leader /me → own, team and their agents', async () => {
    const r = await call(getMyKpis, leaderUser, { month: MONTH });
    assert.strictEqual(r.body.kind, 'CLUSTER');
    assert.strictEqual(r.body.own.userId, L1.id);
    assert.strictEqual(r.body.team.userId, L1.id);
    assert.deepStrictEqual(r.body.agents.map((a: KpiCard) => a.userId), [A1.id]);
  });
  await check('officer /me → CSO card', async () => {
    const r = await call(getMyKpis, csoUser, { month: MONTH });
    assert.strictEqual(r.body.kind, 'CSO');
    assert.strictEqual(line(r.body.own, 'COLLECTED_AFTER_CALL').value, 300);
  });
  await check('agent cannot list other people', async () => assert.strictEqual((await call(getPeopleKpis, agentUser, { group: 'AGENT', month: MONTH })).status, 403));
  await check('leader lists only their own agents', async () => {
    const r = await call(getPeopleKpis, leaderUser, { group: 'AGENT', month: MONTH });
    assert.deepStrictEqual(r.body.people.map((p: KpiCard) => p.userId), [A1.id]);
  });
  await check('leader cannot list officers', async () => assert.strictEqual((await call(getPeopleKpis, leaderUser, { group: 'CSO', month: MONTH })).status, 403));
  await check('admin lists every officer', async () => {
    const r = await call(getPeopleKpis, admin, { group: 'CSO', month: MONTH });
    const ids = r.body.people.map((p: KpiCard) => p.userId);
    assert.ok(ids.includes(O1.id) && ids.includes(O2.id));
  });
  await check('only MANAGE_SETTINGS sets targets', async () => {
    assert.strictEqual((await call(putKpiTargets, admin, {}, { group: 'AGENT', targets: [{ key: 'COLLECTIONS', target: 1 }] })).status, 403);
    const ok = await call(putKpiTargets, { id: L1.id, role: 'ADMIN', permissions: ['MANAGE_SETTINGS'] }, {}, { group: 'AGENT', targets: [{ key: 'COLLECTIONS', target: 1000 }] });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.targets.AGENT.COLLECTIONS, 1000);
  });
  await check('a future month is refused', async () => assert.strictEqual((await call(getMyKpis, agentUser, { month: '2030-01' })).status, 400));

  await prisma.kpiTarget.deleteMany({});
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures ? 1 : 0);
  });
