import { Response } from 'express';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import prisma from '../config/database';
import { PERMISSIONS } from '../constants/permissions';
import { resolveContractScope, scopeAllows } from '../services/scopeService';
import {
  RescheduleError,
  approveReschedule,
  countAutoCandidates,
  getRescheduleSettings,
  previewForContract,
  raiseAutomaticReschedules,
  rejectReschedule,
  requestReschedule,
  saveRescheduleSettings,
  currentQuoteFor,
} from '../services/rescheduleService';

const db = prisma as any;

function fail(res: Response, error: unknown, what: string): void {
  if (error instanceof RescheduleError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(`${what} error:`, error);
  res.status(500).json({ error: `Failed to ${what}` });
}

async function inScope(admin: AdminUserPayload, contractId: string): Promise<boolean> {
  if (admin.role === 'SUPER_ADMIN') return true;
  const contract = await db.hirePurchaseContract.findUnique({ where: { id: contractId }, select: { createdById: true } });
  if (!contract) throw new RescheduleError('Contract not found', 404);
  return scopeAllows(await resolveContractScope(admin), contract.createdById);
}

function termsFrom(src: any) {
  return {
    monthlyRate: src.monthlyRate === undefined || src.monthlyRate === '' ? undefined : Number(src.monthlyRate),
    frequency: src.frequency ? String(src.frequency).toUpperCase() : undefined,
    installments: src.installments === undefined || src.installments === '' ? undefined : Number(src.installments),
    firstDueDate: src.firstDueDate || null,
  } as any;
}

async function adminNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter(Boolean))] as string[];
  if (!list.length) return new Map();
  const users = await db.adminUser.findMany({ where: { id: { in: list } }, select: { id: true, firstName: true, lastName: true } });
  return new Map(users.map((u: any) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
}

// GET /reschedules/contract/:contractId/preview
export async function previewContractReschedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    if (!(await inScope(admin, req.params.contractId))) {
      res.status(403).json({ error: 'This contract is outside your portfolio' });
      return;
    }
    res.json(await previewForContract(req.params.contractId, termsFrom(req.query)));
  } catch (error) {
    fail(res, error, 'work out the reschedule');
  }
}

// POST /reschedules/contract/:contractId
export async function createContractReschedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    if (!(await inScope(admin, req.params.contractId))) {
      res.status(403).json({ error: 'This contract is outside your portfolio' });
      return;
    }
    const settings = await getRescheduleSettings();
    const t = termsFrom(req.body ?? {});
    const row = await requestReschedule({
      contractId: req.params.contractId,
      adminId: admin.id,
      source: 'MANUAL',
      note: req.body?.note,
      terms: {
        monthlyRate: t.monthlyRate ?? settings.defaultMonthlyRate,
        frequency: t.frequency,
        installments: t.installments,
        firstDueDate: t.firstDueDate,
      },
    });
    res.status(201).json({ reschedule: row });
  } catch (error) {
    fail(res, error, 'ask for the reschedule');
  }
}

// GET /reschedules/contract/:contractId
export async function listContractReschedules(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    if (!(await inScope(admin, req.params.contractId))) {
      res.status(403).json({ error: 'This contract is outside your portfolio' });
      return;
    }
    const rows = await db.contractReschedule.findMany({ where: { contractId: req.params.contractId }, orderBy: { createdAt: 'desc' } });
    const names = await adminNames(rows.flatMap((r: any) => [r.requestedById, r.decidedById]));
    res.json({
      reschedules: rows.map((r: any) => ({
        ...r,
        oldSchedule: r.oldSchedule ? JSON.parse(r.oldSchedule) : null,
        requestedBy: r.requestedById ? names.get(r.requestedById) ?? null : null,
        decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
      })),
    });
  } catch (error) {
    fail(res, error, 'load reschedules');
  }
}

// GET /reschedules?status=PENDING&page=1
export async function listReschedules(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const status = String(req.query.status || 'PENDING').toUpperCase();
    const page = Math.max(1, Number(req.query.page) || 1);
    const take = 25;
    const where: any = status === 'ALL' ? {} : { status };
    if (admin.role !== 'SUPER_ADMIN') {
      const scope = await resolveContractScope(admin);
      if (scope.mode !== 'all') {
        const ids = await db.hirePurchaseContract.findMany({ where: { reschedules: { some: where } }, select: { id: true, createdById: true } });
        where.contractId = { in: ids.filter((c: any) => scopeAllows(scope, c.createdById)).map((c: any) => c.id) };
      }
    }
    const [rows, total] = await Promise.all([
      db.contractReschedule.findMany({
        where,
        orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
        skip: (page - 1) * take,
        take,
        include: {
          contract: {
            select: {
              id: true, contractNumber: true, outstandingBalance: true, endDate: true, rescheduleCount: true,
              customer: { select: { firstName: true, lastName: true, phone: true } },
            },
          },
        },
      }),
      db.contractReschedule.count({ where }),
    ]);
    const names = await adminNames(rows.flatMap((r: any) => [r.requestedById, r.decidedById]));
    res.json({
      reschedules: rows.map((r: any) => ({
        ...r,
        oldSchedule: undefined,
        requestedBy: r.requestedById ? names.get(r.requestedById) ?? null : null,
        decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
      })),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / take)),
    });
  } catch (error) {
    fail(res, error, 'load reschedules');
  }
}

// GET /reschedules/:id: the request, with its figures worked out again as the contract stands now.
export async function getReschedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const row = await db.contractReschedule.findUnique({
      where: { id: req.params.id },
      include: { contract: { select: { id: true, contractNumber: true, customer: { select: { firstName: true, lastName: true } } } } },
    });
    if (!row) {
      res.status(404).json({ error: 'Reschedule request not found' });
      return;
    }
    if (!(await inScope(admin, row.contractId))) {
      res.status(403).json({ error: 'This contract is outside your portfolio' });
      return;
    }
    let current: unknown = null;
    let currentError: string | null = null;
    if (row.status === 'PENDING') {
      try {
        current = await currentQuoteFor(row);
      } catch (err) {
        currentError = err instanceof RescheduleError ? err.message : 'Could not work out the figures';
      }
    }
    const names = await adminNames([row.requestedById, row.decidedById]);
    res.json({
      reschedule: {
        ...row,
        oldSchedule: row.oldSchedule ? JSON.parse(row.oldSchedule) : null,
        requestedBy: row.requestedById ? names.get(row.requestedById) ?? null : null,
        decidedBy: row.decidedById ? names.get(row.decidedById) ?? null : null,
      },
      current,
      currentError,
      canDecide: row.status === 'PENDING' && row.requestedById !== admin.id
        && (admin.role === 'SUPER_ADMIN' || (admin.permissions ?? []).includes(PERMISSIONS.EDIT_CONTRACT_VALUES)),
    });
  } catch (error) {
    fail(res, error, 'load the reschedule');
  }
}

// POST /reschedules/:id/approve
export async function approveRescheduleRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const row = await db.contractReschedule.findUnique({ where: { id: req.params.id }, select: { contractId: true } });
    if (!row) {
      res.status(404).json({ error: 'Reschedule request not found' });
      return;
    }
    if (!(await inScope(admin, row.contractId))) {
      res.status(403).json({ error: 'This contract is outside your portfolio' });
      return;
    }
    res.json({ reschedule: await approveReschedule(req.params.id, admin.id) });
  } catch (error) {
    fail(res, error, 'approve the reschedule');
  }
}

// POST /reschedules/:id/reject
export async function rejectRescheduleRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const row = await db.contractReschedule.findUnique({ where: { id: req.params.id }, select: { contractId: true } });
    if (!row) {
      res.status(404).json({ error: 'Reschedule request not found' });
      return;
    }
    if (!(await inScope(admin, row.contractId))) {
      res.status(403).json({ error: 'This contract is outside your portfolio' });
      return;
    }
    res.json({ reschedule: await rejectReschedule(req.params.id, admin.id, req.body?.reason) });
  } catch (error) {
    fail(res, error, 'turn down the reschedule');
  }
}

// GET /reschedules/settings
export async function getRescheduleConfig(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const settings = await getRescheduleSettings();
    const [waiting, candidates] = await Promise.all([
      db.contractReschedule.count({ where: { status: 'PENDING' } }),
      countAutoCandidates(),
    ]);
    const updatedBy = settings.updatedById ? (await adminNames([settings.updatedById])).get(settings.updatedById) ?? null : null;
    res.json({ settings: { ...settings, id: undefined }, updatedBy, stats: { waiting, candidates } });
  } catch (error) {
    fail(res, error, 'load reschedule settings');
  }
}

// PUT /reschedules/settings
export async function updateRescheduleConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const b = req.body ?? {};
    const input: any = {};
    for (const k of ['autoAfterDays', 'defaultMonthlyRate', 'maxMonthlyRate', 'autoInstallments', 'maxReschedulesPerContract']) {
      if (b[k] !== undefined) input[k] = Number(b[k]);
    }
    if (b.autoEnabled !== undefined) input.autoEnabled = Boolean(b.autoEnabled);
    if (b.autoFrequency !== undefined) input.autoFrequency = String(b.autoFrequency).toUpperCase();
    const settings = await saveRescheduleSettings(input, admin.id);
    res.json({ settings: { ...settings, id: undefined } });
  } catch (error) {
    fail(res, error, 'save reschedule settings');
  }
}

// POST /reschedules/settings/run: raise the automatic requests now instead of waiting for the morning job.
export async function runAutomaticReschedules(_req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    res.json(await raiseAutomaticReschedules());
  } catch (error) {
    fail(res, error, 'raise reschedule requests');
  }
}
