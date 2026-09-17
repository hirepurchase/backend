import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';

const prismaAny = prisma as any;

/**
 * The agents whose stock this caller may see and move: the ones they supervise,
 * plus themselves, because a cluster agent sells and holds stock of their own.
 * Returns null for a caller who should see everything.
 */
async function stockScope(admin: AdminUserPayload): Promise<string[] | null> {
  if (admin.role === 'SUPER_ADMIN' || admin.role === 'ADMIN') return null;
  const rows = await prismaAny.clusterAgentAssignment.findMany({
    where: { clusterAgentId: admin.id },
    select: { agentId: true },
  });
  return [...rows.map((r: { agentId: string }) => r.agentId), admin.id];
}

// GET /cluster/stock
//
// What each of my agents is holding. Only unsold items count as stock — a
// device already on a contract is the customer's, not the agent's.
export async function getClusterStock(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const agentIds = await stockScope(admin);

    if (agentIds !== null && agentIds.length === 0) {
      res.json({ agents: [], unassigned: [], summary: { agents: 0, inStock: 0, sold: 0 } });
      return;
    }

    const [holders, items] = await Promise.all([
      prismaAny.adminUser.findMany({
        where: agentIds ? { id: { in: agentIds } } : { isActive: true, role: { name: { in: ['AGENT', 'SALES_AGENT', 'CLUSTER_AGENT'] } } },
        select: {
          id: true, firstName: true, lastName: true, phone: true,
          area: true, district: true, isActive: true,
          role: { select: { name: true } },
        },
        orderBy: [{ firstName: 'asc' }],
      }),
      prismaAny.inventoryItem.findMany({
        where: {
          ...(agentIds ? { assignedAgentId: { in: agentIds } } : { assignedAgentId: { not: null } }),
        },
        include: {
          product: { select: { id: true, name: true } },
          contract: { select: { contractNumber: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const byAgent = new Map<string, any[]>();
    for (const item of items) {
      const list = byAgent.get(item.assignedAgentId) ?? [];
      list.push(item);
      byAgent.set(item.assignedAgentId, list);
    }

    const shape = (item: any) => ({
      id: item.id,
      serialNumber: item.serialNumber,
      product: item.product?.name ?? null,
      productId: item.product?.id ?? null,
      status: item.status,
      lockStatus: item.lockStatus,
      // Sold stock cannot be moved — it belongs to a contract.
      isMovable: item.status !== 'SOLD' && !item.contractId,
      contractNumber: item.contract?.contractNumber ?? null,
      addedAt: item.createdAt,
    });

    const agents = holders.map((holder: any) => {
      const held = (byAgent.get(holder.id) ?? []).map(shape);
      return {
        id: holder.id,
        name: `${holder.firstName} ${holder.lastName}`.trim(),
        phone: holder.phone,
        area: holder.area,
        district: holder.district,
        role: holder.role.name,
        isActive: holder.isActive,
        isSelf: holder.id === admin.id,
        inStock: held.filter((i: any) => i.isMovable).length,
        sold: held.filter((i: any) => !i.isMovable).length,
        items: held,
      };
    });

    const inStock = agents.reduce((sum: number, a: any) => sum + a.inStock, 0);
    const sold = agents.reduce((sum: number, a: any) => sum + a.sold, 0);

    res.json({
      agents: agents.sort((a: any, b: any) => b.inStock - a.inStock),
      summary: { agents: agents.length, inStock, sold },
    });
  } catch (error) {
    console.error('getClusterStock error:', error);
    res.status(500).json({ error: 'Failed to load stock' });
  }
}

// POST /cluster/stock/transfer
//
// Moves devices between agents in the caller's own cluster.
export async function transferClusterStock(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { inventoryItemIds, toAgentId, reason } = req.body ?? {};

    if (!Array.isArray(inventoryItemIds) || inventoryItemIds.length === 0) {
      res.status(400).json({ error: 'Select at least one device to transfer' });
      return;
    }
    if (!toAgentId || typeof toAgentId !== 'string') {
      res.status(400).json({ error: 'Choose the agent to transfer to' });
      return;
    }

    const agentIds = await stockScope(admin);

    // Both ends must be inside the caller's cluster, or a supervisor could move
    // stock out of the company's sight into someone else's book.
    if (agentIds !== null && !agentIds.includes(toAgentId)) {
      res.status(403).json({ error: 'You can only transfer stock to agents you supervise' });
      return;
    }

    const recipient = await prismaAny.adminUser.findUnique({
      where: { id: toAgentId },
      select: { id: true, isActive: true, firstName: true, lastName: true, role: { select: { name: true } } },
    });
    if (!recipient) {
      res.status(404).json({ error: 'That agent was not found' });
      return;
    }
    if (!recipient.isActive) {
      res.status(400).json({ error: 'That agent is deactivated' });
      return;
    }

    const ids = Array.from(new Set(inventoryItemIds.map((v: unknown) => String(v))));
    const items = await prismaAny.inventoryItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, serialNumber: true, status: true, contractId: true, assignedAgentId: true },
    });

    if (items.length !== ids.length) {
      res.status(400).json({ error: 'One or more devices were not found' });
      return;
    }

    const outOfScope = agentIds
      ? items.filter((i: any) => !i.assignedAgentId || !agentIds.includes(i.assignedAgentId))
      : [];
    if (outOfScope.length > 0) {
      res.status(403).json({
        error: 'Some of those devices are not held by an agent you supervise',
        serialNumbers: outOfScope.map((i: any) => i.serialNumber),
      });
      return;
    }

    // A device on a contract belongs to that customer; moving it would change
    // who may service a sale that has already happened.
    const sold = items.filter((i: any) => i.status === 'SOLD' || i.contractId);
    if (sold.length > 0) {
      res.status(400).json({
        error: 'Devices already sold or on a contract cannot be transferred',
        serialNumbers: sold.map((i: any) => i.serialNumber),
      });
      return;
    }

    const alreadyThere = items.filter((i: any) => i.assignedAgentId === toAgentId);
    const toMove = items.filter((i: any) => i.assignedAgentId !== toAgentId);
    if (toMove.length === 0) {
      res.status(400).json({ error: 'Those devices are already with that agent' });
      return;
    }

    await prismaAny.$transaction(async (tx: any) => {
      await tx.inventoryItem.updateMany({
        where: { id: { in: toMove.map((i: any) => i.id) } },
        data: { assignedAgentId: toAgentId },
      });
      await tx.inventoryTransfer.createMany({
        data: toMove.map((i: any) => ({
          inventoryItemId: i.id,
          fromAgentId: i.assignedAgentId,
          toAgentId,
          transferredById: admin.id,
          reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
        })),
      });
    });

    await createAuditLog({
      userId: admin.id,
      action: 'TRANSFER_STOCK',
      entity: 'InventoryItem',
      newValues: {
        toAgent: `${recipient.firstName} ${recipient.lastName}`.trim(),
        toAgentId,
        count: toMove.length,
        serialNumbers: toMove.map((i: any) => i.serialNumber),
        reason: reason ?? null,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });

    res.json({
      message: `${toMove.length} device${toMove.length === 1 ? '' : 's'} transferred`,
      transferred: toMove.length,
      skipped: alreadyThere.length,
    });
  } catch (error) {
    console.error('transferClusterStock error:', error);
    res.status(500).json({ error: 'Failed to transfer stock' });
  }
}

// GET /cluster/stock/history?inventoryItemId=
export async function getStockTransferHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { inventoryItemId } = (req.query ?? {}) as { inventoryItemId?: string };
    const agentIds = await stockScope(admin);

    const rows = await prismaAny.inventoryTransfer.findMany({
      where: {
        ...(inventoryItemId ? { inventoryItemId } : {}),
        ...(agentIds
          ? { OR: [{ fromAgentId: { in: agentIds } }, { toAgentId: { in: agentIds } }] }
          : {}),
      },
      include: {
        inventoryItem: { select: { serialNumber: true, product: { select: { name: true } } } },
        fromAgent: { select: { firstName: true, lastName: true } },
        toAgent: { select: { firstName: true, lastName: true } },
        transferredBy: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const name = (p: any) => (p ? `${p.firstName} ${p.lastName}`.trim() : null);

    res.json({
      transfers: rows.map((row: any) => ({
        id: row.id,
        serialNumber: row.inventoryItem?.serialNumber ?? null,
        product: row.inventoryItem?.product?.name ?? null,
        from: name(row.fromAgent) ?? 'Unassigned',
        to: name(row.toAgent) ?? 'Unassigned',
        by: name(row.transferredBy),
        reason: row.reason,
        at: row.createdAt,
      })),
    });
  } catch (error) {
    console.error('getStockTransferHistory error:', error);
    res.status(500).json({ error: 'Failed to load transfer history' });
  }
}
