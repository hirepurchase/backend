import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import { getKnoxGuardUnlockPin } from '../services/knoxGuardService';
import { safelyEvaluateManagedDeviceForContract } from '../services/deviceControlPolicyService';

/**
 * POST /knox-guard/contracts/:contractId/pin   { passkey?: string }
 *
 * Offline unlock PIN for a Samsung phone that is locked and has no data.
 * Admins and Super Admins only, by role. The PIN itself is returned once and
 * never stored or logged.
 *
 * Before asking Knox for a PIN, the contract is evaluated the normal way, so a
 * cleared payment queues the server-side unlock too. A PIN is refused while
 * Knox still wants the phone locked: the phone obeys the server when it
 * reconnects (and within 24 hours on hardened devices), so the PIN would only
 * buy the customer a day.
 */

const PIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

export async function issueKnoxPin(req: AuthenticatedRequest, res: Response): Promise<void> {
  const user = req.user as AdminUserPayload;
  if (!PIN_ROLES.has(user.role)) {
    res.status(403).json({ error: 'Only an Admin or Super Admin can issue an unlock PIN.' });
    return;
  }

  const contractId = String(req.params.contractId);
  const passkey = typeof req.body?.passkey === 'string' ? req.body.passkey.replace(/\s+/g, '') : '';
  if (passkey && !/^[A-Za-z0-9]{4,20}$/.test(passkey)) {
    res.status(400).json({ error: 'The passkey is the code shown on the lock screen — letters and digits only.' });
    return;
  }

  try {
    const device = await (prisma as any).managedDevice.findUnique({ where: { contractId } });
    if (!device || !device.isActive) {
      res.status(404).json({ error: 'This contract has no active Knox Guard device.' });
      return;
    }

    // Bring Knox's intent up to date first — this is what queues the real
    // unlock when the customer has paid.
    await safelyEvaluateManagedDeviceForContract(contractId);
    const fresh = await (prisma as any).managedDevice.findUnique({
      where: { contractId },
      select: { desiredState: true, actualState: true, knoxObjectId: true, deviceUid: true, approveId: true },
    });
    if (fresh?.desiredState === 'LOCKED') {
      res.status(400).json({
        error:
          'Knox still requires this phone to be locked (instalments overdue or the agent deposit unpaid). ' +
          'A PIN would only open it until it next connects. Record the payment first.',
      });
      return;
    }

    const result = await getKnoxGuardUnlockPin({
      objectId: fresh?.knoxObjectId,
      deviceUid: fresh?.deviceUid,
      approveId: fresh?.approveId,
      passkey: passkey || null,
    });

    await createAuditLog({
      userId: user.id,
      action: 'KNOX_PIN_ISSUED',
      entity: 'ManagedDevice',
      entityId: device.id,
      newValues: {
        contractId,
        withPasskey: Boolean(passkey),
        success: result.success,
        dryRun: result.dryRun,
        transactionId: result.transactionId,
        error: result.error ?? null,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    if (!result.success || !result.pins?.length) {
      res.status(502).json({
        error: result.error || 'Knox Guard did not return a PIN.',
        hint: passkey ? undefined : 'If the lock screen shows a passkey, enter it and try again.',
      });
      return;
    }

    res.json({
      pins: result.pins,
      dryRun: result.dryRun,
      withPasskey: Boolean(passkey),
      notice:
        'The customer enters the PIN on the lock screen. The phone must reach the internet within 24 hours ' +
        'and should not be restarted until then, or it locks again and needs a new PIN.',
    });
  } catch (error) {
    console.error('issueKnoxPin error:', error);
    res.status(500).json({ error: 'Failed to get an unlock PIN' });
  }
}
