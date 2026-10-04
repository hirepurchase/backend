import prisma from '../../config/database';

/**
 * PayTrigger settings — a single row, created with defaults on first read and
 * cached for a minute so a burst of events does not re-read it each time.
 */

export type PayTriggerSettingsRow = Awaited<ReturnType<typeof prisma.payTriggerSettings.upsert>>;

const TTL_MS = 60_000;
let cached: PayTriggerSettingsRow | null = null;
let cachedAt = 0;

export async function getPayTriggerSettings(): Promise<PayTriggerSettingsRow> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  cached = await prisma.payTriggerSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
  cachedAt = Date.now();
  return cached;
}

export function invalidatePayTriggerSettings(): void {
  cached = null;
}

/** Fields an admin may change. operatorOfflineTimerHours is Transsion's, not ours. */
export const EDITABLE_SETTINGS = [
  'defaultRuleNum',
  'lockAfterOverdueDays',
  'lockOnUnpaidAgentDeposit',
  'holdOnUnpaidPenalties',
  'maxUnlockHorizonDays',
  'releaseHoldHours',
  'extendBreakerPercent',
  'lockTitle',
  'lockTips',
  'depositHoldTitle',
  'depositHoldTips',
  'unlinkedTitle',
  'unlinkedTips',
  'payDeeplink',
  'reminderEnabled',
  'reminderDaysBefore',
  'reminderChannel',
  'reminderIncludeDaily',
  'reminderTitle',
  'reminderText',
] as const;
