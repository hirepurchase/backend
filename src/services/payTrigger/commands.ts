import prisma from '../../config/database';
import * as client from './client';
import { liveActionsAllowedFor, liveActionsEnabled } from './config';
import { logAction } from './log';

/**
 * Sending one command to PayTrigger and remembering how it went.
 *
 * Each command row is keyed on (device, type, decision fingerprint), so the
 * same decision is never sent twice once it has succeeded, and a failed one
 * is retried under the same row. Retries run in-process at +30s, +2m and
 * +10m; after that the row is FAILED and the 08:36 sweep tries again.
 *
 * A successful write is never recorded as LOCKED or UNLOCKED — only PENDING.
 * The phone's real state comes from a callback or a status read.
 */

export type CommandType = 'ENROL' | 'EXTEND' | 'LOCK' | 'RELEASE' | 'CANCEL' | 'SYNC';

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

export interface CommandContext {
  device: { id: string; imei: string; deviceTag: string | null };
  contract: { id: string; contractNumber: string } | null;
  type: CommandType;
  fingerprint: string;
  payload: Record<string, unknown>;
  actorId?: string | null;
  send: () => Promise<client.PayTriggerResult>;
  /** Called with a delay when a retry should be scheduled. */
  scheduleRetry?: (delayMs: number) => void;
}

export interface CommandOutcome {
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'DEFERRED';
  result?: client.PayTriggerResult;
  error?: string;
}

export async function runCommand(ctx: CommandContext): Promise<CommandOutcome> {
  const idempotencyKey = `${ctx.device.id}:${ctx.type}:${ctx.fingerprint}`;
  const existing = await prisma.payTriggerCommand.findUnique({ where: { idempotencyKey } });
  if (existing?.status === 'SUCCEEDED') return { status: 'SKIPPED' };

  // Canary: with live actions on, only listed contracts are really sent.
  if (liveActionsEnabled() && !liveActionsAllowedFor(ctx.contract)) {
    await logAction({
      deviceId: ctx.device.id,
      contractId: ctx.contract?.id,
      action: ctx.type,
      success: false,
      dryRun: true,
      skippedReason: 'Not in PAYTRIGGER_CANARY_CONTRACTS — not sent.',
      actorId: ctx.actorId,
    });
    return { status: 'SKIPPED', error: 'not in canary' };
  }

  const command = existing
    ? await prisma.payTriggerCommand.update({
        where: { id: existing.id },
        data: { status: 'PROCESSING', attempts: { increment: 1 }, payload: ctx.payload as any },
      })
    : await prisma.payTriggerCommand.create({
        data: {
          deviceId: ctx.device.id,
          type: ctx.type,
          status: 'PROCESSING',
          idempotencyKey,
          payload: ctx.payload as any,
          attempts: 1,
        },
      });

  const result = await ctx.send();
  await logAction({ deviceId: ctx.device.id, contractId: ctx.contract?.id, action: ctx.type, result, actorId: ctx.actorId });

  if (result.success) {
    await prisma.payTriggerCommand.update({
      where: { id: command.id },
      data: { status: 'SUCCEEDED', lastError: null, nextAttemptAt: null },
    });
    return { status: 'SUCCEEDED', result };
  }

  const attemptIndex = command.attempts - 1;
  const giveUp = result.permanent || attemptIndex >= RETRY_DELAYS_MS.length;
  // A rate limit resets after 24h; retrying sooner only spends the quota again.
  const delay = result.rateLimited ? null : RETRY_DELAYS_MS[attemptIndex] ?? null;
  await prisma.payTriggerCommand.update({
    where: { id: command.id },
    data: {
      status: giveUp || delay === null ? 'FAILED' : 'PENDING',
      lastError: result.error ?? 'Unknown error',
      nextAttemptAt: !giveUp && delay !== null ? new Date(Date.now() + delay) : null,
    },
  });
  await prisma.payTriggerDevice.update({ where: { id: ctx.device.id }, data: { lastError: result.error ?? 'Unknown error' } });

  if (!giveUp && delay !== null && ctx.scheduleRetry) ctx.scheduleRetry(delay);
  return { status: 'FAILED', result, error: result.error };
}

/** Record that a lock is wanted but there is nothing to send: the phone's own date has already passed. */
export async function recordDeferredLock(device: { id: string }, contractId: string, fingerprint: string, reason: string) {
  const idempotencyKey = `${device.id}:LOCK:${fingerprint}`;
  const existing = await prisma.payTriggerCommand.findUnique({ where: { idempotencyKey } });
  if (existing) return;
  await prisma.payTriggerCommand.create({
    data: { deviceId: device.id, type: 'LOCK', status: 'DEFERRED', idempotencyKey, payload: { reason } as any },
  });
  await logAction({ deviceId: device.id, contractId, action: 'LOCK', success: true, dryRun: !liveActionsEnabled(), skippedReason: reason });
}
