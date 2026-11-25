import { Response } from 'express';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import {
  CompletionPayError,
  approveMonth,
  closeMonth,
  getMonth,
  getSettings,
  myProgress,
  recomputeMonth,
  reopenMonth,
  saveSettings,
  setPaid,
} from '../services/agentCompletionPayService';

const me = (req: AuthenticatedRequest) => req.user as AdminUserPayload;

function fail(res: Response, error: unknown) {
  if (error instanceof CompletionPayError) return res.status(error.status).json({ error: error.message });
  console.error('Agent completion pay error:', error);
  return res.status(500).json({ error: 'Something went wrong' });
}

export async function getCompletionPaySettings(_req: AuthenticatedRequest, res: Response) {
  try { res.json({ settings: await getSettings() }); } catch (e) { fail(res, e); }
}

export async function putCompletionPaySettings(req: AuthenticatedRequest, res: Response) {
  try {
    const b = req.body ?? {};
    res.json({ settings: await saveSettings({ amountPerCompletion: b.amountPerCompletion, threshold: b.threshold, startMonth: b.startMonth, maxPerMonth: b.maxPerMonth }, me(req).id) });
  } catch (e) { fail(res, e); }
}

export async function getMyCompletionPay(req: AuthenticatedRequest, res: Response) {
  try { res.json(await myProgress(me(req).id)); } catch (e) { fail(res, e); }
}

export async function getCompletionPayMonth(req: AuthenticatedRequest, res: Response) {
  try { res.json(await getMonth(String(req.params.month))); } catch (e) { fail(res, e); }
}

async function lifecycle(req: AuthenticatedRequest, res: Response, action: string, run: (month: string) => Promise<unknown>) {
  try {
    const month = String(req.params.month);
    const result = await run(month);
    await createAuditLog({ userId: me(req).id, action, entity: 'AgentCompletionPayPeriod', entityId: month, newValues: { month, ...(req.params.agentId ? { agentId: req.params.agentId } : {}), ...(req.body || {}) }, ipAddress: req.ip });
    res.json(result);
  } catch (e) { fail(res, e); }
}

export const closeCompletionPay = (req: AuthenticatedRequest, res: Response) => lifecycle(req, res, 'CLOSE_AGENT_COMPLETION_PAY', (m) => closeMonth(m, me(req).id));
export const recomputeCompletionPay = (req: AuthenticatedRequest, res: Response) => lifecycle(req, res, 'RECOMPUTE_AGENT_COMPLETION_PAY', (m) => recomputeMonth(m, Boolean(req.body?.useCurrentSettings)));
export const reopenCompletionPay = (req: AuthenticatedRequest, res: Response) => lifecycle(req, res, 'REOPEN_AGENT_COMPLETION_PAY', (m) => reopenMonth(m));
export const approveCompletionPay = (req: AuthenticatedRequest, res: Response) => lifecycle(req, res, 'APPROVE_AGENT_COMPLETION_PAY', (m) => approveMonth(m, me(req).id));
export const markCompletionPayPaid = (req: AuthenticatedRequest, res: Response) => lifecycle(req, res, 'PAY_AGENT_COMPLETION_PAY', (m) => setPaid(m, String(req.params.agentId), true, me(req).id, req.body?.reference));
export const unmarkCompletionPayPaid = (req: AuthenticatedRequest, res: Response) => lifecycle(req, res, 'UNPAY_AGENT_COMPLETION_PAY', (m) => setPaid(m, String(req.params.agentId), false, me(req).id));
