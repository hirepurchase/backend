import prisma from '../../config/database';
import type { PayTriggerResult } from './client';

/**
 * PayTrigger keeps no history of what we asked it to do, so every request —
 * live, simulated or skipped — is written here. This is the record used to
 * settle a dispute about when a phone was locked or opened.
 */
export async function logAction(entry: {
  deviceId?: string | null;
  contractId?: string | null;
  action: string;
  result?: PayTriggerResult;
  success?: boolean;
  dryRun?: boolean;
  skippedReason?: string;
  actorId?: string | null;
  response?: unknown;
}): Promise<void> {
  try {
    await prisma.payTriggerActionLog.create({
      data: {
        deviceId: entry.deviceId ?? null,
        contractId: entry.contractId ?? null,
        action: entry.action,
        success: entry.success ?? entry.result?.success ?? false,
        dryRun: entry.dryRun ?? entry.result?.dryRun ?? true,
        providerCode: entry.result?.code ?? null,
        skippedReason: entry.skippedReason ?? (entry.result && !entry.result.success ? entry.result.error ?? null : null),
        request: (entry.result?.request as any) ?? undefined,
        response: (entry.response ?? (entry.result ? { code: entry.result.code, message: entry.result.message, data: entry.result.data } : undefined)) as any,
        actorId: entry.actorId ?? null,
      },
    });
  } catch (err) {
    // Losing a log line must never stop the action itself.
    console.error('PayTrigger: failed to write action log', err);
  }
}
