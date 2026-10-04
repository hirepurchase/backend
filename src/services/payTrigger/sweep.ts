import prisma from '../../config/database';
import * as client from './client';
import { runCommand } from './commands';
import { applyLockState, reconcileContract, syncUnlinkedMessage } from './reconcile';
import { refreshTranssionContracts, removeTranssionContract } from './registry';
import { getPayTriggerSettings } from './settings';
import { logAction } from './log';
import { liveActionsEnabled } from './config';
import { enrolItems, liveEnrolmentProof, needsEnrolment } from './admin';
import { ReminderSummary, sendPaymentReminders } from './messages';

/**
 * The 08:36 morning sweep — the only scheduled PayTrigger work.
 *
 * Runs after the morning jobs it depends on (08:00 overdue marking, 08:05
 * temporary-unlock expiry, 08:15 penalties) and Knox's own 08:32 run. It
 * catches anything an event missed, carries out releases that are due, reads
 * status for phones that need confirming, and records that it ran.
 */

const STATUS_READ_MIN_GAP_MS = 20 * 3600_000;
/** The breaker only applies once the book is big enough for a percentage to mean anything. */
const BREAKER_MIN_EXTENSIONS = 5;

export interface SweepSummary {
  startedAt: string;
  finishedAt?: string;
  linked: number;
  reconciled: number;
  sent: number;
  skipped: number;
  errors: number;
  released: number;
  statusReads: number;
  breakerTripped: boolean;
  reEnrolled?: number;
  reminders?: ReminderSummary;
  unlinkedMessages?: number;
}

export async function runMorningSweep(): Promise<SweepSummary> {
  const summary: SweepSummary = {
    startedAt: new Date().toISOString(),
    linked: 0,
    reconciled: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    released: 0,
    statusReads: 0,
    breakerTripped: false,
  };
  const settings = await getPayTriggerSettings();

  // 1. Link devices whose stock item has since been sold.
  const unlinked = await prisma.payTriggerDevice.findMany({
    where: { contractId: null, enrollmentStatus: { in: ['QUEUED', 'ACTIVE'] } },
    select: { id: true, inventoryItemId: true },
  });
  if (unlinked.length) {
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: unlinked.map((d) => d.inventoryItemId) }, contractId: { not: null } },
      select: { id: true, contractId: true },
    });
    for (const item of items) {
      const device = unlinked.find((d) => d.inventoryItemId === item.id);
      if (!device || !item.contractId) continue;
      try {
        await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { contractId: item.contractId } });
        summary.linked++;
      } catch (err) {
        summary.errors++;
        console.error('PayTrigger sweep: link failed', device.id, err);
      }
    }
  }
  await refreshTranssionContracts();

  // 2. Reconcile every live device, with one breaker across the whole run.
  const devices = await prisma.payTriggerDevice.findMany({
    where: { contractId: { not: null }, enrollmentStatus: { in: ['QUEUED', 'ACTIVE', 'UNENFORCEABLE'] } },
    select: { contractId: true },
  });
  const limit = Math.max(BREAKER_MIN_EXTENSIONS, Math.ceil((devices.length * settings.extendBreakerPercent) / 100));
  let extensions = 0;
  const breaker = {
    allowExtend() {
      if (extensions >= limit) {
        summary.breakerTripped = true;
        return false;
      }
      extensions++;
      return true;
    },
  };
  for (const { contractId } of devices) {
    if (!contractId) continue;
    try {
      const outcome = await reconcileContract(contractId, { reasons: ['ADMIN_RECONCILE'], breaker });
      summary.reconciled++;
      if (outcome.sent) summary.sent++;
      else summary.skipped++;
    } catch (err) {
      summary.errors++;
      console.error('PayTrigger sweep: reconcile failed', contractId, err);
    }
  }

  // 2b. Once live: enrolments that were only simulated in dry run (or failed)
  // are sent for real, so no phone is left looking enrolled when it is not.
  summary.reEnrolled = await resendSimulatedEnrolments();

  // 3. Releases due: paid off, hold period over, not stopped by an admin.
  summary.released = await runDueReleases();

  // 4. Status reads for phones near a lock date or waiting on confirmation.
  summary.statusReads = await readStatusesNeeded();

  // 4b. Active phones with no contract: make sure their lock screen says so.
  try {
    summary.unlinkedMessages = 0;
    const loose = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: 'ACTIVE', contractId: null }, select: { id: true } });
    for (const { id } of loose) if (await syncUnlinkedMessage(id)) summary.unlinkedMessages++;
  } catch (err) {
    summary.errors++;
    console.error('PayTrigger sweep: no-contract messages failed', err);
  }

  // 5. Reminders of a payment coming up. Last, and never allowed to fail the sweep.
  try {
    summary.reminders = await sendPaymentReminders();
  } catch (err) {
    summary.errors++;
    console.error('PayTrigger sweep: reminders failed', err);
  }

  summary.finishedAt = new Date().toISOString();
  await prisma.payTriggerSettings.update({
    where: { id: 'singleton' },
    data: { lastSweepAt: new Date(), lastSweepSummary: summary as any },
  });
  return summary;
}

export async function runDueReleases(): Promise<number> {
  const due = await prisma.payTriggerDevice.findMany({
    where: { enrollmentStatus: 'ACTIVE', releaseHeld: false, releaseAfter: { lte: new Date() } },
  });
  let released = 0;
  for (const device of due) {
    // Re-check the contract at the moment of release: removeLock cannot be undone.
    const contract = device.contractId
      ? await prisma.hirePurchaseContract.findUnique({ where: { id: device.contractId }, select: { id: true, contractNumber: true, status: true } })
      : null;
    if (!contract || contract.status !== 'COMPLETED') {
      await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { releaseAfter: null } });
      continue;
    }
    if (await releaseDevice(device, contract, null)) released++;
  }
  return released;
}

/** Permanent removal. Shared by the sweep and the admin release button. */
export async function releaseDevice(
  device: { id: string; imei: string; deviceTag: string | null; contractId: string | null },
  contract: { id: string; contractNumber: string } | null,
  actorId: string | null,
): Promise<boolean> {
  const res = await runCommand({
    device,
    contract,
    type: 'RELEASE',
    fingerprint: 'release',
    payload: { imei: device.imei },
    actorId,
    send: () => client.removeLock(device),
  });
  if (res.status !== 'SUCCEEDED' && res.status !== 'SKIPPED') return false;
  if (res.status === 'SKIPPED' && res.error) return false; // canary
  await prisma.payTriggerDevice.update({
    where: { id: device.id },
    data: { enrollmentStatus: 'REMOVED', committedState: 'UNLOCKED', releaseAfter: null, awaitingPinSince: null, lastError: null },
  });
  if (device.contractId) removeTranssionContract(device.contractId);
  return true;
}

async function readStatusesNeeded(): Promise<number> {
  const now = Date.now();
  const candidates = await prisma.payTriggerDevice.findMany({
    where: {
      enrollmentStatus: { in: ['ACTIVE', 'QUEUED'] },
      OR: [
        { awaitingPinSince: { not: null } },
        { committedState: { in: ['PENDING', 'UNKNOWN'] } },
        { scheduleExpiresAt: { gte: new Date(now - 2 * 86400_000), lte: new Date(now + 86400_000) } },
        { enrollmentStatus: 'QUEUED' },
      ],
    },
    select: { id: true, imei: true, lastStatusReadAt: true, contractId: true, enrollmentStatus: true },
  });
  // At most one read per device per day — far under PayTrigger's 100.
  const toRead = candidates.filter((d) => !d.lastStatusReadAt || now - d.lastStatusReadAt.getTime() > STATUS_READ_MIN_GAP_MS);
  let read = 0;
  for (let i = 0; i < toRead.length; i += 100) {
    const chunk = toRead.slice(i, i + 100);
    const activated: typeof chunk = [];
    const res = await client.batchFindLockState(chunk.map((d) => d.imei));
    await logAction({ action: 'STATUS_READ_BATCH', result: res, response: { count: chunk.length } });
    if (!res.success || res.dryRun || !Array.isArray(res.data)) continue;
    for (const state of res.data) {
      const device = chunk.find((d) => d.imei === state.imei);
      if (!device) continue;
      // A queued phone that has activated without us hearing the callback.
      if (device.enrollmentStatus === 'QUEUED' && state.lockState === 3000) {
        await markActivated(device.id, state);
        activated.push(device);
      }
      await applyLockState(device.id, state);
      read++;
    }
    // A phone that activated without its callback reaching us was locked on
    // activation; bring it in line with its contract now, not tomorrow.
    for (const device of activated) {
      if (!device.contractId) continue;
      try {
        await reconcileContract(device.contractId, { reasons: ['DEVICE_ACTIVATED'] });
      } catch (err) {
        console.error('PayTrigger sweep: reconcile after activation failed', device.contractId, err);
      }
    }
  }
  return read;
}

/** Shared by the activation callback and the sweep. */
export async function markActivated(deviceId: string, state: { deviceTag?: string; activeTime?: number | null }) {
  const device = await prisma.payTriggerDevice.update({
    where: { id: deviceId },
    data: {
      enrollmentStatus: 'ACTIVE',
      deviceTag: state.deviceTag || undefined,
      licenceConsumedAt: state.activeTime ? new Date(state.activeTime * 1000) : new Date(),
    },
  });
  await logAction({ deviceId, contractId: device.contractId, action: 'ACTIVATED', success: true, dryRun: false });
  return device;
}

/** Live mode only: enrol for real every unactivated phone PayTrigger may not hold. */
export async function resendSimulatedEnrolments(): Promise<number> {
  if (!liveActionsEnabled()) return 0;
  const candidates = await prisma.payTriggerDevice.findMany({
    where: { enrollmentStatus: { in: ['QUEUED', 'FAILED'] } },
    select: { id: true, inventoryItemId: true, enrollmentStatus: true },
  });
  const proof = await liveEnrolmentProof(candidates.map((c) => c.id));
  const todo = candidates.filter((c) => needsEnrolment(c, proof)).map((c) => c.inventoryItemId);
  if (!todo.length) return 0;
  let done = 0;
  for (let i = 0; i < todo.length; i += 200) {
    const results = await enrolItems(todo.slice(i, i + 200), 'system');
    done += results.filter((r) => r.ok).length;
  }
  return done;
}
