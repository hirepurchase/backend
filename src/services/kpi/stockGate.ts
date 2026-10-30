import prisma from '../../config/database';
import { CLUSTER_AGENT_ROLE } from '../../constants/roles';
import { monthRange } from '../clusterScorecard/indicators';
import { definitionFor } from './definitions';
import { currentMonth, getTargets, sellerCards } from './index';

/**
 * No new devices for an agent whose sales or quality of sales was below target
 * last month.
 *
 *   - Judged on the last full month, so the answer holds for the whole month
 *     and does not swing with each day's sales.
 *   - Only "Below" blocks. "Close" (within 10%) is still given stock.
 *   - Only the KPIs that have a target count; with no target set for either,
 *     nobody is blocked.
 *   - An agent is exempt for their first three months, counted from their first
 *     approved sale (or from when the account was made, if they have none):
 *     quality looks at sales from two months back, so a new agent shows 0.
 *   - Cluster leaders are not gated: stock reaches agents through them.
 *   - Administrators may assign anyway with a reason, which is audited.
 *     Cluster leaders cannot.
 *
 * Moving devices *away* from a blocked agent is never stopped — that is what a
 * leader is meant to do with stock sitting with someone not selling.
 *
 * It fails open: if the KPIs cannot be worked out, devices can be assigned as
 * before, so a reporting problem never stops stock moving.
 */

export const STOCK_GATE_KEYS = ['NEW_CONTRACTS', 'QUALITY_CONTRACTS'];
export const NEW_AGENT_MONTHS = 3;
const OVERRIDE_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);

export interface StockBlock {
  agentId: string;
  blocked: boolean;
  /** Why an agent is not judged at all, e.g. a new agent. */
  exempt: string | null;
  reasons: string[];
  month: string;
}

export interface StockGate {
  month: string;
  /** False when no sales or quality target is set — nobody is blocked. */
  active: boolean;
  blocks: Map<string, StockBlock>;
}

function previousMonth(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return currentMonth(d);
}

function monthName(month: string): string {
  return monthRange(month).from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export async function getStockGate(agentIds: string[], now = new Date()): Promise<StockGate> {
  const month = previousMonth(now);
  const gate: StockGate = { month, active: false, blocks: new Map() };
  const ids = [...new Set(agentIds.filter(Boolean))];
  if (!ids.length) return gate;

  try {
    const targets = (await getTargets()).AGENT;
    const keys = STOCK_GATE_KEYS.filter((k) => targets[k] !== undefined);
    if (!keys.length) return gate;
    gate.active = true;

    const [people, firstSales] = await Promise.all([
      prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true, role: { select: { name: true } } } }),
      prisma.hirePurchaseContract.groupBy({
        by: ['createdById'],
        where: { createdById: { in: ids }, approvedAt: { not: null } },
        _min: { approvedAt: true },
      }),
    ]);
    const firstSale = new Map(firstSales.map((r) => [r.createdById, r._min.approvedAt]));
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - NEW_AGENT_MONTHS);

    const judged: string[] = [];
    for (const p of people) {
      const base = { agentId: p.id, blocked: false, reasons: [], month };
      if (p.role.name === CLUSTER_AGENT_ROLE) {
        gate.blocks.set(p.id, { ...base, exempt: 'Cluster leaders are not limited — stock reaches agents through them.' });
        continue;
      }
      const start = firstSale.get(p.id) ?? p.createdAt;
      if (start > cutoff) {
        const until = new Date(start);
        until.setMonth(until.getMonth() + NEW_AGENT_MONTHS);
        gate.blocks.set(p.id, { ...base, exempt: `New agent — judged from ${until.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` });
        continue;
      }
      judged.push(p.id);
    }

    const cards = judged.length ? await sellerCards(month, judged) : [];
    for (const card of cards) {
      const reasons: string[] = [];
      for (const key of keys) {
        const line = card.lines.find((l) => l.key === key);
        if (line?.status !== 'BELOW') continue;
        const label = definitionFor('AGENT', key)?.label ?? key;
        reasons.push(`${label} in ${monthName(month)}: ${line.value ?? 0} against a target of ${line.target}.`);
      }
      gate.blocks.set(card.userId, { agentId: card.userId, blocked: reasons.length > 0, exempt: null, reasons, month });
    }
    return gate;
  } catch (err) {
    console.error('Stock gate: KPIs unavailable — devices may be assigned', (err as Error)?.message || err);
    return { month, active: false, blocks: new Map() };
  }
}

export class StockGateError extends Error {
  status = 409;
  constructor(
    message: string,
    public stockBlock: StockBlock,
    public canOverride: boolean,
  ) {
    super(message);
  }
}

export function canOverrideStockGate(role: string | undefined): boolean {
  return !!role && OVERRIDE_ROLES.has(role);
}

/**
 * Throws StockGateError if this agent may not be given devices. Returns the
 * block when an administrator assigned anyway, for the caller to audit.
 */
export async function checkCanReceiveStock(
  agentId: string,
  actor: { role: string },
  overrideReason?: unknown,
): Promise<StockBlock | null> {
  const gate = await getStockGate([agentId]);
  const block = gate.blocks.get(agentId);
  if (!block?.blocked) return null;

  const canOverride = canOverrideStockGate(actor.role);
  const reason = typeof overrideReason === 'string' ? overrideReason.trim() : '';
  if (canOverride && reason) return block;

  const agent = await prisma.adminUser.findUnique({ where: { id: agentId }, select: { firstName: true, lastName: true } });
  const name = agent ? `${agent.firstName} ${agent.lastName}`.trim() : 'This agent';
  throw new StockGateError(
    `${name} was below target last month, so they cannot be given devices. ${block.reasons.join(' ')}` +
      (canOverride ? ' Give a reason to assign anyway.' : ' Give the devices to an agent who is on target.'),
    block,
    canOverride,
  );
}

export function stockGateBody(err: StockGateError) {
  return { error: err.message, stockBlock: err.stockBlock, canOverride: err.canOverride };
}
