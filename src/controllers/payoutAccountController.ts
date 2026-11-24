import { Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types';
import { createAuditLog } from '../services/auditService';
import { phoneVerificationMode, verifyPhoneName } from '../services/phoneVerificationService';
import { ASSIGNABLE_AGENT_ROLES } from '../constants/roles';

/**
 * Each person's own MoMo number for commission. Changing it needs the
 * account password, the network's registered name is looked up and kept, and
 * the person is told by SMS on their phone on file — a stolen password should
 * not be enough to redirect someone's commission quietly.
 */

export const PAYOUT_NETWORKS = ['MTN', 'TELECEL', 'AIRTELTIGO'] as const;

/** 0XXXXXXXXX from 0XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX; null if not a Ghana mobile number. */
export function toLocalGhanaMobile(input: string): string | null {
  const digits = String(input || '').replace(/[\s\-()+]/g, '');
  let local = digits;
  if (/^233\d{9}$/.test(digits)) local = `0${digits.slice(3)}`;
  return /^0[25]\d{8}$/.test(local) ? local : null;
}

const mask = (n: string | null | undefined) => (n ? `${n.slice(0, 3)}****${n.slice(-3)}` : null);

const SELECT = {
  firstName: true, lastName: true, phone: true,
  payoutMomoNumber: true, payoutMomoNetwork: true, payoutMomoName: true, payoutMomoCheck: true, payoutMomoUpdatedAt: true,
} as const;

function view(u: any) {
  return {
    number: u.payoutMomoNumber,
    network: u.payoutMomoNetwork,
    registeredName: u.payoutMomoName,
    check: u.payoutMomoCheck,
    updatedAt: u.payoutMomoUpdatedAt,
  };
}

// GET /admin-users/me/payout-account
export async function getMyPayoutAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const u = await prisma.adminUser.findUnique({ where: { id: req.user!.id }, select: SELECT });
    if (!u) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ payoutAccount: view(u), networks: PAYOUT_NETWORKS });
  } catch (error) {
    console.error('Get payout account error:', error);
    res.status(500).json({ error: 'Failed to load your payout number' });
  }
}

// PUT /admin-users/me/payout-account { number, network, currentPassword }
export async function updateMyPayoutAccount(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { number, network, currentPassword } = req.body ?? {};
    const local = toLocalGhanaMobile(number);
    if (!local) { res.status(400).json({ error: 'Enter a Ghana mobile number, e.g. 0241234567' }); return; }
    const net = String(network || '').toUpperCase();
    if (!(PAYOUT_NETWORKS as readonly string[]).includes(net)) { res.status(400).json({ error: 'Choose the network: MTN, Telecel or AirtelTigo' }); return; }
    if (!currentPassword) { res.status(400).json({ error: 'Enter your password to confirm' }); return; }

    const user = await prisma.adminUser.findUnique({ where: { id: req.user!.id }, select: { ...SELECT, password: true } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    if (!(await bcrypt.compare(String(currentPassword), user.password))) { res.status(400).json({ error: 'Password is incorrect' }); return; }

    // Whose wallet is it? Saved either way so the person paying can see it;
    // a number the network does not know is refused when checks are enforced.
    const fullName = `${user.firstName} ${user.lastName}`.trim();
    const check = phoneVerificationMode() === 'off'
      ? { status: 'UNAVAILABLE' as const, registeredName: null }
      : await verifyPhoneName(local, fullName);
    if (check.status === 'NOT_REGISTERED' && phoneVerificationMode() === 'enforce') {
      res.status(400).json({ error: 'This number is not registered on the mobile network. Check it and try again.' });
      return;
    }

    const updated = await prisma.adminUser.update({
      where: { id: req.user!.id },
      data: {
        payoutMomoNumber: local,
        payoutMomoNetwork: net,
        payoutMomoName: check.registeredName,
        payoutMomoCheck: check.status,
        payoutMomoUpdatedAt: new Date(),
      },
      select: SELECT,
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_PAYOUT_MOMO',
      entity: 'AdminUser',
      entityId: req.user!.id,
      oldValues: { number: mask(user.payoutMomoNumber), network: user.payoutMomoNetwork },
      newValues: { number: mask(local), network: net, registeredName: check.registeredName, check: check.status },
      ipAddress: req.ip,
    });

    // Told on the phone on file, and on the old payout number if different.
    try {
      const { sendSMS } = await import('../services/notificationService');
      const message = `Your commission payout number was set to ${mask(local)} (${net}) on ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Accra' })}. If this was not you, call the office now.`;
      const targets = [...new Set([user.phone, user.payoutMomoNumber].filter((x): x is string => !!x))];
      for (const to of targets) await sendSMS({ to, message });
    } catch (err) {
      console.error('Payout number SMS failed:', err);
    }

    res.json({ payoutAccount: view(updated), networks: PAYOUT_NETWORKS });
  } catch (error) {
    console.error('Update payout account error:', error);
    res.status(500).json({ error: 'Failed to save your payout number' });
  }
}

// GET /admin-users/payout-accounts/summary — who can and cannot be paid yet.
export async function getPayoutAccountSummary(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const people = await prisma.adminUser.findMany({
      where: { isActive: true, role: { name: { in: [...ASSIGNABLE_AGENT_ROLES] } } },
      select: { id: true, firstName: true, lastName: true, phone: true, payoutMomoNumber: true, payoutMomoCheck: true, role: { select: { name: true } } },
      orderBy: { firstName: 'asc' },
    });
    const missing = people.filter((p) => !p.payoutMomoNumber);
    const flagged = people.filter((p) => p.payoutMomoNumber && ['MISMATCH', 'NOT_REGISTERED'].includes(p.payoutMomoCheck || ''));
    res.json({
      total: people.length,
      withNumber: people.length - missing.length,
      missing: missing.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), phone: p.phone, role: p.role.name })),
      nameMismatch: flagged.length,
    });
  } catch (error) {
    console.error('Payout summary error:', error);
    res.status(500).json({ error: 'Failed to load payout numbers' });
  }
}
