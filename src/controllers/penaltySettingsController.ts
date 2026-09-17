import { Response } from 'express';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import {
  getPenaltySettings,
  accrueExpiryPenalties,
  waivePenalty,
  reinstatePenalty,
  OWED_PENALTY_WHERE,
  PENALTY_MODE,
} from '../services/penaltyService';
import { resolveContractScope, scopeAllows } from '../services/scopeService';
import prisma from '../config/database';

const prismaAny = prisma as any;

// GET /settings/penalties
export async function getPenaltyConfig(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const settings = await getPenaltySettings();

    // "Hold the device while penalties are unpaid" already exists as
    // KnoxGuardSettings.blockOnUnpaidPenalties and is what the lock decision
    // actually reads. Surfaced here rather than duplicated, so the two cannot
    // disagree about the same question.
    const knox = await prismaAny.knoxGuardSettings.findFirst({
      select: { blockOnUnpaidPenalties: true },
    });

    // How much is currently sitting unpaid, so the page shows the consequence
    // of the switch rather than only its position.
    const [unpaid, pastTerm] = await Promise.all([
      prismaAny.penalty.aggregate({ _sum: { amount: true, paidAmount: true }, where: OWED_PENALTY_WHERE }),
      prismaAny.hirePurchaseContract.aggregate({
        _count: { _all: true },
        _sum: { outstandingBalance: true },
        where: { status: 'ACTIVE', endDate: { lt: new Date() }, outstandingBalance: { gt: 0 } },
      }),
    ]);

    res.json({
      settings: { ...settings, blockUnlockOnPenalty: knox?.blockOnUnpaidPenalties ?? false },
      stats: {
        unpaidPenaltyTotal:
          Math.round(((unpaid._sum.amount ?? 0) - (unpaid._sum.paidAmount ?? 0)) * 100) / 100,
        contractsPastTerm: pastTerm._count._all,
        outstandingPastTerm: Math.round((pastTerm._sum.outstandingBalance ?? 0) * 100) / 100,
      },
    });
  } catch (error) {
    console.error('Get penalty settings error:', error);
    res.status(500).json({ error: 'Failed to load penalty settings' });
  }
}

// PUT /settings/penalties
export async function updatePenaltyConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const current = await getPenaltySettings();

    const {
      expiryPenaltyEnabled,
      expiryPenaltyMode,
      expiryPenaltyRate,
      expiryGraceDays,
      maxPenaltyPercentage,
      notifyCustomer,
      blockUnlockOnPenalty,
    } = req.body ?? {};

    if (expiryPenaltyMode !== undefined && ![PENALTY_MODE.FIXED, PENALTY_MODE.DAILY].includes(expiryPenaltyMode)) {
      res.status(400).json({ error: 'Mode must be FIXED or DAILY' });
      return;
    }
    // A daily rate is compounding pressure on someone already behind; the cap
    // is deliberately much tighter than the one-off rate.
    const mode = expiryPenaltyMode ?? current.expiryPenaltyMode;
    const rateCeiling = mode === PENALTY_MODE.DAILY ? 5 : 100;
    if (
      expiryPenaltyRate !== undefined &&
      (Number.isNaN(Number(expiryPenaltyRate)) || Number(expiryPenaltyRate) < 0 || Number(expiryPenaltyRate) > rateCeiling)
    ) {
      res.status(400).json({
        error: `Rate must be between 0 and ${rateCeiling}% for ${mode === PENALTY_MODE.DAILY ? 'a daily' : 'a one-off'} charge`,
      });
      return;
    }
    if (expiryGraceDays !== undefined && (Number(expiryGraceDays) < 0 || Number(expiryGraceDays) > 180)) {
      res.status(400).json({ error: 'Grace days must be between 0 and 180' });
      return;
    }
    if (
      maxPenaltyPercentage !== undefined &&
      (Number(maxPenaltyPercentage) < 1 || Number(maxPenaltyPercentage) > 100)
    ) {
      res.status(400).json({ error: 'The cap must be between 1% and 100% of the outstanding balance' });
      return;
    }

    const turningOn = expiryPenaltyEnabled === true && !current.expiryPenaltyEnabled;

    const updated = await prismaAny.penaltySettings.update({
      where: { id: current.id },
      data: {
        ...(expiryPenaltyEnabled !== undefined ? { expiryPenaltyEnabled: Boolean(expiryPenaltyEnabled) } : {}),
        ...(expiryPenaltyMode !== undefined ? { expiryPenaltyMode } : {}),
        ...(expiryPenaltyRate !== undefined ? { expiryPenaltyRate: Number(expiryPenaltyRate) } : {}),
        ...(expiryGraceDays !== undefined ? { expiryGraceDays: Number(expiryGraceDays) } : {}),
        ...(maxPenaltyPercentage !== undefined ? { maxPenaltyPercentage: Number(maxPenaltyPercentage) } : {}),
        ...(notifyCustomer !== undefined ? { notifyCustomer: Boolean(notifyCustomer) } : {}),

        // Re-stamped on every enable, not only the first. Stamping once meant
        // switching the feature off for a month to review it and back on again
        // silently backfilled that whole month in DAILY mode — the exact
        // retroactive charge this field exists to prevent. Each activation
        // starts its own floor; charges already written keep their dedupe keys,
        // so nothing is double-charged.
        ...(turningOn ? { activatedAt: new Date() } : {}),
        updatedById: admin.id,
      },
    });

    // Written through to the Knox setting the lock decision reads, so this
    // page stays the single place an admin manages penalty behaviour without
    // a second flag that could disagree with it.
    if (blockUnlockOnPenalty !== undefined) {
      const knox = await prismaAny.knoxGuardSettings.findFirst({ select: { id: true } });
      if (knox) {
        await prismaAny.knoxGuardSettings.update({
          where: { id: knox.id },
          data: { blockOnUnpaidPenalties: Boolean(blockUnlockOnPenalty) },
        });
      }
    }

    await createAuditLog({
      userId: admin.id,
      action: turningOn ? 'ENABLE_EXPIRY_PENALTIES' : 'UPDATE_PENALTY_SETTINGS',
      entity: 'PenaltySettings',
      entityId: updated.id,
      oldValues: current as unknown as Record<string, unknown>,
      newValues: updated as unknown as Record<string, unknown>,
    });

    res.json({
      settings: {
        ...updated,
        ...(blockUnlockOnPenalty !== undefined ? { blockUnlockOnPenalty: Boolean(blockUnlockOnPenalty) } : {}),
      },
    });
  } catch (error) {
    console.error('Update penalty settings error:', error);
    res.status(500).json({ error: 'Failed to update penalty settings' });
  }
}

// POST /settings/penalties/preview — what would be charged if this ran now
export async function previewExpiryPenalties(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { expiryPenaltyMode, expiryPenaltyRate, expiryGraceDays, maxPenaltyPercentage } = req.body ?? {};
    const overrides: Record<string, unknown> = {};
    if (expiryPenaltyMode !== undefined) overrides.expiryPenaltyMode = expiryPenaltyMode;
    if (expiryPenaltyRate !== undefined) overrides.expiryPenaltyRate = Number(expiryPenaltyRate);
    if (expiryGraceDays !== undefined) overrides.expiryGraceDays = Number(expiryGraceDays);
    if (maxPenaltyPercentage !== undefined) overrides.maxPenaltyPercentage = Number(maxPenaltyPercentage);

    const result = await accrueExpiryPenalties({
      dryRun: true,
      overrides: Object.keys(overrides).length ? (overrides as any) : undefined,
    });
    res.json({ ...result, details: result.details.slice(0, 50) });
  } catch (error) {
    console.error('Preview expiry penalties error:', error);
    res.status(500).json({ error: 'Failed to build the preview' });
  }
}

// POST /settings/penalties/run — apply now rather than waiting for the cron
export async function runExpiryPenalties(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const result = await accrueExpiryPenalties();
    await createAuditLog({
      userId: admin.id,
      action: 'RUN_EXPIRY_PENALTIES',
      entity: 'PenaltySettings',
      newValues: {
        contractsCharged: result.contractsCharged,
        penaltiesCreated: result.penaltiesCreated,
        totalCharged: result.totalCharged,
      },
    });
    res.json({ ...result, details: result.details.slice(0, 50) });
  } catch (error) {
    console.error('Run expiry penalties error:', error);
    res.status(500).json({ error: 'Failed to run the accrual' });
  }
}

/**
 * A penalty belongs to one customer's contract, so cancelling or reinstating it
 * is scoped like every other contract action rather than granted wholesale by
 * a settings permission.
 */
async function assertPenaltyInScope(
  req: AuthenticatedRequest,
  penaltyId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const admin = req.user as AdminUserPayload;
  const penalty = await prismaAny.penalty.findUnique({
    where: { id: penaltyId },
    select: { contract: { select: { createdById: true } } },
  });
  if (!penalty) return { ok: false, status: 404, error: 'Penalty not found' };

  if (admin.role === 'SUPER_ADMIN') return { ok: true };

  const scope = await resolveContractScope(admin);
  if (!scopeAllows(scope, penalty.contract.createdById)) {
    return { ok: false, status: 403, error: 'This contract is outside your portfolio' };
  }
  return { ok: true };
}

// POST /settings/penalties/:penaltyId/waive
export async function waivePenaltyCharge(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { penaltyId } = req.params;
    const { reason } = req.body ?? {};

    // Cancelling a charge against a customer is not a thing to do silently, and
    // the audit entry is worthless without a stated reason.
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      res.status(400).json({ error: 'Give a reason for waiving this charge (at least 5 characters)' });
      return;
    }

    const scoped = await assertPenaltyInScope(req, penaltyId);
    if (!scoped.ok) {
      res.status(scoped.status).json({ error: scoped.error });
      return;
    }

    const result = await waivePenalty({
      penaltyId,
      adminUserId: admin.id,
      reason: reason.trim(),
    });

    res.json({
      message: 'Penalty waived',
      penalty: result.penalty,
      penaltyOutstanding: result.penaltyOutstanding,
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to waive the penalty';
    const known = /not found|already been waived/i.test(message);
    console.error('Waive penalty error:', error);
    res.status(known ? 400 : 500).json({ error: message });
  }
}

// POST /settings/penalties/:penaltyId/reinstate
export async function reinstatePenaltyCharge(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { penaltyId } = req.params;
    const { reason } = req.body ?? {};

    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      res.status(400).json({ error: 'Give a reason for reinstating this charge (at least 5 characters)' });
      return;
    }

    const scoped = await assertPenaltyInScope(req, penaltyId);
    if (!scoped.ok) {
      res.status(scoped.status).json({ error: scoped.error });
      return;
    }

    const result = await reinstatePenalty({
      penaltyId,
      adminUserId: admin.id,
      reason: reason.trim(),
    });

    res.json({
      message: 'Penalty reinstated',
      penalty: result.penalty,
      penaltyOutstanding: result.penaltyOutstanding,
    });
  } catch (error: any) {
    const message = error?.message || 'Failed to reinstate the penalty';
    const known = /not found|not waived/i.test(message);
    console.error('Reinstate penalty error:', error);
    res.status(known ? 400 : 500).json({ error: message });
  }
}
