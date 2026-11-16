import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { stockScope } from './clusterStockController';

const prismaAny = prisma as any;

const SELLING_ROLES = ['AGENT', 'SALES_AGENT', 'CLUSTER_AGENT'];
/** Unsold stock: on the shelf, or set aside for a sale that is not through yet. */
const IN_HAND = ['AVAILABLE', 'RESERVED'];
const DAY_MS = 86400_000;

/**
 * GET /reports/agent-stock?productId=&clusterLeaderId=&agentId=
 *
 * Which agent holds which devices, what that stock is worth and how long it
 * has been with them. Who may see whom follows the Stock by Agent page: admins
 * see everyone, a cluster leader their cluster and themselves, an agent only
 * themselves.
 *
 * "With the agent since" is the latest transfer of the device to its current
 * holder. Devices given to an agent when they were added, or by editing them,
 * have no transfer record; for those it is the day the device was added.
 */
export async function getAgentStockReport(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { productId, clusterLeaderId, agentId } = (req.query ?? {}) as Record<string, string | undefined>;
    const scope = await stockScope(admin);

    // Leaders and their agents, for the filter and the "cluster leader" column.
    const assignments: Array<{ agentId: string; clusterAgentId: string; clusterAgent: { firstName: string; lastName: string } }> =
      await prismaAny.clusterAgentAssignment.findMany({
        select: { agentId: true, clusterAgentId: true, clusterAgent: { select: { firstName: true, lastName: true } } },
      });
    const leaderOf = new Map(assignments.map((a) => [a.agentId, a]));

    let agentIds: string[] | null = scope;
    if (clusterLeaderId) {
      const inCluster = [clusterLeaderId, ...assignments.filter((a) => a.clusterAgentId === clusterLeaderId).map((a) => a.agentId)];
      agentIds = agentIds ? agentIds.filter((id) => inCluster.includes(id)) : inCluster;
    }
    if (agentId) agentIds = (agentIds ?? [agentId]).filter((id) => id === agentId);

    const holders = await prismaAny.adminUser.findMany({
      where: agentIds ? { id: { in: agentIds } } : { isActive: true, role: { name: { in: SELLING_ROLES } } },
      select: { id: true, firstName: true, lastName: true, phone: true, area: true, district: true, isActive: true, role: { select: { name: true } } },
      orderBy: [{ firstName: 'asc' }],
    });
    const holderIds: string[] = holders.map((h: { id: string }) => h.id);

    const items = holderIds.length
      ? await prismaAny.inventoryItem.findMany({
          where: { assignedAgentId: { in: holderIds }, status: { in: IN_HAND }, ...(productId ? { productId } : {}) },
          select: {
            id: true,
            serialNumber: true,
            status: true,
            lockStatus: true,
            createdAt: true,
            assignedAgentId: true,
            product: { select: { id: true, name: true, basePrice: true, category: { select: { name: true } } } },
          },
        })
      : [];

    // When each device reached its current holder.
    const transfers: Array<{ inventoryItemId: string; toAgentId: string | null; createdAt: Date }> = items.length
      ? await prismaAny.inventoryTransfer.findMany({
          where: { inventoryItemId: { in: items.map((i: { id: string }) => i.id) } },
          select: { inventoryItemId: true, toAgentId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const lastTransfer = new Map<string, { toAgentId: string | null; createdAt: Date }>();
    for (const t of transfers) if (!lastTransfer.has(t.inventoryItemId)) lastTransfer.set(t.inventoryItemId, t);

    // Sold from their stock this calendar month (cancelled sales left out).
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const soldRows = holderIds.length
      ? await prismaAny.inventoryItem.groupBy({
          by: ['assignedAgentId'],
          _count: { _all: true },
          where: {
            assignedAgentId: { in: holderIds },
            status: 'SOLD',
            ...(productId ? { productId } : {}),
            contract: { createdAt: { gte: monthStart }, status: { notIn: ['CANCELLED'] } },
          },
        })
      : [];
    const soldThisMonth = new Map<string, number>(soldRows.map((r: any) => [r.assignedAgentId, r._count._all]));

    const now = Date.now();
    const devices = items.map((item: any) => {
      const transfer = lastTransfer.get(item.id);
      // Exact when the last transfer was to the current holder. A last transfer
      // to someone else means it was moved on later by an edit: it reached the
      // holder some time after that transfer, so that date is the best we have.
      const exact = !!transfer && transfer.toAgentId === item.assignedAgentId;
      const since = transfer?.createdAt ?? item.createdAt;
      return {
        id: item.id,
        serialNumber: item.serialNumber,
        product: item.product?.name ?? '—',
        productId: item.product?.id ?? null,
        category: item.product?.category?.name ?? null,
        status: item.status,
        lockStatus: item.lockStatus,
        value: item.product?.basePrice ?? 0,
        agentId: item.assignedAgentId,
        withAgentSince: since,
        daysHeld: Math.max(0, Math.floor((now - new Date(since).getTime()) / DAY_MS)),
        sinceIsEstimate: !exact,
      };
    });

    const byAgent = new Map<string, typeof devices>();
    for (const d of devices) byAgent.set(d.agentId, [...(byAgent.get(d.agentId) ?? []), d]);

    const agents = holders
      .map((h: any) => {
        const held = byAgent.get(h.id) ?? [];
        const products = new Map<string, number>();
        for (const d of held) products.set(d.product, (products.get(d.product) ?? 0) + 1);
        const leader = leaderOf.get(h.id);
        return {
          id: h.id,
          name: `${h.firstName} ${h.lastName}`.trim(),
          phone: h.phone,
          role: h.role?.name ?? null,
          area: h.area,
          district: h.district,
          isActive: h.isActive,
          clusterLeader: leader ? `${leader.clusterAgent.firstName} ${leader.clusterAgent.lastName}`.trim() : null,
          inStock: held.filter((d: any) => d.status === 'AVAILABLE').length,
          reserved: held.filter((d: any) => d.status === 'RESERVED').length,
          total: held.length,
          value: Math.round(held.reduce((s: number, d: any) => s + d.value, 0) * 100) / 100,
          oldestDays: held.length ? Math.max(...held.map((d: any) => d.daysHeld)) : null,
          over30: held.filter((d: any) => d.daysHeld >= 30).length,
          over60: held.filter((d: any) => d.daysHeld >= 60).length,
          soldThisMonth: soldThisMonth.get(h.id) ?? 0,
          products: [...products.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        };
      })
      .sort((a: any, b: any) => b.total - a.total || a.name.localeCompare(b.name));

    const agentName = new Map<string, string>(agents.map((a: any) => [a.id, a.name]));

    // Stock nobody holds yet: the pile waiting to be given out. Whole-book view only.
    let unassigned: { count: number; value: number } | null = null;
    if (scope === null && !clusterLeaderId && !agentId) {
      const pool = await prismaAny.inventoryItem.findMany({
        where: { assignedAgentId: null, status: { in: IN_HAND }, ...(productId ? { productId } : {}) },
        select: { product: { select: { basePrice: true } } },
      });
      unassigned = { count: pool.length, value: Math.round(pool.reduce((s: number, p: any) => s + (p.product?.basePrice ?? 0), 0) * 100) / 100 };
    }

    // Filter choices: leaders in this caller's view, and products.
    const leaders = [...new Map(
      assignments
        .filter((a) => !scope || scope.includes(a.clusterAgentId))
        .map((a) => [a.clusterAgentId, { id: a.clusterAgentId, name: `${a.clusterAgent.firstName} ${a.clusterAgent.lastName}`.trim() }]),
    ).values()].sort((a, b) => a.name.localeCompare(b.name));
    const productOptions = await prismaAny.product.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });

    res.json({
      generatedAt: new Date().toISOString(),
      scope: scope === null ? 'all' : 'cluster',
      summary: {
        agents: agents.length,
        agentsHolding: agents.filter((a: any) => a.total > 0).length,
        devices: devices.length,
        reserved: devices.filter((d: any) => d.status === 'RESERVED').length,
        value: Math.round(devices.reduce((s: number, d: any) => s + d.value, 0) * 100) / 100,
        over30: devices.filter((d: any) => d.daysHeld >= 30).length,
        over60: devices.filter((d: any) => d.daysHeld >= 60).length,
        soldThisMonth: agents.reduce((s: number, a: any) => s + a.soldThisMonth, 0),
        unassigned,
      },
      agents,
      devices: devices
        .map((d: any) => ({ ...d, agent: agentName.get(d.agentId) ?? '—' }))
        .sort((a: any, b: any) => b.daysHeld - a.daysHeld),
      filters: { leaders, products: productOptions },
    });
  } catch (error) {
    console.error('getAgentStockReport error:', error);
    res.status(500).json({ error: 'Failed to load the agent stock report' });
  }
}
