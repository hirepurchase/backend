import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest } from '../middleware/auth';

const db = prisma as any;
const SETTINGS_ID = 'singleton';

function getAdminUserId(req: AuthenticatedRequest): string | undefined {
  return req.userType === 'admin' ? req.user?.id : undefined;
}

async function getOrCreateSettings() {
  let settings = await db.knoxGuardSettings.findFirst();
  if (!settings) {
    settings = await db.knoxGuardSettings.create({
      data: { id: SETTINGS_ID },
    });
  }
  return settings;
}

export async function getKnoxGuardSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (error) {
    console.error('Get Knox Guard settings error:', error);
    res.status(500).json({ error: 'Failed to load Knox Guard settings' });
  }
}

export async function updateKnoxGuardSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const current = await getOrCreateSettings();

    const {
      supportPhone,
      lockAfterOverdueDays,
      blockOnUnpaidPenalties,
      maxCommandRetries,
      commandCron,
      commandBatchSize,
      paymentAppPackage,
      paymentAppLabel,
      paymentUssd,
      refreshActionLabel,
      disclosureVersion,
      disclosureSummary,
      termsReference,
      supportMessage,
      warningMessage,
      allowCustomerAppOnLockScreen,
      allowSupportOnLockScreen,
      allowPaymentUssdOnLockScreen,
    } = req.body;

    // Validate numeric fields
    if (lockAfterOverdueDays !== undefined && (lockAfterOverdueDays < 1 || lockAfterOverdueDays > 365)) {
      res.status(400).json({ error: 'lockAfterOverdueDays must be between 1 and 365' });
      return;
    }
    if (maxCommandRetries !== undefined && (maxCommandRetries < 0 || maxCommandRetries > 10)) {
      res.status(400).json({ error: 'maxCommandRetries must be between 0 and 10' });
      return;
    }
    if (commandBatchSize !== undefined && (commandBatchSize < 1 || commandBatchSize > 100)) {
      res.status(400).json({ error: 'commandBatchSize must be between 1 and 100' });
      return;
    }

    const updated = await db.knoxGuardSettings.update({
      where: { id: current.id },
      data: {
        ...(supportPhone !== undefined ? { supportPhone: supportPhone || null } : {}),
        ...(lockAfterOverdueDays !== undefined ? { lockAfterOverdueDays: Number(lockAfterOverdueDays) } : {}),
        ...(blockOnUnpaidPenalties !== undefined ? { blockOnUnpaidPenalties: Boolean(blockOnUnpaidPenalties) } : {}),
        ...(maxCommandRetries !== undefined ? { maxCommandRetries: Number(maxCommandRetries) } : {}),
        ...(commandCron !== undefined ? { commandCron } : {}),
        ...(commandBatchSize !== undefined ? { commandBatchSize: Number(commandBatchSize) } : {}),
        ...(paymentAppPackage !== undefined ? { paymentAppPackage } : {}),
        ...(paymentAppLabel !== undefined ? { paymentAppLabel } : {}),
        ...(paymentUssd !== undefined ? { paymentUssd: paymentUssd || null } : {}),
        ...(refreshActionLabel !== undefined ? { refreshActionLabel } : {}),
        ...(disclosureVersion !== undefined ? { disclosureVersion } : {}),
        ...(disclosureSummary !== undefined ? { disclosureSummary } : {}),
        ...(termsReference !== undefined ? { termsReference: termsReference || null } : {}),
        ...(supportMessage !== undefined ? { supportMessage } : {}),
        ...(warningMessage !== undefined ? { warningMessage } : {}),
        ...(allowCustomerAppOnLockScreen !== undefined ? { allowCustomerAppOnLockScreen: Boolean(allowCustomerAppOnLockScreen) } : {}),
        ...(allowSupportOnLockScreen !== undefined ? { allowSupportOnLockScreen: Boolean(allowSupportOnLockScreen) } : {}),
        ...(allowPaymentUssdOnLockScreen !== undefined ? { allowPaymentUssdOnLockScreen: Boolean(allowPaymentUssdOnLockScreen) } : {}),
      },
    });

    await createAuditLog({
      userId: getAdminUserId(req),
      action: 'UPDATE_KNOX_GUARD_SETTINGS',
      entity: 'KnoxGuardSettings',
      entityId: updated.id,
      newValues: updated,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Knox Guard settings updated successfully', settings: updated });
  } catch (error) {
    console.error('Update Knox Guard settings error:', error);
    res.status(500).json({ error: 'Failed to update Knox Guard settings' });
  }
}
