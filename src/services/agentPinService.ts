import * as crypto from 'crypto';
import prisma from '../config/database';
import { SELLING_AGENT_ROLES, isSellingAgentRole } from '../constants/roles';

/**
 * The agent payment PIN: six digits an agent types on the short code to pay
 * in the deposits they hold, from any phone.
 *
 * It names the agent; the money comes from whichever phone dialled. It is
 * stored readable because the agent is shown it, so the only thing that may
 * return it is the agent's own dashboard endpoint — never a staff list, an
 * auth payload or an audit entry.
 *
 * This project's sellers are AGENT and CLUSTER_AGENT (SELLING_AGENT_ROLES);
 * both hold deposits, so both get a PIN.
 */

export const PIN_PATTERN = /^[1-9]\d{5}$/;
export const PIN_FAILURE_LIMIT = 5;
export const PIN_LOCKOUT_MS = 60 * 60_000;

function newPin(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Give a selling agent a PIN if they have none. Safe to call again: an
 * existing PIN is never changed. Returns the PIN, or null for anyone who is
 * not a selling agent.
 */
export async function issuePaymentPin(userId: string): Promise<string | null> {
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { paymentPin: true, role: { select: { name: true } } },
  });
  if (!user || !isSellingAgentRole(user.role?.name)) return null;
  if (user.paymentPin) return user.paymentPin;

  for (let attempt = 0; attempt < 20; attempt++) {
    const pin = newPin();
    try {
      // Only fills an empty PIN, so two callers racing cannot overwrite each other.
      const set = await prisma.adminUser.updateMany({ where: { id: userId, paymentPin: null }, data: { paymentPin: pin } });
      const fresh = await prisma.adminUser.findUnique({ where: { id: userId }, select: { paymentPin: true } });
      if (set.count > 0 || fresh?.paymentPin) return fresh?.paymentPin ?? pin;
    } catch (error: any) {
      if (error?.code === 'P2002') continue; // another agent holds this PIN — draw again
      throw error;
    }
  }
  throw new Error('Could not issue a unique payment PIN');
}

/** The active selling agent this PIN belongs to, or null. Anything but six digits is a wrong PIN. */
export async function findAgentByPin(pin: string): Promise<{ id: string; firstName: string; lastName: string; phone: string | null } | null> {
  if (!PIN_PATTERN.test(pin)) return null;
  return prisma.adminUser.findFirst({
    where: { paymentPin: pin, isActive: true, role: { name: { in: [...SELLING_AGENT_ROLES] } } },
    select: { id: true, firstName: true, lastName: true, phone: true },
  });
}

// ── Signed session: the PIN is checked once, then carried ─────────────────
//
// The short-code endpoint is called by Hubtel without authentication, and the
// agent's id rides in the session state after the PIN is accepted. Without a
// signature, a forged state could skip the PIN for a known agent id. The tag
// ties the agent to the phone that dialled and is checked at every later step.

const SESSION_SECRET = process.env.USSD_SESSION_SECRET || process.env.JWT_SECRET || 'ussd-session-secret';

export function agentSessionTag(agentId: string, msisdn: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(`${agentId}|${msisdn}`).digest('hex').slice(0, 16);
}

export function isValidAgentSessionTag(agentId: string, msisdn: string, tag: string | undefined): boolean {
  if (!tag || tag.length !== 16) return false;
  const expected = Buffer.from(agentSessionTag(agentId, msisdn));
  const given = Buffer.from(tag);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ── Lockout: per dialling phone, not per agent ─────────────────────────────

export async function isPhoneLockedOut(msisdn: string, now: Date = new Date()): Promise<boolean> {
  const failures = await prisma.agentPinFailure.count({
    where: { msisdn, createdAt: { gt: new Date(now.getTime() - PIN_LOCKOUT_MS) } },
  });
  return failures >= PIN_FAILURE_LIMIT;
}

/** Record a miss; true when this phone is now shut out for the hour. */
export async function recordPinFailure(msisdn: string, now: Date = new Date()): Promise<boolean> {
  await prisma.agentPinFailure.create({ data: { msisdn, createdAt: now } });
  // Only the last hour matters; drop anything older than a day as we go.
  await prisma.agentPinFailure.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } });
  return isPhoneLockedOut(msisdn, now);
}

export async function clearPinFailures(msisdn: string): Promise<void> {
  await prisma.agentPinFailure.deleteMany({ where: { msisdn } });
}
