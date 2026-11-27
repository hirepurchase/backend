import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { applyCreatorScope, resolveContractScope, resolveCustomerScope } from '../services/scopeService';
import { CUSTOMER_ACCESS_PERMISSIONS, CONTRACT_ACCESS_PERMISSIONS, hasAnyPermission } from '../constants/permissions';

const db = prisma as any;
const LIMIT = 6;

export interface SearchResult {
  type: 'customer' | 'contract';
  id: string;
  title: string;
  subtitle: string;
  status?: string;
  href: string;
}

/**
 * GET /search?q= — customers and contracts by name, phone, membership number,
 * contract number or IMEI/serial, within what the signed-in person may see
 * (agents: their own; cluster leaders and officers: their agents'; office:
 * everything their role allows).
 */
export async function globalSearch(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) {
      res.json({ results: [] });
      return;
    }
    const digits = q.replace(/\D/g, '');
    // 024..., 233..., +233 ... all find the same number.
    const phoneTerm = digits.length >= 4 ? (digits.startsWith('233') ? `0${digits.slice(3)}` : digits) : null;
    const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
    const isAgentView = ['AGENT', 'CLUSTER_AGENT'].includes(admin.role);
    const results: SearchResult[] = [];
    const isSuper = admin.role === 'SUPER_ADMIN';

    if (isSuper || hasAnyPermission(admin.permissions, CUSTOMER_ACCESS_PERMISSIONS)) {
      const where: Record<string, unknown> = {
        OR: [
          { AND: words.map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' } }, { lastName: { contains: w, mode: 'insensitive' } }] })) },
          { membershipId: { contains: q, mode: 'insensitive' } },
          ...(phoneTerm ? [{ phone: { contains: phoneTerm } }] : []),
        ],
      };
      applyCreatorScope(where, await resolveCustomerScope(admin));
      const customers = await db.customer.findMany({
        where,
        take: LIMIT,
        orderBy: { createdAt: 'desc' },
        select: { id: true, firstName: true, lastName: true, phone: true, membershipId: true },
      });
      for (const c of customers) {
        results.push({
          type: 'customer',
          id: c.id,
          title: `${c.firstName} ${c.lastName}`.trim(),
          subtitle: [c.phone, c.membershipId].filter(Boolean).join(' · '),
          href: `/admin/customers/${c.id}`,
        });
      }
    }

    if (isSuper || hasAnyPermission(admin.permissions, CONTRACT_ACCESS_PERMISSIONS)) {
      const where: Record<string, unknown> = {
        OR: [
          { contractNumber: { contains: q, mode: 'insensitive' } },
          { inventoryItem: { serialNumber: { contains: q, mode: 'insensitive' } } },
          { managedDevice: { deviceUid: { contains: q, mode: 'insensitive' } } },
          ...(phoneTerm ? [{ customer: { phone: { contains: phoneTerm } } }] : []),
          { customer: { AND: words.map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' } }, { lastName: { contains: w, mode: 'insensitive' } }] })) } },
        ],
      };
      applyCreatorScope(where, await resolveContractScope(admin));
      const contracts = await db.hirePurchaseContract.findMany({
        where,
        take: LIMIT,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, contractNumber: true, status: true, outstandingBalance: true,
          customer: { select: { firstName: true, lastName: true } },
          inventoryItem: { select: { serialNumber: true, product: { select: { name: true } } } },
        },
      });
      for (const c of contracts) {
        results.push({
          type: 'contract',
          id: c.id,
          title: `${c.contractNumber} · ${c.customer.firstName} ${c.customer.lastName}`.trim(),
          subtitle: [c.inventoryItem?.product?.name, c.inventoryItem?.serialNumber, c.status === 'ACTIVE' ? `GHS ${Number(c.outstandingBalance).toFixed(2)} owed` : null].filter(Boolean).join(' · '),
          status: c.status,
          href: isAgentView ? `/admin/agent/contracts/${c.id}` : `/admin/contracts/${c.id}`,
        });
      }
    }

    res.json({ results });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
}
