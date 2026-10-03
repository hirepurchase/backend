import { Response } from 'express';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import {
  CompletionStatus,
  listCompletionCommissions,
  markCompletionPaid,
  undoCompletionPaid,
} from '../services/completionCommissionService';

/**
 * Completion commissions: what agents are owed when their customers complete.
 * Admins (MANAGE_AGENT_LEDGER) see and pay everyone's; an agent sees only their own.
 */

const STATUSES: CompletionStatus[] = ['PENDING', 'PAYABLE', 'ON_HOLD', 'FORFEITED', 'PAID'];
const user = (req: AuthenticatedRequest) => req.user as AdminUserPayload;

function filters(req: AuthenticatedRequest) {
  const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status as CompletionStatus)
    ? (req.query.status as CompletionStatus)
    : undefined;
  const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : undefined;
  return { status, completedMonth: month };
}

export async function getAllCompletionCommissions(req: AuthenticatedRequest, res: Response) {
  try {
    const agentId = typeof req.query.agentId === 'string' && req.query.agentId ? req.query.agentId : undefined;
    res.json(await listCompletionCommissions({ ...filters(req), agentId }));
  } catch (error) {
    console.error('List completion commissions error:', error);
    res.status(500).json({ error: 'Failed to load completion commissions' });
  }
}

export async function getMyCompletionCommissions(req: AuthenticatedRequest, res: Response) {
  try {
    res.json(await listCompletionCommissions({ ...filters(req), agentId: user(req).id }));
  } catch (error) {
    console.error('My completion commissions error:', error);
    res.status(500).json({ error: 'Failed to load your completion commissions' });
  }
}

export async function payCompletionCommission(req: AuthenticatedRequest, res: Response) {
  try {
    const row = await markCompletionPaid(String(req.params.id), user(req).id, String(req.body?.reference || ''));
    await createAuditLog({
      userId: user(req).id,
      action: 'PAY_COMPLETION_COMMISSION',
      entity: 'AgentCompletionCommission',
      entityId: row.id,
      newValues: { contractId: row.contractId, agentId: row.agentId, total: row.total, reference: row.reference },
      ipAddress: req.ip,
    });
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Could not record payment' });
  }
}

export async function unpayCompletionCommission(req: AuthenticatedRequest, res: Response) {
  try {
    const row = await undoCompletionPaid(String(req.params.id));
    await createAuditLog({
      userId: user(req).id,
      action: 'UNPAY_COMPLETION_COMMISSION',
      entity: 'AgentCompletionCommission',
      entityId: row.id,
      newValues: { contractId: row.contractId, agentId: row.agentId, total: row.total },
      ipAddress: req.ip,
    });
    res.json(row);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Could not undo payment' });
  }
}
