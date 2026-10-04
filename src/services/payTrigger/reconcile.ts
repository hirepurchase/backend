import prisma from '../../config/database';
import { OWED_PENALTY_WHERE } from '../penaltyService';
import { TEMPORARY_UNLOCK_STATUS } from '../temporaryUnlockService';
import * as client from './client';
import { PAYTRIGGER_CURRENCY } from './config';
import { decide, Decision } from './decide';
import { enqueue, eventStats, EventReason, UNLOCK_REASONS } from './events';
import { recordDeferredLock, runCommand } from './commands';
import { addTranssionContract, removeTranssionContract } from './registry';
import { getPayTriggerSettings, PayTriggerSettingsRow } from './settings';
import { logAction } from './log';

/**
 * Reconcile ONE contract: load it, decide, and send PayTrigger whatever is
 * needed to make the phone match. Called from the event inbox, the morning
 * sweep and the admin "Reconcile now" button.
 */

/** How long after an unlock to check it landed on the phone. */
const UNLOCK_CHECK_DELAY_MS = 60_000;

export interface ReconcileOptions {
  reasons: EventReason[];
  actorId?: string | null;
  /** Resend even if the decision has not changed (admin button). */
  force?: boolean;
  /** Set by the sweep: refuses extensions once too many have been made in one run. */
  breaker?: { allowExtend(): boolean };
}

export interface ReconcileOutcome {
  contractId: string;
  deviceId?: string;
  decision?: Decision;
  sent?: string;
  skipped?: string;
}

type DeviceRow = NonNullable<Awaited<ReturnType<typeof prisma.payTriggerDevice.findUnique>>>;

/** Find the contract's device, linking it by inventory item on first sight. */
async function findOrLinkDevice(contractId: string): Promise<DeviceRow | null> {
  const linked = await prisma.payTriggerDevice.findUnique({ where: { contractId } });
  if (linked) return linked;

  const item = await prisma.inventoryItem.findFirst({ where: { contractId }, select: { id: true } });
  if (!item) return null;
  const device = await prisma.payTriggerDevice.findUnique({ where: { inventoryItemId: item.id } });
  if (!device) return null;
  if (device.contractId && device.contractId !== contractId) return null;

  const updated = await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { contractId } });
  addTranssionContract(contractId);
  await logAction({ deviceId: device.id, contractId, action: 'LINK', success: true, dryRun: false, skippedReason: 'Device linked to contract' });
  return updated;
}

async function loadContract(contractId: string) {
  return prisma.hirePurchaseContract.findUnique({
    where: { id: contractId },
    select: {
      id: true,
      contractNumber: true,
      status: true,
      gracePeriodDays: true,
      totalPrice: true,
      totalPaid: true,
      totalInstallments: true,
      endDate: true,
      approvedAt: true,
      customer: { select: { phone: true } },
      createdBy: { select: { firstName: true, lastName: true, phone: true } },
      installments: {
        orderBy: { installmentNo: 'asc' },
        select: { installmentNo: true, dueDate: true, amount: true, paidAmount: true, status: true },
      },
      temporaryUnlocks: {
        where: { status: TEMPORARY_UNLOCK_STATUS.APPROVED },
        select: { status: true, expiresAt: true },
      },
      agentLedger: { select: { outstandingBalance: true } },
      penalties: { where: OWED_PENALTY_WHERE, select: { amount: true, paidAmount: true } },
    },
  });
}

type ContractRow = NonNullable<Awaited<ReturnType<typeof loadContract>>>;

function holdText(template: string, contract: ContractRow): string {
  const agent = contract.createdBy;
  return template
    .replace(/\{agentName\}/g, agent ? `${agent.firstName} ${agent.lastName}`.trim() : 'your agent')
    .replace(/\{agentPhone\}/g, agent?.phone || 'the number on your contract');
}

function scheduleRetry(contractId: string) {
  return (delayMs: number) => {
    setTimeout(() => {
      enqueue(contractId, 'RETRY').catch(() => undefined);
    }, delayMs).unref?.();
  };
}

export async function reconcileContract(contractId: string, options: ReconcileOptions): Promise<ReconcileOutcome> {
  eventStats.reconciles++;
  const device = await findOrLinkDevice(contractId);
  if (!device) return { contractId, skipped: 'No PayTrigger device for this contract' };
  if (['REMOVED', 'CANCELLED'].includes(device.enrollmentStatus)) {
    removeTranssionContract(contractId);
    return { contractId, deviceId: device.id, skipped: `Device ${device.enrollmentStatus.toLowerCase()}` };
  }

  const contract = await loadContract(contractId);
  if (!contract) return { contractId, deviceId: device.id, skipped: 'Contract not found' };

  const settings = await getPayTriggerSettings();
  const now = new Date();
  const activated = device.enrollmentStatus === 'ACTIVE' || device.enrollmentStatus === 'UNENFORCEABLE';
  const decision = decide({
    contract,
    installments: contract.installments,
    tempUnlocks: contract.temporaryUnlocks,
    depositLedger: contract.agentLedger,
    penaltiesOwed: contract.penalties.reduce((s, p) => s + Math.max(0, p.amount - (p.paidAmount ?? 0)), 0),
    device: { enrollmentStatus: device.enrollmentStatus, providerExpiresAt: device.providerExpiresAt, activated },
    settings,
    now,
  });

  await prisma.payTriggerDevice.update({
    where: { id: device.id },
    data: {
      scheduleExpiresAt: decision.scheduleExpiresAt ?? null,
      // A completion reversed (payment reversal) cancels a pending release.
      ...(decision.action !== 'RELEASE' && device.releaseAfter ? { releaseAfter: null } : {}),
    },
  });

  const outcome: ReconcileOutcome = { contractId, deviceId: device.id, decision };
  const ctxBase = {
    device,
    contract: { id: contract.id, contractNumber: contract.contractNumber },
    actorId: options.actorId,
    scheduleRetry: scheduleRetry(contractId),
  };

  // ── Lock-screen wording for the deposit hold ────────────────────────────
  if (activated && decision.depositHold !== device.holdMessageShown) {
    await syncHoldMessage(device, contract, settings, decision.depositHold, ctxBase);
  }

  if (!options.force && device.fingerprint === decision.fingerprint) {
    return { ...outcome, skipped: 'Decision unchanged' };
  }

  switch (decision.action) {
    case 'RELEASE': {
      if (!device.releaseAfter && activated) {
        const releaseAfter = new Date(now.getTime() + settings.releaseHoldHours * 3600_000);
        await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { releaseAfter, fingerprint: decision.fingerprint } });
        await logAction({ deviceId: device.id, contractId, action: 'RELEASE_SCHEDULED', success: true, dryRun: false, skippedReason: `Release after ${releaseAfter.toISOString()}`, actorId: options.actorId });
      }
      return { ...outcome, sent: 'release scheduled' };
    }

    case 'CANCEL': {
      if (device.enrollmentStatus !== 'QUEUED') return { ...outcome, skipped: 'Not queued — nothing to cancel' };
      const res = await runCommand({
        ...ctxBase,
        type: 'CANCEL',
        fingerprint: decision.fingerprint,
        payload: { imei: device.imei },
        send: () => client.cancelEnrolment([device.imei]),
      });
      if (res.status === 'SUCCEEDED') {
        await prisma.payTriggerDevice.update({
          where: { id: device.id },
          data: { enrollmentStatus: 'CANCELLED', fingerprint: decision.fingerprint, lastError: null },
        });
        removeTranssionContract(contractId);
      }
      return { ...outcome, sent: `cancel ${res.status.toLowerCase()}` };
    }

    case 'NONE':
      await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { fingerprint: decision.fingerprint } });
      return { ...outcome, skipped: decision.reason };

    default:
      break;
  }

  // EXTEND, HOLD, LOCK — all expressed as a lock date.
  if (!activated) {
    // Nothing reaches a phone that has not activated; it locks itself on
    // activation (preLockFlag) and the activation callback reconciles again.
    return { ...outcome, skipped: 'Waiting for activation' };
  }

  if (!decision.nextRepayTime) {
    if (decision.action === 'LOCK' || decision.action === 'HOLD') {
      await recordDeferredLock(device, contractId, decision.fingerprint, 'Phone is past its lock date and locks itself — nothing to send.');
    }
    await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { fingerprint: decision.fingerprint } });
    return { ...outcome, skipped: 'Already past its lock date' };
  }

  const extending = decision.action === 'EXTEND'
    && (!device.providerExpiresAt || decision.nextRepayTime > device.providerExpiresAt);
  if (extending && options.breaker && !options.breaker.allowExtend()) {
    await logAction({ deviceId: device.id, contractId, action: 'EXTEND', success: false, dryRun: false, skippedReason: 'Circuit breaker: too many extensions in this sweep — held for review.' });
    return { ...outcome, skipped: 'Circuit breaker' };
  }

  const wasLocked = !device.providerExpiresAt || device.providerExpiresAt.getTime() <= now.getTime();
  const nextRepayTime = decision.nextRepayTime;
  const res = await runCommand({
    ...ctxBase,
    type: decision.action === 'EXTEND' ? 'EXTEND' : 'LOCK',
    fingerprint: decision.fingerprint,
    payload: { nextRepayTime: nextRepayTime.toISOString(), reason: decision.reason },
    send: () =>
      client.updateRepayInfo({
        imei: device.imei,
        deviceTag: device.deviceTag,
        nextRepayTime,
        nextRepayAmt: decision.nextRepayAmt,
        repayedAmt: decision.repayedAmt,
        totalAmt: decision.totalAmt,
        currentTerm: decision.currentTerm,
        totalTerm: decision.totalTerm,
        orderNum: contract.contractNumber,
        phoneNum: contract.customer?.phone,
        currencyType: PAYTRIGGER_CURRENCY,
        deeplink: settings.payDeeplink,
        description: decision.reason.slice(0, 100),
      }),
  });

  if (res.status === 'SUCCEEDED') {
    await prisma.payTriggerDevice.update({
      where: { id: device.id },
      data: {
        providerExpiresAt: nextRepayTime,
        fingerprint: decision.fingerprint,
        committedState: 'PENDING',
        lastError: null,
      },
    });
    // The customer just paid (or was granted a window) and the phone was shut:
    // check in a minute that it opened. If it did not, the phone is offline
    // and an admin needs to read out a PIN.
    if (decision.action === 'EXTEND' && wasLocked && options.reasons.some((r) => UNLOCK_REASONS.has(r))) {
      setTimeout(() => {
        checkUnlockLanded(device.id).catch((err) => console.error('PayTrigger: unlock check failed', err));
      }, UNLOCK_CHECK_DELAY_MS).unref?.();
    }
  }
  return { ...outcome, sent: `${decision.action.toLowerCase()} ${res.status.toLowerCase()}` };
}

async function syncHoldMessage(
  device: DeviceRow,
  contract: ContractRow,
  settings: PayTriggerSettingsRow,
  hold: boolean,
  ctxBase: Omit<Parameters<typeof runCommand>[0], 'type' | 'fingerprint' | 'payload' | 'send'>,
) {
  const title = hold ? settings.depositHoldTitle : settings.lockTitle || undefined;
  const tips = hold ? holdText(settings.depositHoldTips, contract) : settings.lockTips || undefined;
  // Keyed per day, so retries of a failing call count against one row (and
  // stop after three) rather than starting afresh each time.
  const res = await runCommand({
    ...ctxBase,
    type: 'SYNC',
    fingerprint: `hold-message:${hold}:${new Date().toISOString().slice(0, 10)}`,
    payload: { hold, title, tips },
    send: () =>
      client.setDeviceRule({
        imei: device.imei,
        deviceTag: device.deviceTag,
        ruleNum: settings.defaultRuleNum,
        deviceTitle: title,
        // Clearing the per-device text lets the portal's general wording show again.
        deviceTips: tips ?? ' ',
      }),
  });
  // SKIPPED here means this exact message already went out today.
  if (res.status === 'SUCCEEDED' || (res.status === 'SKIPPED' && !res.error)) {
    await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { holdMessageShown: hold } });
  }
}

/**
 * One status read a minute after an unlock. Still locked means the phone has
 * no data: flag it so admins see it at the top of the "Paid — still locked"
 * queue and can read out a PIN.
 */
export async function checkUnlockLanded(deviceId: string): Promise<void> {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device || device.enrollmentStatus !== 'ACTIVE') return;
  const res = await client.findLockState(device);
  await logAction({ deviceId, contractId: device.contractId, action: 'STATUS_READ', result: res });
  if (!res.success || res.dryRun || !res.data) return;
  await applyLockState(device.id, res.data);
}

/** Fold a status read or callback into the device row. */
export async function applyLockState(deviceId: string, state: client.LockState): Promise<void> {
  const locked = state.mobileStatus === 1000;
  const unlocked = state.mobileStatus === 2000;
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device) return;
  const shouldBeOpen = !!device.providerExpiresAt && device.providerExpiresAt.getTime() > Date.now();

  await prisma.payTriggerDevice.update({
    where: { id: deviceId },
    data: {
      committedState: locked ? 'LOCKED' : unlocked ? 'UNLOCKED' : device.committedState,
      lastConnectAt: state.lastConnectTime ? new Date(state.lastConnectTime * 1000) : device.lastConnectAt,
      apkVersion: state.apkVersion ?? device.apkVersion,
      deviceTag: state.deviceTag ?? device.deviceTag,
      lastStatusReadAt: new Date(),
      enforcementConfirmedAt: locked ? new Date() : device.enforcementConfirmedAt,
      // Locked while it should be open → waiting on a PIN. Open → nothing waiting.
      awaitingPinSince: locked && shouldBeOpen ? device.awaitingPinSince ?? new Date() : unlocked ? null : device.awaitingPinSince,
    },
  });
}
