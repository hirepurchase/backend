import { windowsEndedBetween } from './paidUnlockService';
import { safelyEvaluateManagedDeviceForContract } from './deviceControlPolicyService';
import { notifyPayTrigger } from './payTrigger/events';

/**
 * Shut phones whose paid temporary unlock has just ended.
 *
 * A PayTrigger phone locks itself on the date it was given, online or not; the
 * reconcile here only brings our record up to date. A Knox phone has no lock
 * date and stays open until told otherwise, so this is what locks it — and a
 * Knox phone that is offline locks only when it next connects.
 *
 * Runs on the five-minute device tick. Each run looks back to the previous one
 * with an overlap, and the first run after a start looks back a day, so a
 * restart never lets a window slip past. Judging a contract twice is harmless.
 */
const OVERLAP_MS = 15 * 60_000;
const FIRST_LOOKBACK_MS = 24 * 3600_000;

let lastRunAt: Date | null = null;

export async function relockEndedPaidWindows(now: Date = new Date()): Promise<{ contracts: number }> {
  const from = new Date((lastRunAt ? lastRunAt.getTime() : now.getTime() - FIRST_LOOKBACK_MS) - OVERLAP_MS);
  const contractIds = await windowsEndedBetween(from, now);
  for (const contractId of contractIds) {
    await safelyEvaluateManagedDeviceForContract(contractId);
    notifyPayTrigger(contractId, 'CONTRACT_CHANGED');
  }
  lastRunAt = now;
  return { contracts: contractIds.length };
}
