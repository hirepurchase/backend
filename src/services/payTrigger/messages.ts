import * as crypto from 'crypto';
import prisma from '../../config/database';
import * as client from './client';
import { PAYTRIGGER_CURRENCY, liveActionsAllowedFor, liveActionsEnabled } from './config';
import { getPayTriggerSettings, PayTriggerSettingsRow } from './settings';
import { logAction } from './log';

/**
 * Words shown to the customer: the lock-screen text, reminders of an upcoming
 * payment, and one-off messages an admin sends to a phone.
 *
 * Templates are written by an admin with {placeholders} that are filled in for
 * each contract. The lock-screen text is stored on the phone ahead of time, so
 * it shows even when the phone locks with no data. Pop-ups and notifications
 * only arrive while the phone has data, and PayTrigger allows 3 of each per
 * phone in 24 hours.
 */

export const PLACEHOLDERS = [
  'customerName',
  'firstName',
  'amount',
  'dueDate',
  'daysLeft',
  'balance',
  'contractNumber',
  'agentName',
  'agentPhone',
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type MessageFacts = Record<Placeholder, string>;

export const TITLE_MAX = 80;
export const LOCK_TEXT_MAX = 400;
export const PUSH_TEXT_MAX = 500;
/** PayTrigger's limit per phone, per channel, in 24 hours. */
export const DAILY_LIMIT = 3;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "15 Sep 2026" — the same form Knox messages use. */
const formatDate = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
const formatAmount = (n: number) => `${PAYTRIGGER_CURRENCY} ${n.toFixed(2)}`;
const DAY_MS = 86400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Placeholders in a template that we do not know — returned so a typo is caught when saving. */
export function unknownPlaceholders(template: string): string[] {
  const found = template.match(/\{[^{}\s]+\}/g) || [];
  return [...new Set(found.map((f) => f.slice(1, -1)).filter((name) => !(PLACEHOLDERS as readonly string[]).includes(name)))];
}

export function renderTemplate(template: string, facts: MessageFacts, max: number): string {
  const text = template.replace(/\{([^{}\s]+)\}/g, (whole, name: string) => (name in facts ? facts[name as Placeholder] : whole));
  return text.replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

export interface ContractForMessage {
  contractNumber: string;
  totalPrice: number;
  totalPaid: number;
  customer?: { firstName: string; lastName: string } | null;
  createdBy?: { firstName: string; lastName: string; phone: string | null } | null;
  installments: Array<{ installmentNo: number; dueDate: Date; amount: number; paidAmount: number; status: string }>;
}

/** Unpaid instalments, earliest first. */
export function unpaidOf(installments: ContractForMessage['installments']) {
  return installments
    .filter((i) => i.status !== 'PAID' && i.status !== 'WRITTEN_OFF' && i.paidAmount + 0.005 < i.amount)
    .sort((a, b) => a.installmentNo - b.installmentNo);
}

/**
 * The figures a message can quote. `amount` is everything already due; when
 * nothing is due yet it is the next instalment, so a lock message written
 * before the phone locks names the amount that will clear it.
 */
export function factsFor(contract: ContractForMessage, now: Date): MessageFacts {
  const unpaid = unpaidOf(contract.installments);
  const next = unpaid[0];
  const due = unpaid.filter((i) => i.dueDate.getTime() <= now.getTime());
  const owed = (due.length ? due : next ? [next] : []).reduce((sum, i) => sum + (i.amount - i.paidAmount), 0);
  const daysLeft = next ? Math.round((startOfDay(next.dueDate) - startOfDay(now)) / DAY_MS) : 0;
  const agent = contract.createdBy;
  const customer = contract.customer;
  return {
    customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : 'Customer',
    firstName: customer?.firstName?.trim() || 'Customer',
    amount: formatAmount(Math.max(0, owed)),
    dueDate: next ? formatDate(next.dueDate) : '—',
    daysLeft: daysLeft === 0 ? 'today' : daysLeft === 1 ? '1 day' : daysLeft > 1 ? `${daysLeft} days` : `${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`,
    balance: formatAmount(Math.max(0, contract.totalPrice - contract.totalPaid)),
    contractNumber: contract.contractNumber,
    agentName: agent ? `${agent.firstName} ${agent.lastName}`.trim() : 'your agent',
    agentPhone: agent?.phone || 'the number on your contract',
  };
}

// ─── Lock-screen text ──────────────────────────────────────────────────────

export interface LockMessage {
  title?: string;
  tips?: string;
  /** Changes whenever the words on the phone should change; '' means "nothing of ours on the phone". */
  key: string;
}

/** The lock-screen text a phone should hold right now. */
export function lockMessageFor(settings: PayTriggerSettingsRow, contract: ContractForMessage, hold: boolean, now: Date): LockMessage {
  const facts = factsFor(contract, now);
  const titleTemplate = hold ? settings.depositHoldTitle : settings.lockTitle;
  const tipsTemplate = hold ? settings.depositHoldTips : settings.lockTips;
  const title = titleTemplate ? renderTemplate(titleTemplate, facts, TITLE_MAX) : undefined;
  const tips = tipsTemplate ? renderTemplate(tipsTemplate, facts, LOCK_TEXT_MAX) : undefined;
  if (!title && !tips) return { key: '' };
  const key = crypto.createHash('sha256').update(JSON.stringify([hold, title ?? '', tips ?? ''])).digest('hex').slice(0, 24);
  return { title, tips, key };
}

/** Contract states in which the phone is treated as "not on an active contract". */
export const isUnlinkedStatus = (status: string | null | undefined) =>
  !status || !['ACTIVE', 'COMPLETED', 'DEFAULTED', 'WRITTEN_OFF'].includes(status);

/**
 * The text for a phone that activated (and so locked itself) with no active
 * contract behind it: unsold stock switched on, a sale not yet approved, or a
 * cancelled contract. There is no customer to name, so placeholders that need
 * one are left out of this text.
 */
export function unlinkedMessageFor(settings: PayTriggerSettingsRow): LockMessage {
  const title = settings.unlinkedTitle.trim().slice(0, TITLE_MAX);
  const tips = settings.unlinkedTips.trim().slice(0, LOCK_TEXT_MAX);
  const key = crypto.createHash('sha256').update(JSON.stringify(['unlinked', title, tips])).digest('hex').slice(0, 24);
  return { title, tips, key };
}

// ─── Pop-ups and notifications ─────────────────────────────────────────────

const actionName = (kind: 'REMIND' | 'MESSAGE', channel: client.PushChannel) => `${kind}_${channel}`;

/** How many of each channel really went to this phone in the last 24 hours. */
export async function sentInLastDay(deviceId: string): Promise<Record<client.PushChannel, number>> {
  const rows = await prisma.payTriggerActionLog.groupBy({
    by: ['action'],
    where: {
      deviceId,
      success: true,
      dryRun: false,
      createdAt: { gte: new Date(Date.now() - DAY_MS) },
      action: { in: ['REMIND_POPUP', 'REMIND_PUSH', 'MESSAGE_POPUP', 'MESSAGE_PUSH'] },
    },
    _count: { _all: true },
  });
  const count = (channel: client.PushChannel) =>
    rows.filter((r) => r.action.endsWith(`_${channel}`)).reduce((sum, r) => sum + r._count._all, 0);
  return { POPUP: count('POPUP'), PUSH: count('PUSH') };
}

export function parseReminderDays(value: string): number[] {
  const days = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  return [...new Set(days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 30))].sort((a, b) => b - a);
}

export const channelsOf = (setting: string): client.PushChannel[] =>
  setting === 'BOTH' ? ['POPUP', 'PUSH'] : setting === 'PUSH' ? ['PUSH'] : ['POPUP'];

export interface ReminderSummary {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Reminders of an upcoming payment, sent by the morning sweep. A phone gets
 * one on each configured day before the due date (0 = the due day), once per
 * instalment and day. Phones that are locked, held for the agent's deposit or
 * not on an active contract get none: their lock screen already says why.
 */
export async function sendPaymentReminders(now = new Date()): Promise<ReminderSummary> {
  const summary: ReminderSummary = { due: 0, sent: 0, skipped: 0, failed: 0 };
  const settings = await getPayTriggerSettings();
  if (!settings.reminderEnabled) return summary;
  const days = parseReminderDays(settings.reminderDaysBefore);
  if (!days.length) return summary;
  const channels = channelsOf(settings.reminderChannel);

  const devices = await prisma.payTriggerDevice.findMany({
    where: { enrollmentStatus: 'ACTIVE', contractId: { not: null }, holdMessageShown: false, providerExpiresAt: { gt: now } },
    select: { id: true, imei: true, deviceTag: true, contractId: true },
  });
  if (!devices.length) return summary;

  const contracts = await prisma.hirePurchaseContract.findMany({
    where: { id: { in: devices.map((d) => d.contractId as string) }, status: 'ACTIVE' },
    select: {
      id: true,
      contractNumber: true,
      totalPrice: true,
      totalPaid: true,
      customer: { select: { firstName: true, lastName: true } },
      createdBy: { select: { firstName: true, lastName: true, phone: true } },
      installments: { select: { installmentNo: true, dueDate: true, amount: true, paidAmount: true, status: true } },
    },
  });
  const byId = new Map(contracts.map((c) => [c.id, c]));

  for (const device of devices) {
    const contract = byId.get(device.contractId as string);
    if (!contract) continue;
    const next = unpaidOf(contract.installments)[0];
    if (!next) continue;
    const daysLeft = Math.round((startOfDay(next.dueDate) - startOfDay(now)) / DAY_MS);
    if (!days.includes(daysLeft)) continue;
    summary.due++;

    const facts = factsFor(contract, now);
    const title = renderTemplate(settings.reminderTitle, facts, TITLE_MAX);
    const text = renderTemplate(settings.reminderText, facts, PUSH_TEXT_MAX);
    for (const channel of channels) {
      try {
        const outcome = await sendOnce({
          device,
          contract,
          kind: 'REMIND',
          channel,
          title,
          text,
          idempotencyKey: `${device.id}:REMIND:${next.installmentNo}:${daysLeft}:${channel}`,
        });
        summary[outcome]++;
      } catch (err) {
        summary.failed++;
        console.error('PayTrigger: reminder failed', device.id, err);
      }
    }
  }
  return summary;
}

/**
 * Send one pop-up or notification, at most once per idempotency key. A failure
 * is only written to the timeline: a missed reminder is not a fault with the
 * phone's lock, so it never touches the device's error or its lock commands.
 */
async function sendOnce(input: {
  device: { id: string; imei: string; deviceTag: string | null };
  contract: { id: string; contractNumber: string } | null;
  kind: 'REMIND' | 'MESSAGE';
  channel: client.PushChannel;
  title: string;
  text: string;
  idempotencyKey: string;
  actorId?: string | null;
}): Promise<'sent' | 'skipped' | 'failed'> {
  const { device, contract, channel } = input;
  const action = actionName(input.kind, channel);
  const existing = await prisma.payTriggerCommand.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing?.status === 'SUCCEEDED') return 'skipped';

  const skip = async (reason: string): Promise<'skipped'> => {
    await logAction({ deviceId: device.id, contractId: contract?.id, action, success: false, dryRun: true, skippedReason: reason, actorId: input.actorId });
    return 'skipped';
  };
  if (liveActionsEnabled() && !liveActionsAllowedFor(contract)) return skip('Not in PAYTRIGGER_CANARY_CONTRACTS — not sent.');
  if (liveActionsEnabled() && (await sentInLastDay(device.id))[channel] >= DAILY_LIMIT) {
    return skip(`PayTrigger allows ${DAILY_LIMIT} of these per phone in 24 hours — not sent.`);
  }

  const result = await client.sendPush({ imei: device.imei, deviceTag: device.deviceTag, channel, title: input.title, text: input.text });
  await logAction({ deviceId: device.id, contractId: contract?.id, action, result, actorId: input.actorId });
  const payload = { channel, title: input.title, text: input.text } as any;
  const data = {
    status: result.success ? 'SUCCEEDED' : 'FAILED',
    lastError: result.success ? null : result.error ?? 'Unknown error',
    payload,
  };
  if (existing) await prisma.payTriggerCommand.update({ where: { id: existing.id }, data: { ...data, attempts: { increment: 1 } } });
  else await prisma.payTriggerCommand.create({ data: { ...data, deviceId: device.id, type: input.kind, idempotencyKey: input.idempotencyKey, attempts: 1 } });
  if (!result.success && input.kind === 'MESSAGE') throw new Error(result.error || 'PayTrigger did not accept the message.');
  return result.success ? 'sent' : 'failed';
}

/** A message an admin writes for one phone. Placeholders are filled from its contract. */
export async function sendDeviceMessage(
  deviceId: string,
  message: { channel: client.PushChannel; title: string; text: string },
  actorId: string,
) {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error('Device not found');
  if (device.enrollmentStatus !== 'ACTIVE') throw new Error('The phone has not activated on PayTrigger yet, so it cannot receive messages.');

  const contract = device.contractId
    ? await prisma.hirePurchaseContract.findUnique({
        where: { id: device.contractId },
        select: {
          id: true,
          contractNumber: true,
          totalPrice: true,
          totalPaid: true,
          customer: { select: { firstName: true, lastName: true } },
          createdBy: { select: { firstName: true, lastName: true, phone: true } },
          installments: { select: { installmentNo: true, dueDate: true, amount: true, paidAmount: true, status: true } },
        },
      })
    : null;
  const render = (template: string, max: number) => (contract ? renderTemplate(template, factsFor(contract, new Date()), max) : template.trim().slice(0, max));
  const title = render(message.title, TITLE_MAX);
  const text = render(message.text, PUSH_TEXT_MAX);
  if (!title || !text) throw new Error('A title and a message are both needed.');

  const used = await sentInLastDay(device.id);
  if (liveActionsEnabled() && used[message.channel] >= DAILY_LIMIT) {
    throw new Error(`This phone has already had ${DAILY_LIMIT} ${message.channel === 'POPUP' ? 'pop-ups' : 'notifications'} in the last 24 hours — PayTrigger will not take another yet.`);
  }
  const outcome = await sendOnce({
    device,
    contract,
    kind: 'MESSAGE',
    channel: message.channel,
    title,
    text,
    idempotencyKey: `${device.id}:MESSAGE:${Date.now()}:${message.channel}`,
    actorId,
  });
  if (outcome === 'skipped') throw new Error('Not sent: this contract is outside the live test group.');
  return { sent: true, dryRun: !liveActionsEnabled(), title, text, channel: message.channel };
}
