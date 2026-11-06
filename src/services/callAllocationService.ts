import * as crypto from 'crypto';
import cron from 'node-cron';
import prisma from '../config/database';
import { CUSTOMER_SERVICE_ROLE } from '../constants/roles';
import { buildCallRows } from './callQueueService';
import { enqueueSingletonJob } from './backgroundJobService';

/**
 * Each morning's recovery and reminder calls, shared among customer service.
 *
 * At 08:20 — after overdue marking (08:00), unlock expiry (08:05) and
 * penalties (08:15) — everyone who needs a call today is listed once:
 *
 *   RECOVERY   behind on an active contract, or a phone in the wrong lock state
 *   PROMISE    promised to pay today            ┐ back to the officer who
 *   FOLLOW_UP  a follow-up was set for today    ┘ arranged it, if still here
 *   REMINDER   a weekly or monthly instalment due today or tomorrow
 *
 * Promises and follow-ups go to whoever arranged them, so the customer hears
 * from the same person. Everyone else is shuffled and dealt so every active
 * customer service account ends up with the same number of calls. Each list
 * keeps the order the calls matter in. A day is shared once; running again
 * changes nothing. An administrator can reshare the calls not yet made among
 * the officers who are in, for absences.
 */

export type AllocationKind = 'RECOVERY' | 'REMINDER' | 'PROMISE' | 'FOLLOW_UP';

/** When the morning share runs; before this, the previous share is still the working list. */
export const SHARE_HOUR = 8;
export const SHARE_MINUTE = 20;
const DAY_MS = 86_400_000;

export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Active customer service accounts — who the calls are shared among. */
export async function customerServiceOfficerIds(): Promise<string[]> {
  const rows = await prisma.adminUser.findMany({ where: { isActive: true, role: { name: CUSTOMER_SERVICE_ROLE } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => r.id);
}

interface Candidate {
  customerUuid: string;
  kind: AllocationKind;
  reason: string | null;
  /** Set for promises and follow-ups: who arranged them. */
  pinnedTo?: string;
}

/** Everyone who needs a call today, in the order the calls matter. */
export async function callCandidates(now = new Date(), officers: Set<string> = new Set()): Promise<Candidate[]> {
  const today = startOfDay(now);
  const tomorrowEnd = new Date(today.getTime() + 2 * DAY_MS);

  const recoveryRows = await buildCallRows({}, () => true);
  const recoveries: Candidate[] = recoveryRows
    .filter((r) => r.customer.uuid)
    .map((r) => ({
      customerUuid: r.customer.uuid,
      kind: 'RECOVERY' as const,
      reason: r.urgentReason ?? (r.daysOverdue ? `${r.daysOverdue} day${r.daysOverdue === 1 ? '' : 's'} overdue · GHS ${round2(r.amountOverdue).toFixed(2)}` : null),
      urgent: r.isUrgent,
    }));

  // Promises to pay today and follow-ups set for today — the latest call per customer decides.
  const arranged = await prisma.contactAttempt.findMany({
    where: {
      OR: [
        { promiseToPayDate: { gte: today, lt: new Date(today.getTime() + DAY_MS) } },
        { nextFollowUpAt: { gte: today, lt: new Date(today.getTime() + DAY_MS) } },
      ],
    },
    orderBy: { contactedAt: 'desc' },
    select: { customerId_uuid: true, officerId: true, promiseToPayDate: true, promiseToPayAmount: true },
  });
  const pinned = new Map<string, Candidate>();
  for (const a of arranged) {
    if (pinned.has(a.customerId_uuid)) continue;
    const isPromise = !!a.promiseToPayDate && a.promiseToPayDate >= today && a.promiseToPayDate < new Date(today.getTime() + DAY_MS);
    pinned.set(a.customerId_uuid, {
      customerUuid: a.customerId_uuid,
      kind: isPromise ? 'PROMISE' : 'FOLLOW_UP',
      reason: isPromise
        ? `Promised to pay today${a.promiseToPayAmount ? ` · GHS ${round2(a.promiseToPayAmount).toFixed(2)}` : ''}`
        : 'Follow-up set for today',
      pinnedTo: officers.has(a.officerId) ? a.officerId : undefined,
    });
  }

  // Reminders: weekly and monthly payers with an instalment due today or tomorrow.
  const dueSoon = await prisma.installmentSchedule.findMany({
    where: {
      status: { in: ['PENDING', 'PARTIAL'] },
      dueDate: { gte: today, lt: tomorrowEnd },
      contract: { status: 'ACTIVE', paymentFrequency: { in: ['WEEKLY', 'MONTHLY'] } },
    },
    orderBy: { dueDate: 'asc' },
    select: { dueDate: true, amount: true, paidAmount: true, contract: { select: { customerId_uuid: true } } },
  });

  // Order: urgent recoveries, then promises and follow-ups, then other
  // recoveries (longest overdue first), then reminders. Each customer once.
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate) => {
    if (seen.has(c.customerUuid)) return;
    seen.add(c.customerUuid);
    out.push(c);
  };
  for (const r of recoveries) if ((r as any).urgent && !pinned.has(r.customerUuid)) push(r);
  for (const p of pinned.values()) push(p);
  for (const r of recoveries) push(r);
  for (const d of dueSoon) {
    const isToday = d.dueDate < new Date(today.getTime() + DAY_MS);
    push({
      customerUuid: d.contract.customerId_uuid,
      kind: 'REMINDER',
      reason: `Payment of GHS ${round2(d.amount - d.paidAmount).toFixed(2)} due ${isToday ? 'today' : 'tomorrow'}`,
    });
  }
  return out;
}

/** Deal calls so totals stay even, at random among those with the fewest. */
function deal(officers: string[], start: Map<string, number>): () => string {
  const load = new Map(officers.map((o) => [o, start.get(o) ?? 0]));
  return () => {
    const least = Math.min(...load.values());
    const tied = officers.filter((o) => load.get(o) === least);
    const pick = tied[crypto.randomInt(tied.length)];
    load.set(pick, (load.get(pick) ?? 0) + 1);
    return pick;
  };
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface ShareSummary {
  day: string;
  created: number;
  total: number;
  officers: number;
  alreadyShared: boolean;
}

/** Share out today's calls. Runs once a day; a second run changes nothing. */
export async function shareDay(now = new Date()): Promise<ShareSummary> {
  const day = dayKey(now);
  const existing = await prisma.callAllocation.count({ where: { day } });
  const officers = await customerServiceOfficerIds();
  if (existing > 0) return { day, created: 0, total: existing, officers: officers.length, alreadyShared: true };
  if (!officers.length) return { day, created: 0, total: 0, officers: 0, alreadyShared: false };

  const candidates = await callCandidates(now, new Set(officers));
  const pinnedCount = new Map<string, number>();
  for (const c of candidates) if (c.pinnedTo) pinnedCount.set(c.pinnedTo, (pinnedCount.get(c.pinnedTo) ?? 0) + 1);
  const next = deal(officers, pinnedCount);

  // Who gets each unpinned call is random; the order calls are listed in is not.
  const officerFor = new Map<string, string>();
  for (const c of shuffle(candidates.filter((c) => !c.pinnedTo))) officerFor.set(c.customerUuid, next());

  const rows = candidates.map((c, priority) => ({
    day,
    customerId_uuid: c.customerUuid,
    officerId: c.pinnedTo ?? officerFor.get(c.customerUuid)!,
    kind: c.kind,
    priority,
    reason: c.reason,
  }));
  let created = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    created += (await prisma.callAllocation.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true })).count;
  }
  return { day, created, total: created, officers: officers.length, alreadyShared: false };
}

/** The call did not reach the customer, so it stays on the list to try again. */
const RETRY_OUTCOMES = ['NO_ANSWER', 'UNREACHABLE'];

/**
 * The latest outcome today for each customer someone has called (a welcome
 * call does not count). A customer with no entry has not been called today.
 */
async function callsToday(customerUuids: string[], now: Date): Promise<Map<string, string>> {
  if (!customerUuids.length) return new Map();
  const rows = await prisma.contactAttempt.findMany({
    where: { customerId_uuid: { in: customerUuids }, contactedAt: { gte: startOfDay(now) }, purpose: { not: 'VERIFICATION' } },
    select: { customerId_uuid: true, outcome: true },
    orderBy: { contactedAt: 'asc' },
  });
  return new Map(rows.map((r) => [r.customerId_uuid, r.outcome]));
}

/**
 * The share an officer is working from now: today's once it has run, and
 * before 08:20 the most recent earlier one (so the list is never empty while
 * the morning jobs are still marking what is overdue).
 */
export async function workingDay(now = new Date()): Promise<string | null> {
  const today = dayKey(now);
  if (await prisma.callAllocation.findFirst({ where: { day: today }, select: { id: true } })) return today;
  const beforeShare = now.getHours() < SHARE_HOUR || (now.getHours() === SHARE_HOUR && now.getMinutes() < SHARE_MINUTE);
  if (!beforeShare) {
    await shareDay(now);
    return today;
  }
  const last = await prisma.callAllocation.findFirst({ where: { day: { lt: today } }, orderBy: { day: 'desc' }, select: { day: true } });
  return last?.day ?? null;
}

/** Is this customer on the officer's current call list? False on any error. */
export async function isSharedTo(officerId: string, customerUuid: string, now = new Date()): Promise<boolean> {
  try {
    const day = await workingDayIfShared(now);
    if (!day) return false;
    return !!(await prisma.callAllocation.findFirst({ where: { day, officerId, customerId_uuid: customerUuid }, select: { id: true } }));
  } catch {
    return false;
  }
}

/** As workingDay, but never shares a day as a side effect. */
async function workingDayIfShared(now: Date): Promise<string | null> {
  const today = dayKey(now);
  if (await prisma.callAllocation.findFirst({ where: { day: today }, select: { id: true } })) return today;
  const last = await prisma.callAllocation.findFirst({ where: { day: { lt: today } }, orderBy: { day: 'desc' }, select: { day: true } });
  return last?.day ?? null;
}

/** One officer's calls for the working day, in priority order, with whether each has been made. */
export async function officerAllocations(officerId: string, now = new Date()) {
  const day = await workingDay(now);
  if (!day) return { day: null, allocations: [] as Array<{ customerUuid: string; kind: string; reason: string | null; priority: number; called: boolean; retry: boolean }> };
  const rows = await prisma.callAllocation.findMany({ where: { day, officerId }, orderBy: { priority: 'asc' } });
  const calls = await callsToday(rows.map((r) => r.customerId_uuid), now);
  return {
    day,
    allocations: rows.map((r) => {
      const outcome = calls.get(r.customerId_uuid);
      return {
        customerUuid: r.customerId_uuid,
        kind: r.kind,
        reason: r.reason,
        priority: r.priority,
        called: outcome !== undefined,
        retry: !!outcome && RETRY_OUTCOMES.includes(outcome),
      };
    }),
  };
}

/** Per-officer counts for a day, for the admin page. */
export async function daySummary(now = new Date()) {
  const day = await workingDay(now);
  const officers = await prisma.adminUser.findMany({
    where: { isActive: true, role: { name: CUSTOMER_SERVICE_ROLE } },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { firstName: 'asc' },
  });
  if (!day) return { day: null, officers: officers.map((o) => ({ id: o.id, name: `${o.firstName} ${o.lastName}`.trim(), total: 0, called: 0, byKind: {} })) };
  const rows = await prisma.callAllocation.findMany({ where: { day }, select: { officerId: true, kind: true, customerId_uuid: true } });
  const called = await callsToday(rows.map((r) => r.customerId_uuid), now);
  const ids = new Set([...officers.map((o) => o.id), ...rows.map((r) => r.officerId)]);
  const extra = await prisma.adminUser.findMany({ where: { id: { in: [...ids].filter((id) => !officers.some((o) => o.id === id)) } }, select: { id: true, firstName: true, lastName: true } });
  return {
    day,
    officers: [...officers, ...extra].map((o) => {
      const mine = rows.filter((r) => r.officerId === o.id);
      const byKind: Record<string, number> = {};
      for (const r of mine) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      return { id: o.id, name: `${o.firstName} ${o.lastName}`.trim(), total: mine.length, called: mine.filter((r) => called.has(r.customerId_uuid)).length, byKind };
    }),
  };
}

/**
 * Move the calls not yet made by officers who are out to the officers who are in
 * (for absences). Calls already made stay put. Returns how many moved.
 */
export async function reshareDay(officerIds: string[], now = new Date()): Promise<{ day: string | null; moved: number }> {
  const day = await workingDay(now);
  if (!day) return { day, moved: 0 };
  const valid = (await customerServiceOfficerIds()).filter((id) => officerIds.includes(id));
  if (!valid.length) throw new Error('Choose at least one active customer service officer');
  const rows = await prisma.callAllocation.findMany({ where: { day }, select: { id: true, officerId: true, customerId_uuid: true, priority: true } });
  const called = await callsToday(rows.map((r) => r.customerId_uuid), now);
  // Officers who are in keep their lists (and their promises); only the calls
  // not yet made by someone who is out move, to whoever has the fewest.
  const stranded = rows.filter((r) => !valid.includes(r.officerId) && !called.has(r.customerId_uuid));
  const start = new Map<string, number>();
  for (const r of rows) if (valid.includes(r.officerId)) start.set(r.officerId, (start.get(r.officerId) ?? 0) + 1);
  const next = deal(valid, start);
  const moves = shuffle(stranded).map((r) => ({ id: r.id, from: r.officerId, to: next() }));
  for (const m of moves) await prisma.callAllocation.update({ where: { id: m.id }, data: { officerId: m.to } });
  return { day, moved: moves.length };
}

/** One cron job at 08:20, plus a catch-up at start-up if today has not been shared. */
export function startCallAllocationScheduler(): void {
  const run = () => {
    const enqueued = enqueueSingletonJob('customer-service-call-share', async () => {
      try {
        const s = await shareDay();
        console.log(`📞 Call share ${s.day}: ${s.alreadyShared ? 'already shared' : `${s.created} calls among ${s.officers} officers`}`);
      } catch (err) {
        console.error('Call share failed', err);
      }
    });
    if (!enqueued) console.log('⏭️  Call share still running — skipped');
  };
  try {
    cron.schedule(`${SHARE_MINUTE} ${SHARE_HOUR} * * *`, run);
    const now = new Date();
    if (now.getHours() > SHARE_HOUR || (now.getHours() === SHARE_HOUR && now.getMinutes() >= SHARE_MINUTE)) setTimeout(run, 30_000).unref?.();
  } catch (err) {
    console.error('Call share scheduler failed to start', err);
  }
}
