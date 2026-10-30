import prisma from '../../config/database';
import { IndicatorKey } from '../clusterScorecard/definitions';
import { MonthRange, measureCollectionRate } from '../clusterScorecard/indicators';
import { Measured, ratioOf, emptyAcc, Acc } from './agent';
import { PAID_AFTER_CALL_DAYS, PAYMENT_CALL_PURPOSES, REACHED_OUTCOMES } from './definitions';

/**
 * A customer service officer's KPIs for a month, from the call log.
 *
 * The heart of it is crediting payments to calls. A payment counts for the most
 * recent payment call to that customer in the PAID_AFTER_CALL_DAYS before it,
 * whoever made the call — so when two officers chase the same customer the
 * money is counted once, for the officer who spoke to them last. A call made
 * on the 30th that is paid on the 2nd belongs to the month of the call, so a
 * month's figures can still rise for a week after it ends.
 *
 * Calls are matched to customers, not contracts: a customer chased about one
 * contract who pays another has still paid.
 */

const DAY_MS = 86_400_000;
const WINDOW_MS = PAID_AFTER_CALL_DAYS * DAY_MS;

function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

interface PaymentRow {
  customerId: string;
  amount: number;
  at: Date;
}

/**
 * Successful payments by these customers in [from, to]. A payment is dated at
 * the later of its payment date and when it was recorded: a cash payment typed
 * in after a call must not look as if it came before it, and a Mobile Money
 * prompt is recorded before it is paid.
 */
async function paymentsFor(customerIds: string[], from: Date, to: Date): Promise<PaymentRow[]> {
  if (!customerIds.length || to <= from) return [];
  const rows = await prisma.paymentTransaction.findMany({
    where: {
      status: 'SUCCESS',
      customerId_uuid: { in: customerIds },
      OR: [{ paymentDate: { gte: from, lte: to } }, { createdAt: { gte: from, lte: to } }],
    },
    select: { customerId_uuid: true, amount: true, paymentDate: true, createdAt: true },
  });
  return rows
    .map((p) => ({
      customerId: p.customerId_uuid,
      amount: p.amount,
      at: p.paymentDate && p.paymentDate > p.createdAt ? p.paymentDate : p.createdAt,
    }))
    .filter((p) => p.at >= from && p.at <= to);
}

function byCustomer<T extends { customerId: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.customerId);
    if (list) list.push(r);
    else m.set(r.customerId, [r]);
  }
  return m;
}

export async function computeCsoKpis(range: MonthRange, officerIds: string[]): Promise<Map<string, Record<string, Measured>>> {
  const result = new Map<string, Record<string, Measured>>();
  if (!officerIds.length) return result;

  const now = new Date();
  const asOf = now < range.to ? now : range.to;
  const officers = new Set(officerIds);

  const [calls, promises, followUps, verifications, assignments] = await Promise.all([
    prisma.contactAttempt.findMany({
      where: { officerId: { in: officerIds }, purpose: { in: PAYMENT_CALL_PURPOSES }, contactedAt: { gte: range.from, lt: range.to } },
      select: { officerId: true, customerId_uuid: true, outcome: true },
    }),
    // A promise belongs to the month it falls due, whenever it was made.
    prisma.contactAttempt.findMany({
      where: { officerId: { in: officerIds }, outcome: 'PROMISE_TO_PAY', promiseToPayDate: { gte: range.from, lt: range.to } },
      select: { officerId: true, customerId_uuid: true, contactedAt: true, promiseToPayDate: true, promiseToPayAmount: true },
    }),
    prisma.contactAttempt.findMany({
      where: { officerId: { in: officerIds }, nextFollowUpAt: { gte: range.from, lt: range.to } },
      select: { officerId: true, customerId_uuid: true, contactedAt: true, nextFollowUpAt: true },
    }),
    // Spoken to and given a result. A call the customer never answered is not
    // a verification, whatever result was recorded against it.
    prisma.contactAttempt.findMany({
      where: {
        officerId: { in: officerIds },
        purpose: 'VERIFICATION',
        verificationResult: { not: null },
        outcome: { in: REACHED_OUTCOMES },
        contactedAt: { gte: range.from, lt: range.to },
      },
      select: { officerId: true, contractId: true, customerId_uuid: true },
    }),
    prisma.csoAgentAssignment.findMany({ where: { csoId: { in: officerIds } }, select: { csoId: true, agentId: true } }),
  ]);

  // ── Calls and reach ──────────────────────────────────────────────────────
  const callCount = new Map<string, number>();
  const reached = new Map<string, number>();
  const called = new Map<string, Set<string>>();
  for (const c of calls) {
    callCount.set(c.officerId, (callCount.get(c.officerId) ?? 0) + 1);
    if (REACHED_OUTCOMES.includes(c.outcome)) reached.set(c.officerId, (reached.get(c.officerId) ?? 0) + 1);
    let s = called.get(c.officerId);
    if (!s) called.set(c.officerId, (s = new Set()));
    s.add(c.customerId_uuid);
  }

  // ── Payments credited to calls ───────────────────────────────────────────
  const calledCustomers = [...new Set(calls.map((c) => c.customerId_uuid))];
  const paidAfter = new Map<string, Set<string>>();
  const collected = new Map<string, number>();
  if (calledCustomers.length) {
    const paidUntil = new Date(Math.min(range.to.getTime() + WINDOW_MS, now.getTime()));
    const [everyCall, payments] = await Promise.all([
      // Every officer's calls, so a later call by a colleague takes the credit.
      prisma.contactAttempt.findMany({
        where: {
          customerId_uuid: { in: calledCustomers },
          purpose: { in: PAYMENT_CALL_PURPOSES },
          contactedAt: { gte: new Date(range.from.getTime() - WINDOW_MS), lte: paidUntil },
        },
        select: { officerId: true, customerId_uuid: true, contactedAt: true },
        orderBy: { contactedAt: 'asc' },
      }),
      paymentsFor(calledCustomers, range.from, paidUntil),
    ]);
    const callsByCustomer = byCustomer(everyCall.map((c) => ({ ...c, customerId: c.customerId_uuid })));
    for (const p of payments) {
      const list = callsByCustomer.get(p.customerId) || [];
      let last: (typeof list)[number] | undefined;
      for (const c of list) {
        if (c.contactedAt > p.at) break;
        last = c;
      }
      if (!last || p.at.getTime() - last.contactedAt.getTime() > WINDOW_MS) continue;
      // Credited to a call in another month, or by someone not being measured.
      if (last.contactedAt < range.from || last.contactedAt >= range.to || !officers.has(last.officerId)) continue;
      collected.set(last.officerId, (collected.get(last.officerId) ?? 0) + p.amount);
      let s = paidAfter.get(last.officerId);
      if (!s) paidAfter.set(last.officerId, (s = new Set()));
      s.add(p.customerId);
    }
  }

  // ── Promises to pay ──────────────────────────────────────────────────────
  const promiseAcc = new Map<string, Acc>();
  const duePromises = promises.filter((p) => p.promiseToPayDate && endOfDay(p.promiseToPayDate) < now);
  if (duePromises.length) {
    const from = new Date(Math.min(...duePromises.map((p) => p.contactedAt.getTime())));
    const to = new Date(Math.max(...duePromises.map((p) => endOfDay(p.promiseToPayDate!).getTime())));
    const pays = byCustomer(await paymentsFor([...new Set(duePromises.map((p) => p.customerId_uuid))], from, to));
    for (const p of duePromises) {
      const deadline = endOfDay(p.promiseToPayDate!);
      const paid = (pays.get(p.customerId_uuid) || [])
        .filter((x) => x.at >= p.contactedAt && x.at <= deadline)
        .reduce((s, x) => s + x.amount, 0);
      const promised = p.promiseToPayAmount && p.promiseToPayAmount > 0 ? p.promiseToPayAmount : 0.01;
      const a = promiseAcc.get(p.officerId) ?? emptyAcc();
      a.count += 1;
      a.denominator += 1;
      if (paid + 0.005 >= promised) a.numerator += 1;
      promiseAcc.set(p.officerId, a);
    }
  }

  // ── Follow-ups ───────────────────────────────────────────────────────────
  // Due on nextFollowUpAt; on time if anyone called the customer again by the
  // end of the next day, or the customer paid first and no call was needed.
  const followAcc = new Map<string, Acc>();
  const dueFollowUps = followUps
    .map((f) => ({ ...f, deadline: new Date(endOfDay(f.nextFollowUpAt!).getTime() + DAY_MS) }))
    .filter((f) => f.deadline < now);
  if (dueFollowUps.length) {
    const customers = [...new Set(dueFollowUps.map((f) => f.customerId_uuid))];
    const from = new Date(Math.min(...dueFollowUps.map((f) => f.contactedAt.getTime())));
    const to = new Date(Math.max(...dueFollowUps.map((f) => f.deadline.getTime())));
    const [later, pays] = await Promise.all([
      prisma.contactAttempt.findMany({
        where: { customerId_uuid: { in: customers }, contactedAt: { gt: from, lte: to } },
        select: { customerId_uuid: true, contactedAt: true },
      }),
      paymentsFor(customers, from, to),
    ]);
    const laterBy = byCustomer(later.map((c) => ({ customerId: c.customerId_uuid, at: c.contactedAt })));
    const paysBy = byCustomer(pays);
    for (const f of dueFollowUps) {
      const inWindow = (x: { at: Date }) => x.at > f.contactedAt && x.at <= f.deadline;
      const done = (laterBy.get(f.customerId_uuid) || []).some(inWindow) || (paysBy.get(f.customerId_uuid) || []).some(inWindow);
      const a = followAcc.get(f.officerId) ?? emptyAcc();
      a.count += 1;
      a.denominator += 1;
      if (done) a.numerator += 1;
      followAcc.set(f.officerId, a);
    }
  }

  // ── Verifications ────────────────────────────────────────────────────────
  const verified = new Map<string, Set<string>>();
  for (const v of verifications) {
    let s = verified.get(v.officerId);
    if (!s) verified.set(v.officerId, (s = new Set()));
    s.add(v.contractId ?? `customer:${v.customerId_uuid}`);
  }

  // ── Collection rate across the agents each officer covers ────────────────
  const agentRate = new Map<string, Acc>();
  const coveredAgents = [...new Set(assignments.map((a) => a.agentId))];
  if (coveredAgents.length) {
    const agents = new Set(coveredAgents);
    await measureCollectionRate(range, asOf, coveredAgents, (agentId) => agentId, (agentId: string | null, _key: IndicatorKey, sum: number, count = 1, extra?: Record<string, number>) => {
      if (!agentId || !agents.has(agentId)) return;
      const a = agentRate.get(agentId) ?? emptyAcc();
      a.sum += sum;
      a.count += count;
      a.numerator += extra?.numerator ?? 0;
      a.denominator += extra?.denominator ?? 0;
      agentRate.set(agentId, a);
    });
  }
  const portfolio = new Map<string, Acc>();
  for (const { csoId, agentId } of assignments) {
    const r = agentRate.get(agentId);
    if (!r) continue;
    const a = portfolio.get(csoId) ?? emptyAcc();
    a.count += r.count;
    a.numerator += r.numerator;
    a.denominator += r.denominator;
    portfolio.set(csoId, a);
  }

  for (const id of officerIds) {
    const made = callCount.get(id) ?? 0;
    const customers = called.get(id)?.size ?? 0;
    const paid = paidAfter.get(id)?.size ?? 0;
    result.set(id, {
      CALLS_MADE: { value: made, count: made },
      CUSTOMERS_CALLED: { value: customers, count: customers },
      REACH_RATE: { value: made ? Math.round(((reached.get(id) ?? 0) / made) * 10000) / 100 : null, count: made },
      CUSTOMERS_PAID_AFTER_CALL: { value: paid, count: paid },
      CALL_CONVERSION: { value: customers ? Math.round((paid / customers) * 10000) / 100 : null, count: customers },
      COLLECTED_AFTER_CALL: { value: Math.round((collected.get(id) ?? 0) * 100) / 100, count: paid },
      PROMISES_KEPT: { value: ratioOf(promiseAcc.get(id)), count: promiseAcc.get(id)?.count ?? 0 },
      FOLLOW_UPS_ON_TIME: { value: ratioOf(followAcc.get(id)), count: followAcc.get(id)?.count ?? 0 },
      VERIFICATIONS_DONE: { value: verified.get(id)?.size ?? 0, count: verified.get(id)?.size ?? 0 },
      PORTFOLIO_COLLECTION_RATE: { value: ratioOf(portfolio.get(id)), count: portfolio.get(id)?.count ?? 0 },
    });
  }
  return result;
}
