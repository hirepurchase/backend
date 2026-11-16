import prisma from '../../config/database';
import { liveActionsEnabled } from './config';
import { isNoRetryError } from './errors';
import { enqueue } from './events';
import { syncUnlinkedMessage } from './reconcile';

/**
 * Pick up PayTrigger commands that failed or stalled, every five minutes.
 *
 * runCommand retries in-process at +30s, +2m and +10m, then gives up. Those
 * retries are timers in the running server, so a deploy or restart loses them,
 * and a failure that lasts longer than ten minutes (an IP not yet on
 * PayTrigger's allow-list, an outage) used to wait for the 08:36 sweep. A
 * customer who paid during one stayed locked for up to a day.
 *
 * This does not resend the stored command: it re-judges the contract, so what
 * goes out is what the contract says now. A row the re-judging did not need
 * (the phone was already brought in line some other way) is closed off, so it
 * is never picked up again.
 *
 * Lock dates, locks and lock-screen text only. Enrolment, cancellation and
 * release are left to the sweep and to admins: release cannot be undone.
 */

const RETRYABLE_TYPES = ['EXTEND', 'LOCK', 'SYNC'];
/** Let the in-process timer have its turn before this job steps in. */
const IN_PROCESS_GRACE_MS = 60_000;
/** A send still "in progress" this long ago was cut off by a restart. */
const STALE_PROCESSING_MS = 10 * 60_000;
/** After a day the contract has been through the sweep; stop retrying the old row. */
const GIVE_UP_AFTER_MS = 24 * 3600_000;
/** Backoff for rows past the in-process retries: 5, 10, 20, 40, then every 60 minutes. */
const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** In-process retries already spent before this job takes over. */
const IN_PROCESS_ATTEMPTS = 4;
/** Devices handled per run, so one bad run cannot flood PayTrigger. */
const MAX_DEVICES_PER_RUN = 50;

export interface RetrySummary {
  devices: number;
  closed: number;
  abandoned: number;
}

type Row = { id: string; deviceId: string; status: string; attempts: number; nextAttemptAt: Date | null; lastError: string | null; updatedAt: Date };

/** Is this row due for another go now? Exported for the tests. */
export function isDue(row: Row, now: Date): boolean {
  const t = now.getTime();
  if (row.status === 'PENDING') return !row.nextAttemptAt || row.nextAttemptAt.getTime() <= t - IN_PROCESS_GRACE_MS;
  if (row.status === 'PROCESSING') return row.updatedAt.getTime() <= t - STALE_PROCESSING_MS;
  if (row.status === 'FAILED') {
    if (isNoRetryError(row.lastError)) return false;
    const wait = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, row.attempts - IN_PROCESS_ATTEMPTS));
    return row.updatedAt.getTime() <= t - wait;
  }
  return false;
}

export async function retryStalledCommands(now: Date = new Date()): Promise<RetrySummary> {
  const summary: RetrySummary = { devices: 0, closed: 0, abandoned: 0 };
  // In dry run nothing is really sent, so nothing really fails.
  if (!liveActionsEnabled()) return summary;

  const cutoff = new Date(now.getTime() - GIVE_UP_AFTER_MS);

  // Rows left waiting for longer than a day: the in-process retry was lost and
  // the sweep has judged the contract since. Close them; their error stays.
  const abandoned = await prisma.payTriggerCommand.updateMany({
    where: { type: { in: RETRYABLE_TYPES }, status: { in: ['PENDING', 'PROCESSING'] }, updatedAt: { lt: cutoff } },
    data: { status: 'CANCELLED', nextAttemptAt: null },
  });
  summary.abandoned = abandoned.count;

  const rows: Row[] = await prisma.payTriggerCommand.findMany({
    where: { type: { in: RETRYABLE_TYPES }, status: { in: ['PENDING', 'PROCESSING', 'FAILED'] }, updatedAt: { gte: cutoff } },
    select: { id: true, deviceId: true, status: true, attempts: true, nextAttemptAt: true, lastError: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });
  const due = rows.filter((row) => isDue(row, now));
  if (!due.length) return summary;

  const byDevice = new Map<string, Row[]>();
  for (const row of due) byDevice.set(row.deviceId, [...(byDevice.get(row.deviceId) ?? []), row]);

  for (const [deviceId, deviceRows] of [...byDevice.entries()].slice(0, MAX_DEVICES_PER_RUN)) {
    try {
      const device = await prisma.payTriggerDevice.findUnique({
        where: { id: deviceId },
        select: { id: true, contractId: true, enrollmentStatus: true },
      });
      if (!device || !['ACTIVE', 'UNENFORCEABLE'].includes(device.enrollmentStatus)) {
        summary.closed += await closeUntouched(deviceRows, 'Not retried: the phone is no longer active on PayTrigger.');
        continue;
      }

      summary.devices++;
      if (device.contractId) await enqueue(device.contractId, 'RETRY');
      else await syncUnlinkedMessage(device.id);

      summary.closed += await closeUntouched(deviceRows, `Superseded: re-checked ${now.toISOString()}, nothing further to send for this row.`);
    } catch (err) {
      console.error('PayTrigger retry: device failed', deviceId, err);
    }
  }
  return summary;
}

/**
 * Rows the re-check did not touch were overtaken: the decision changed (so a
 * new row was written) or the phone was already in line. Close them off.
 */
async function closeUntouched(rows: Row[], note: string): Promise<number> {
  let closed = 0;
  for (const row of rows) {
    const res = await prisma.payTriggerCommand.updateMany({
      where: { id: row.id, status: row.status, updatedAt: row.updatedAt },
      data: { status: 'CANCELLED', nextAttemptAt: null, lastError: `${row.lastError ? `${row.lastError} — ` : ''}${note}`.slice(0, 1000) },
    });
    closed += res.count;
  }
  return closed;
}
