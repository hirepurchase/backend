import { Response } from 'express';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import { hasAnyPermission, PERMISSIONS } from '../constants/permissions';
import { CLUSTER_AGENT_ROLE, CUSTOMER_SERVICE_ROLE } from '../constants/roles';
import { KPI_DEFINITIONS, isKpiGroup, KpiGroup } from '../services/kpi/definitions';
import {
  KPI_SELLER_ROLES,
  csoCards,
  currentMonth,
  currentTeam,
  getTargets,
  monthInfo,
  rank,
  sellerCards,
  setTargets,
  teamCards,
  validateTarget,
} from '../services/kpi';

/**
 * KPI pages, mounted at /api/kpi.
 *
 *   GET /me       the caller's own card(s), chosen by role: an agent's own
 *                 book; a cluster leader's own sales, their team and each of
 *                 their agents; a customer service officer's calls.
 *   GET /people   everyone in a group, ranked — administrators (VIEW_REPORTS),
 *                 and a cluster leader for their own agents.
 *   GET|PUT /targets  the monthly targets (MANAGE_SETTINGS to change).
 */

const user = (req: AuthenticatedRequest) => req.user as AdminUserPayload;
const fail = (res: Response, err: unknown, status = 400) =>
  res.status(status).json({ error: (err as Error)?.message || 'Request failed' });

function monthParam(req: AuthenticatedRequest): string {
  const raw = String(req.query.month || currentMonth());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw new Error('Month must be YYYY-MM');
  return raw;
}

function seesEveryone(u: AdminUserPayload): boolean {
  return u.role === 'SUPER_ADMIN' || hasAnyPermission(u.permissions, [PERMISSIONS.VIEW_REPORTS]);
}

function canSetTargets(u: AdminUserPayload): boolean {
  return u.role === 'SUPER_ADMIN' || hasAnyPermission(u.permissions, [PERMISSIONS.MANAGE_SETTINGS]);
}

function meta(month: string) {
  const { range: _range, ...info } = monthInfo(month);
  return { ...info, definitions: KPI_DEFINITIONS };
}

export async function getMyKpis(req: AuthenticatedRequest, res: Response) {
  try {
    const u = user(req);
    const month = monthParam(req);
    const base = { ...meta(month), seesEveryone: seesEveryone(u), canSetTargets: canSetTargets(u) };

    if (u.role === CLUSTER_AGENT_ROLE) {
      const agentIds = await currentTeam(u.id);
      const [own, team, agents] = await Promise.all([
        sellerCards(month, [u.id]),
        teamCards(month, [u.id]),
        agentIds.length ? sellerCards(month, agentIds) : Promise.resolve([]),
      ]);
      return res.json({ ...base, kind: 'CLUSTER', own: own[0] ?? null, team: team[0] ?? null, agents: rank(agents) });
    }
    if (KPI_SELLER_ROLES.includes(u.role)) {
      const own = await sellerCards(month, [u.id]);
      return res.json({ ...base, kind: 'AGENT', own: own[0] ?? null });
    }
    if (u.role === CUSTOMER_SERVICE_ROLE) {
      const own = await csoCards(month, [u.id]);
      return res.json({ ...base, kind: 'CSO', own: own[0] ?? null });
    }
    res.json({ ...base, kind: 'NONE' });
  } catch (err) {
    fail(res, err);
  }
}

export async function getPeopleKpis(req: AuthenticatedRequest, res: Response) {
  try {
    const u = user(req);
    const group = String(req.query.group || 'AGENT');
    if (!isKpiGroup(group)) return fail(res, new Error('group must be AGENT, TEAM or CSO'));
    const month = monthParam(req);

    let cards;
    if (seesEveryone(u)) {
      cards = group === 'AGENT' ? await sellerCards(month) : group === 'TEAM' ? await teamCards(month) : await csoCards(month);
    } else if (u.role === CLUSTER_AGENT_ROLE && group === 'AGENT') {
      const agentIds = await currentTeam(u.id);
      cards = agentIds.length ? await sellerCards(month, agentIds) : [];
    } else {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    res.json({ ...meta(month), group, people: rank(cards) });
  } catch (err) {
    fail(res, err);
  }
}

export async function getKpiTargets(req: AuthenticatedRequest, res: Response) {
  try {
    res.json({ definitions: KPI_DEFINITIONS, targets: await getTargets(), canSetTargets: canSetTargets(user(req)) });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function putKpiTargets(req: AuthenticatedRequest, res: Response) {
  const u = user(req);
  if (!canSetTargets(u)) return res.status(403).json({ error: 'Insufficient permissions' });
  const group = req.body?.group;
  const items = Array.isArray(req.body?.targets) ? req.body.targets : null;
  if (!isKpiGroup(group)) return fail(res, new Error('group must be AGENT, TEAM or CSO'));
  if (!items) return fail(res, new Error('targets must be a list'));
  try {
    const validated = items.map((i: { key?: unknown; target?: unknown }) => validateTarget(group as KpiGroup, i?.key, i?.target));
    const before = (await getTargets())[group as KpiGroup];
    const targets = await setTargets(group as KpiGroup, validated, u.id);
    await createAuditLog({
      userId: u.id,
      action: 'UPDATE_KPI_TARGETS',
      entity: 'KpiTarget',
      entityId: group,
      oldValues: before,
      newValues: targets[group as KpiGroup],
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
    res.json({ definitions: KPI_DEFINITIONS, targets, canSetTargets: true });
  } catch (err) {
    fail(res, err);
  }
}
