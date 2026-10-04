import * as crypto from 'crypto';
import prisma from '../../config/database';
import { enqueue } from './events';
import { applyLockState } from './reconcile';
import { markActivated } from './sweep';
import { removeTranssionContract } from './registry';
import { logAction } from './log';

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
      } else if (body.deviceTag && !device.deviceTag) {
        await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { deviceTag: body.deviceTag } });
      }
      if (body.mobileStatus === 1000 || body.mobileStatus === 2000) {
        await applyLockState(device.id, { mobileStatus: body.mobileStatus, deviceTag: body.deviceTag });
      }
    } else if (type === '2000') {
      await prisma.payTriggerDevice.update({
        where: { id: device.id },
        data: { enrollmentStatus: 'REMOVED', committedState: 'UNLOCKED', awaitingPinSince: null },
      });
      if (device.contractId) removeTranssionContract(device.contractId);
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
