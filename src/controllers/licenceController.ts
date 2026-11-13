import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import * as payTriggerClient from '../services/payTrigger/client';

/**
 * Device-lock licences left, for super admins on the Inventory page.
 *
 * Transsion (PayTrigger) reports its own figures. Samsung (Knox Guard) has no
 * licence call in its API: a seat is taken while a device is enrolled and
 * given back when it is released, so seats in use are counted from our
 * enrolled devices, and remaining = seats bought (entered here from the Knox
 * portal) − seats in use.
 */

// Enrolled with Knox Guard, so holding a seat. Released devices (COMPLETE,
// CANCELLED) and deactivated records do not.
const KNOX_SEAT_STATES = ['PENDING', 'APPROVAL_QUEUED', 'APPROVED', 'ACTIVE', 'COMPLETING'];
const PAYTRIGGER_CACHE_MS = 10 * 60_000;

let payTriggerCache: { at: number; value: Record<string, unknown> } | null = null;

function isSuperAdmin(req: AuthenticatedRequest): boolean {
  return req.userType === 'admin' && (req.user as AdminUserPayload)?.role === 'SUPER_ADMIN';
}

async function knoxFigures() {
  const where = { isActive: true, enrollmentStatus: { in: KNOX_SEAT_STATES } };
  const [inUse, onContracts, settings] = await Promise.all([
    prisma.managedDevice.count({ where }),
    prisma.managedDevice.count({ where: { ...where, contractId: { not: null } } }),
    prisma.knoxGuardSettings.findFirst({ select: { licenceSeatsPurchased: true } }),
  ]);
  const purchased = settings?.licenceSeatsPurchased ?? null;
  return {
    source: 'Counted from enrolled devices',
    purchased,
    inUse,
    onContracts,
    inStock: inUse - onContracts,
    remaining: purchased === null ? null : purchased - inUse,
  };
}

async function payTriggerFigures(refresh: boolean) {
  if (!refresh && payTriggerCache && Date.now() - payTriggerCache.at < PAYTRIGGER_CACHE_MS) return payTriggerCache.value;
  const activeDevices = await prisma.payTriggerDevice.count({ where: { enrollmentStatus: 'ACTIVE' } });
  let value: Record<string, unknown>;
  try {
    const result = await payTriggerClient.checkLicence();
    if (!result.success) {
      value = { source: 'PayTrigger', error: String(result.error || 'PayTrigger did not answer'), activeDevices };
    } else if (result.dryRun) {
      value = { source: 'PayTrigger', error: 'PayTrigger is not connected on this server (dry run)', activeDevices };
    } else {
      const d = result.data || {};
      value = {
        source: 'PayTrigger',
        total: d.totalAmountOfLicense ?? null,
        used: d.amountUsedOfLicense ?? null,
        remaining: d.remainingAmountOfLicense ?? null,
        activeDevices,
      };
    }
  } catch (error: any) {
    value = { source: 'PayTrigger', error: error?.message || 'PayTrigger did not answer', activeDevices };
  }
  value.checkedAt = new Date().toISOString();
  // Only good answers are kept; a failure is retried on the next look.
  if (!value.error) payTriggerCache = { at: Date.now(), value };
  return value;
}

// GET /licences?refresh=1 — super admin only
export async function getLicences(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: 'Only a super admin can see licence counts.' });
    return;
  }
  try {
    const refresh = req.query.refresh === '1';
    const [knox, payTrigger] = await Promise.all([knoxFigures(), payTriggerFigures(refresh)]);
    res.json({ knox, payTrigger });
  } catch (error) {
    console.error('Get licences error:', error);
    res.status(500).json({ error: 'Failed to load licence counts' });
  }
}

// PUT /licences/knox { purchased } — super admin only
export async function setKnoxSeatsPurchased(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: 'Only a super admin can change this.' });
    return;
  }
  try {
    const n = Number(req.body?.purchased);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
      res.status(400).json({ error: 'Enter the number of Knox Guard licence seats bought, as a whole number.' });
      return;
    }
    let settings = await prisma.knoxGuardSettings.findFirst({ select: { id: true, licenceSeatsPurchased: true } });
    if (!settings) settings = await prisma.knoxGuardSettings.create({ data: { id: 'singleton' }, select: { id: true, licenceSeatsPurchased: true } });
    await prisma.knoxGuardSettings.update({ where: { id: settings.id }, data: { licenceSeatsPurchased: n } });
    await createAuditLog({
      userId: req.user!.id,
      action: 'SET_KNOX_LICENCE_SEATS',
      entity: 'KnoxGuardSettings',
      entityId: settings.id,
      oldValues: { licenceSeatsPurchased: settings.licenceSeatsPurchased },
      newValues: { licenceSeatsPurchased: n },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ knox: await knoxFigures() });
  } catch (error) {
    console.error('Set Knox licence seats error:', error);
    res.status(500).json({ error: 'Failed to save' });
  }
}
