import { Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { createAuditLog } from '../services/auditService';
import { daySummary, reshareDay } from '../services/callAllocationService';

/** GET /welcome-calls/allocations/today — how today's calls are shared, per officer. */
export async function getTodaysAllocations(_req: AuthenticatedRequest, res: Response) {
  try {
    res.json(await daySummary());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message || 'Failed to load today’s calls' });
  }
}

/** POST /welcome-calls/allocations/reshare { officerIds } — share calls not yet made among those who are in. */
export async function reshareTodaysCalls(req: AuthenticatedRequest, res: Response) {
  const officerIds = Array.isArray(req.body?.officerIds) ? req.body.officerIds.map(String) : null;
  if (!officerIds?.length) return res.status(400).json({ error: 'Choose who is working today' });
  try {
    const result = await reshareDay(officerIds);
    await createAuditLog({
      userId: req.user!.id,
      action: 'RESHARE_CUSTOMER_SERVICE_CALLS',
      entity: 'CallAllocation',
      entityId: result.day ?? undefined,
      newValues: { officerIds, moved: result.moved },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
    res.json({ ...result, summary: await daySummary() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message || 'Failed to reshare calls' });
  }
}
