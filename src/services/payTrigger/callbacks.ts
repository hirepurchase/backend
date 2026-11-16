import * as crypto from 'crypto';
import prisma from '../../config/database';
import { enqueue } from './events';
import { applyLockState, syncUnlinkedMessage } from './reconcile';
import { markActivated } from './sweep';
import { removeTranssionContract } from './registry';
import { logAction } from './log';
import { createAuditLog } from '../auditService';

/**
 * PayTrigger callbacks (API doc §3.5):
 *   1000 — the phone's activation / lock state changed
 *   2000 — the phone finished removing the lock
 *   4000 — a strong-restriction command was not applied (over the limit)
 *
 * Every body is spooled first and de-duplicated, because PayTrigger re-sends
 * until it gets {"code":200,"message":"Success"} back.
 */

interface CallbackBody {
  notifyType?: number | string;
  imei?: string;
  deviceTag?: string;
  orderNum?: string;
  state?: number;
  serverState?: number;
  mobileStatus?: number;
  activeTime?: number;
  expiration?: number;
  clientRemoveTime?: number;
  tip?: string;
  [key: string]: unknown;
}

export async function spoolCallback(body: CallbackBody): Promise<string> {
  const dedupeKey = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  try {
    const row = await prisma.payTriggerWebhookEvent.create({
      data: { dedupeKey, notifyType: String(body.notifyType ?? ''), body: body as any },
    });
    return row.id;
  } catch (err: any) {
    if (err?.code === 'P2002') {
      const existing = await prisma.payTriggerWebhookEvent.findUnique({ where: { dedupeKey } });
      return existing?.processedAt ? '' : existing?.id ?? '';
    }
    throw err;
  }
}

export async function processCallback(eventId: string): Promise<void> {
  if (!eventId) return;
  const event = await prisma.payTriggerWebhookEvent.findUnique({ where: { id: eventId } });
  if (!event || event.processedAt) return;
  const body = event.body as CallbackBody;
  try {
    const device = await findDevice(body);
    if (!device) throw new Error(`No PayTrigger device for imei=${body.imei} tag=${body.deviceTag}`);

    const type = String(body.notifyType);
    if (type === '1000') {
      if (body.state === 3000 && device.enrollmentStatus === 'QUEUED') {
        await markActivated(device.id, { deviceTag: body.deviceTag, activeTime: body.activeTime });
        // First contact: push whatever the contract says now (usually nothing
        // while the deposit is unpaid — the phone activated locked).
        if (device.contractId) await enqueue(device.contractId, 'DEVICE_ACTIVATED');
        // Switched on with no sale behind it: it locked itself; tell the holder why.
        else await syncUnlinkedMessage(device.id).catch((err) => console.error('PayTrigger: no-contract message failed', err));
      } else if (body.deviceTag && !device.deviceTag) {
        await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { deviceTag: body.deviceTag } });
      }
      if (body.mobileStatus === 1000 || body.mobileStatus === 2000) {
        await applyLockState(device.id, { mobileStatus: body.mobileStatus, deviceTag: body.deviceTag });
      }
    } else if (type === '2000') {
      const unexpected = await unexpectedRemoval(device);
      await prisma.payTriggerDevice.update({
        where: { id: device.id },
        data: {
          enrollmentStatus: 'REMOVED',
          committedState: 'UNLOCKED',
          awaitingPinSince: null,
          ...(unexpected ? { lastError: unexpected } : {}),
        },
      });
      if (device.contractId) removeTranssionContract(device.contractId);
      if (unexpected) {
        console.error(`PayTrigger: ${unexpected}`);
        await createAuditLog({
          action: 'PAYTRIGGER_UNEXPECTED_REMOVAL',
          entity: 'PayTriggerDevice',
          entityId: device.id,
          newValues: { imei: device.imei, contractId: device.contractId, message: unexpected },
        });
      }
    } else if (type === '4000') {
      await prisma.payTriggerDevice.update({
        where: { id: device.id },
        data: { lastError: body.tip || 'A strong restriction was not applied on the phone (over the limit).' },
      });
    }

    await logAction({ deviceId: device.id, contractId: device.contractId, action: `CALLBACK_${type}`, success: true, dryRun: false, response: body });
    await prisma.payTriggerWebhookEvent.update({ where: { id: eventId }, data: { processedAt: new Date(), error: null } });
  } catch (err: any) {
    await prisma.payTriggerWebhookEvent.update({ where: { id: eventId }, data: { error: String(err?.message || err) } });
  }
}

/** Contract states in which the customer still owes, so the phone must stay lockable. */
const OWING_STATUSES = new Set(['ACTIVE', 'DEFAULTED', 'PENDING_APPROVAL', 'REVISION_REQUESTED']);

/**
 * A lock removal we did not ask for, on a phone whose customer still owes.
 * Removal cannot be undone, so it is recorded loudly for an admin to take up
 * with Transsion. Returns the text to show, or null when it was expected.
 */
async function unexpectedRemoval(device: { id: string; contractId: string | null }): Promise<string | null> {
  if (!device.contractId) return null;
  const contract = await prisma.hirePurchaseContract.findUnique({
    where: { id: device.contractId },
    select: { contractNumber: true, status: true },
  });
  if (!contract || !OWING_STATUSES.has(contract.status)) return null;
  const asked = await prisma.payTriggerCommand.findFirst({
    where: { deviceId: device.id, type: { in: ['RELEASE', 'CANCEL'] }, status: 'SUCCEEDED' },
    select: { id: true },
  });
  if (asked) return null;
  return `Transsion removed the lock on this phone, but contract ${contract.contractNumber} is still ${contract.status.toLowerCase().replace(/_/g, ' ')}. It can no longer be locked — take it up with Transsion.`;
}

async function findDevice(body: CallbackBody) {
  if (body.imei) {
    const byImei = await prisma.payTriggerDevice.findUnique({ where: { imei: String(body.imei) } });
    if (byImei) return byImei;
  }
  if (body.deviceTag) {
    return prisma.payTriggerDevice.findFirst({ where: { deviceTag: String(body.deviceTag) } });
  }
  return null;
}
