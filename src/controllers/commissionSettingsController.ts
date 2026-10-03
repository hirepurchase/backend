import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';

// The row new sales read (createAgentDepositLedgerEntry takes the latest
// effective date). Reading and saving that same row keeps this page and the
// ledger in agreement even if a second row ever exists.
const CURRENT_ROW = { orderBy: [{ effectiveDate: 'desc' as const }, { createdAt: 'desc' as const }] };

export async function getCommissionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    let settings = await prisma.commissionSettings.findFirst(CURRENT_ROW);

    if (!settings) {
      settings = await prisma.commissionSettings.create({
        data: {
          fixedAmount: 0,
          effectiveDate: new Date(),
        },
      });
    }

    res.json(settings);
  } catch (error) {
    console.error('Get commission settings error:', error);
    res.status(500).json({ error: 'Failed to get commission settings' });
  }
}

export async function updateCommissionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { fixedAmount, effectiveDate } = req.body;

    if (fixedAmount === undefined || fixedAmount === null) {
      res.status(400).json({ error: 'fixedAmount is required' });
      return;
    }

    const amount = Number(fixedAmount);
    if (isNaN(amount) || amount < 0) {
      res.status(400).json({ error: 'fixedAmount must be a non-negative number' });
      return;
    }

    // Held back until completion and the completion bonus. Optional, so older
    // clients that send only fixedAmount leave them as they are.
    const optionalAmount = (value: unknown, name: string): number | undefined | null => {
      if (value === undefined) return undefined;
      const n = Number(value);
      if (value === null || value === '' || isNaN(n) || n < 0) {
        res.status(400).json({ error: `${name} must be a non-negative number` });
        return null;
      }
      return n;
    };
    const deferredAmount = optionalAmount(req.body.deferredAmount, 'deferredAmount');
    if (deferredAmount === null) return;
    const completionBonus = optionalAmount(req.body.completionBonus, 'completionBonus');
    if (completionBonus === null) return;

    if (!effectiveDate) {
      res.status(400).json({ error: 'effectiveDate is required' });
      return;
    }

    const parsedDate = new Date(effectiveDate);
    if (isNaN(parsedDate.getTime())) {
      res.status(400).json({ error: 'Invalid effectiveDate' });
      return;
    }

    // There is one settings row, and a sale only picks it up once its date has
    // passed — a future date would leave every sale until then on no commission
    // at all. New amounts take effect from the moment they are saved.
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);
    if (parsedDate.getTime() > endOfToday.getTime()) {
      res.status(400).json({ error: 'The effective date cannot be in the future. New amounts apply to sales approved from the moment you save.' });
      return;
    }

    const data = {
      fixedAmount: amount,
      effectiveDate: parsedDate,
      ...(deferredAmount !== undefined ? { deferredAmount } : {}),
      ...(completionBonus !== undefined ? { completionBonus } : {}),
    };

    let settings = await prisma.commissionSettings.findFirst(CURRENT_ROW);
    const before = settings;

    if (settings) {
      settings = await prisma.commissionSettings.update({ where: { id: settings.id }, data });
    } else {
      settings = await prisma.commissionSettings.create({ data });
    }

    await createAuditLog({
      userId: (req.user as AdminUserPayload | undefined)?.id,
      action: 'UPDATE_COMMISSION_SETTINGS',
      entity: 'CommissionSettings',
      entityId: settings.id,
      oldValues: before
        ? { fixedAmount: before.fixedAmount, deferredAmount: before.deferredAmount, completionBonus: before.completionBonus, effectiveDate: before.effectiveDate }
        : undefined,
      newValues: { fixedAmount: settings.fixedAmount, deferredAmount: settings.deferredAmount, completionBonus: settings.completionBonus, effectiveDate: settings.effectiveDate },
      ipAddress: req.ip,
    });

    res.json(settings);
  } catch (error) {
    console.error('Update commission settings error:', error);
    res.status(500).json({ error: 'Failed to update commission settings' });
  }
}
