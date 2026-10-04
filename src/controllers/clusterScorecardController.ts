import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import { hasAnyPermission, PERMISSIONS } from '../constants/permissions';
import { CLUSTER_AGENT_ROLE } from '../constants/roles';
import { INDICATORS } from '../services/clusterScorecard/definitions';
import {
  approveMonth,
  closeMonth,
  currentMonth,
  getMonth,
  getRules,
  recomputeMonth,
  setPaid,
  validateRule,
} from '../services/clusterScorecard/periods';

/**
 * Cluster leader scorecard, mounted at /api/cluster-scorecard.
 *
 * Admins with VIEW_REPORTS see every leader; a cluster leader sees only their
 * own card. Rates, closing, approving and recording payment need
 * MANAGE_COMMISSION_SETTINGS — the permission that already governs agent pay.
 */

const user = (req: AuthenticatedRequest) => req.user as AdminUserPayload;
const fail = (res: Response, err: unknown, status = 400) =>
  res.status(status).json({ error: (err as Error)?.message || 'Request failed' });

function monthParam(req: AuthenticatedRequest): string {
  const raw = String(req.params.month || req.query.month || currentMonth());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw new Error('Month must be YYYY-MM');
  return raw;
}

/** Everyone the caller may see: all leaders, or only themselves. */
function visibleLeaders(req: AuthenticatedRequest): string[] | undefined | null {
  const u = user(req);
  if (u.role === 'SUPER_ADMIN' || hasAnyPermission(u.permissions, [PERMISSIONS.VIEW_REPORTS, PERMISSIONS.MANAGE_COMMISSION_SETTINGS])) return undefined;
  if (u.role === CLUSTER_AGENT_ROLE) return [u.id];
  return null;
}

export async function getScorecard(req: AuthenticatedRequest, res: Response) {
  try {
    const scope = visibleLeaders(req);
    if (scope === null) return res.status(403).json({ error: 'Insufficient permissions' });
    const month = monthParam(req);
    const data = await getMonth(month, scope);
    // A leader sees their own figures, not the configuration behind everyone's pay.
    res.json({ ...data, indicators: INDICATORS, canManage: scope === undefined && hasManage(req) });
  } catch (err) {
    fail(res, err);
  }
}

function hasManage(req: AuthenticatedRequest) {
  const u = user(req);
  return u.role === 'SUPER_ADMIN' || hasAnyPermission(u.permissions, [PERMISSIONS.MANAGE_COMMISSION_SETTINGS]);
}

export async function getConfiguration(_req: AuthenticatedRequest, res: Response) {
  try {
    const rules = await getRules();
    res.json({ definitions: INDICATORS, rules: rules.indicators, settings: rules.settings });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function putIndicators(req: AuthenticatedRequest, res: Response) {
  const items = Array.isArray(req.body?.indicators) ? req.body.indicators : null;
  if (!items) return fail(res, new Error('indicators must be a list'));
  const validated: ReturnType<typeof validateRule>[] = [];
  for (const item of items) {
    const v = validateRule(item);
    if (v.error) return fail(res, new Error(v.error));
    validated.push(v);
  }
  try {
    const before = await getRules();
    await prisma.$transaction(
      validated.map((v) =>
        prisma.clusterScorecardIndicator.update({
          where: { key: v.key! },
          data: {
            enabled: v.enabled,
            payoutType: v.payoutType,
            rate: v.rate,
            unitAmount: v.unitAmount,
            target: v.target,
            targetDirection: v.targetDirection,
            targetAmount: v.targetAmount,
            tiers: (v.tiers ?? undefined) as any,
            cap: v.cap,
            updatedById: user(req).id,
          },
        }),
      ),
    );
    const after = await getRules();
    await createAuditLog({
      userId: user(req).id,
      action: 'UPDATE_CLUSTER_SCORECARD_RATES',
      entity: 'ClusterScorecardIndicator',
      oldValues: { indicators: before.indicators as any },
      newValues: { indicators: after.indicators as any },
      ipAddress: req.ip,
    });
    res.json({ definitions: INDICATORS, rules: after.indicators, settings: after.settings });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function putSettings(req: AuthenticatedRequest, res: Response) {
  const b = req.body || {};
  const num = (v: unknown, min: number, max: number, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
    return n;
  };
  try {
    const data: Record<string, unknown> = {};
    if ('baseAmount' in b) data.baseAmount = num(b.baseAmount, 0, 1_000_000, 'Base amount');
    if ('parGateCeiling' in b) data.parGateCeiling = num(b.parGateCeiling, 0, 100, 'PAR ceiling');
    if ('depositRemitDays' in b) data.depositRemitDays = Math.round(num(b.depositRemitDays, 0, 90, 'Deposit days'));
    if ('parGateEnabled' in b) data.parGateEnabled = Boolean(b.parGateEnabled);
    if ('gateWithholdsBase' in b) data.gateWithholdsBase = Boolean(b.gateWithholdsBase);
    const before = await prisma.clusterScorecardSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton' }, update: {} });
    const after = await prisma.clusterScorecardSettings.update({ where: { id: 'singleton' }, data: { ...data, updatedById: user(req).id } });
    await createAuditLog({
      userId: user(req).id,
      action: 'UPDATE_CLUSTER_SCORECARD_SETTINGS',
      entity: 'ClusterScorecardSettings',
      oldValues: Object.fromEntries(Object.keys(data).map((k) => [k, (before as any)[k]])),
      newValues: data,
      ipAddress: req.ip,
    });
    res.json({ settings: after });
  } catch (err) {
    fail(res, err);
  }
}

async function lifecycle(req: AuthenticatedRequest, res: Response, action: string, run: (month: string) => Promise<unknown>) {
  try {
    const month = monthParam(req);
    const result = await run(month);
    await createAuditLog({ userId: user(req).id, action, entity: 'ClusterScorecardPeriod', entityId: month, newValues: { month, ...(req.body || {}) }, ipAddress: req.ip });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
}

export const closeScorecard = (req: AuthenticatedRequest, res: Response) =>
  lifecycle(req, res, 'CLOSE_CLUSTER_SCORECARD', (m) => closeMonth(m, user(req).id));
export const recomputeScorecard = (req: AuthenticatedRequest, res: Response) =>
  lifecycle(req, res, 'RECOMPUTE_CLUSTER_SCORECARD', (m) => recomputeMonth(m, user(req).id, Boolean(req.body?.useCurrentRules)));
export const approveScorecard = (req: AuthenticatedRequest, res: Response) =>
  lifecycle(req, res, 'APPROVE_CLUSTER_SCORECARD', (m) => approveMonth(m, user(req).id));
export const markPaid = (req: AuthenticatedRequest, res: Response) =>
  lifecycle(req, res, 'PAY_CLUSTER_SCORECARD', (m) => setPaid(m, String(req.params.leaderId), true, user(req).id, String(req.body?.reference || '')));
export const unmarkPaid = (req: AuthenticatedRequest, res: Response) =>
  lifecycle(req, res, 'UNPAY_CLUSTER_SCORECARD', (m) => setPaid(m, String(req.params.leaderId), false, user(req).id));
