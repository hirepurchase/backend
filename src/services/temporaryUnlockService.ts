import prisma from '../config/database';

const prismaAny = prisma as any;

export const TEMPORARY_UNLOCK_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  FULFILLED: 'FULFILLED',
  DEFAULTED: 'DEFAULTED',
} as const;

export type TemporaryUnlockStatus = typeof TEMPORARY_UNLOCK_STATUS[keyof typeof TEMPORARY_UNLOCK_STATUS];

export const DEFAULT_MAX_TEMPORARY_UNLOCK_WEEKS = 4;

export interface ActiveTemporaryUnlock {
  id: string;
  contractId: string;
  agentId: string;
  expiresAt: Date;
  approvedWeeks: number;
  arrearsAtApproval: number | null;
}

/**
 * A temporary unlock is "live" purely as a function of status and clock, never
 * as a flag written onto the device. A late cron or a missed webhook therefore
 * cannot leave a phone open past its window: the moment `expiresAt` passes,
 * every read below stops returning it and the ordinary arrears rules resume.
 */
function activeWhereClause(now: Date) {
  return {
    status: TEMPORARY_UNLOCK_STATUS.APPROVED,
    expiresAt: { gt: now },
  };
}

export async function getActiveTemporaryUnlock(
  contractId: string,
  now: Date = new Date()
): Promise<ActiveTemporaryUnlock | null> {
  const row = await prismaAny.temporaryUnlockRequest.findFirst({
    where: { contractId, ...activeWhereClause(now) },
    orderBy: { expiresAt: 'desc' },
    select: {
      id: true,
      contractId: true,
      agentId: true,
      expiresAt: true,
      approvedWeeks: true,
      arrearsAtApproval: true,
    },
  });
  if (!row) {
    return null;
  }
  return { ...row, approvedWeeks: row.approvedWeeks ?? 0 };
}

/**
 * Batch form for the sweeps, which walk hundreds of contracts and must not
 * issue a query per contract.
 */
export async function getActiveTemporaryUnlockContractIds(
  contractIds: string[],
  now: Date = new Date()
): Promise<Set<string>> {
  if (contractIds.length === 0) {
    return new Set();
  }
  const rows = await prismaAny.temporaryUnlockRequest.findMany({
    where: { contractId: { in: contractIds }, ...activeWhereClause(now) },
    select: { contractId: true },
  });
  return new Set(rows.map((row: { contractId: string }) => row.contractId));
}

/**
 * Reads the override off an already-loaded contract when the caller included
 * `temporaryUnlocks`. Saves a round trip inside the per-contract evaluation,
 * which is on the hot path of the five-minute scheduler.
 */
export function hasLiveTemporaryUnlock(
  contract: { temporaryUnlocks?: Array<{ status: string; expiresAt: Date | null }> | null },
  now: Date = new Date()
): boolean {
  const rows = contract?.temporaryUnlocks;
  if (!rows || rows.length === 0) {
    return false;
  }
  return rows.some(
    (row) =>
      row.status === TEMPORARY_UNLOCK_STATUS.APPROVED &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() > now.getTime()
  );
}

/**
 * The guarantee the cluster agent gave has been called in: the window closed
 * with the customer still owing, so the agent who sold the contract cannot
 * write new business until that customer is square. Returns the blocking
 * requests so the caller can name the customers rather than just refuse.
 */
export async function getAgentDefaultedTemporaryUnlocks(agentId: string): Promise<
  Array<{
    id: string;
    contractId: string;
    contractNumber: string;
    customerName: string;
    outstandingOverdue: number;
    resolvedAt: Date | null;
  }>
> {
  const rows = await prismaAny.temporaryUnlockRequest.findMany({
    where: { agentId, status: TEMPORARY_UNLOCK_STATUS.DEFAULTED },
    include: {
      contract: {
        include: {
          customer: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { resolvedAt: 'desc' },
  });

  return rows.map((row: any) => ({
    id: row.id,
    contractId: row.contractId,
    contractNumber: row.contract?.contractNumber ?? '',
    customerName: row.contract?.customer
      ? `${row.contract.customer.firstName} ${row.contract.customer.lastName}`.trim()
      : '',
    outstandingOverdue: row.arrearsAtApproval ?? 0,
    resolvedAt: row.resolvedAt ?? null,
  }));
}

export async function isAgentBarredFromNewContracts(agentId: string): Promise<boolean> {
  const blocking = await prismaAny.temporaryUnlockRequest.count({
    where: { agentId, status: TEMPORARY_UNLOCK_STATUS.DEFAULTED },
  });
  return blocking > 0;
}

export function computeExpiry(weeks: number, from: Date = new Date()): Date {
  const expiry = new Date(from);
  expiry.setDate(expiry.getDate() + weeks * 7);
  // Windows are counted in whole days, so the customer keeps the full last day
  // rather than losing the phone at whatever hour the approval happened to land.
  expiry.setHours(23, 59, 59, 999);
  return expiry;
}

/**
 * Closes every window whose time is up. Ran daily, but correctness does not
 * depend on it running on time: `getActiveTemporaryUnlock` already stops
 * honouring an expired row, so a late job delays the bookkeeping and the
 * relock, never the expiry itself.
 *
 * Two outcomes: the customer cleared what was overdue at approval (FULFILLED,
 * nothing else happens), or they did not (DEFAULTED — the phone goes back
 * under lock and the agent who sold the contract is barred from writing new
 * business until that customer is square).
 */
export async function closeExpiredTemporaryUnlocks(): Promise<{
  examined: number;
  fulfilled: number;
  defaulted: number;
  relocked: number;
  errors: number;
  details: Array<{
    contractNumber: string;
    customerName: string;
    outcome: 'FULFILLED' | 'DEFAULTED';
    overdueRemaining: number;
    relocked?: boolean;
    error?: string;
  }>;
}> {
  // Imported here rather than at module scope: deviceControlPolicyService
  // imports this file, and a top-level import back into it would be a cycle.
  const { evaluateManagedDeviceForContract } = await import('./deviceControlPolicyService');
  const { isOverdue } = await import('../utils/helpers');

  const now = new Date();
  const expired = await prismaAny.temporaryUnlockRequest.findMany({
    where: {
      status: TEMPORARY_UNLOCK_STATUS.APPROVED,
      expiresAt: { lte: now },
    },
    include: {
      contract: {
        include: {
          installments: true,
          customer: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  let fulfilled = 0;
  let defaulted = 0;
  let relocked = 0;
  let errors = 0;
  const details: Array<any> = [];

  for (const request of expired) {
    const contract = request.contract;
    const customerName = contract?.customer
      ? `${contract.customer.firstName} ${contract.customer.lastName}`.trim()
      : '';

    try {
      // A contract that completed or was cancelled during the window closes
      // out as fulfilled — there is nothing left to relock or chase.
      let overdueRemaining = 0;
      if (contract && contract.status === 'ACTIVE') {
        for (const installment of contract.installments ?? []) {
          if (installment.status === 'PAID') continue;
          if (!isOverdue(installment.dueDate)) continue;
          overdueRemaining += Math.max(0, (installment.amount ?? 0) - (installment.paidAmount ?? 0));
        }
      }

      const cleared = overdueRemaining <= 0;

      await prismaAny.temporaryUnlockRequest.update({
        where: { id: request.id },
        data: {
          status: cleared ? TEMPORARY_UNLOCK_STATUS.FULFILLED : TEMPORARY_UNLOCK_STATUS.DEFAULTED,
          resolvedAt: now,
        },
      });

      let didRelock: boolean | undefined;
      if (!cleared && contract) {
        // The override is already dead by virtue of the status change, so a
        // plain re-evaluation applies whatever lock the arrears now warrant.
        try {
          const result: any = await evaluateManagedDeviceForContract(contract.id);
          // The evaluator reports the command it issued as actionType; the
          // early completion path uses `action` instead.
          const issued = result?.actionType ?? result?.action ?? null;
          didRelock =
            issued === 'LOCK_DEVICE' &&
            Boolean(result?.actionSuccess ?? result?.success ?? result?.actionDryRun ?? result?.dryRun);
          if (didRelock) relocked++;
        } catch (error: any) {
          // The default itself is recorded; the five-minute scheduler will
          // catch the device.
          console.error(`Temporary unlock relock failed for ${contract.contractNumber}:`, error?.message);
        }
      }

      if (cleared) fulfilled++;
      else defaulted++;

      details.push({
        contractNumber: contract?.contractNumber ?? '',
        customerName,
        outcome: cleared ? 'FULFILLED' : 'DEFAULTED',
        overdueRemaining: Number(overdueRemaining.toFixed(2)),
        ...(didRelock !== undefined ? { relocked: didRelock } : {}),
      });
    } catch (error: any) {
      errors++;
      details.push({
        contractNumber: contract?.contractNumber ?? '',
        customerName,
        outcome: 'DEFAULTED',
        overdueRemaining: 0,
        error: error?.message || 'Unknown error',
      });
    }
  }

  return { examined: expired.length, fulfilled, defaulted, relocked, errors, details };
}

/**
 * A defaulted guarantee is cleared by the customer paying, not by anyone
 * pressing a button — so the bar lifts on its own the moment the arrears are
 * gone. Run alongside the expiry sweep.
 */
export async function releaseSettledDefaultedUnlocks(): Promise<{ released: number }> {
  const { isOverdue } = await import('../utils/helpers');

  const defaultedRows = await prismaAny.temporaryUnlockRequest.findMany({
    where: { status: TEMPORARY_UNLOCK_STATUS.DEFAULTED },
    include: { contract: { include: { installments: true } } },
  });

  let released = 0;
  for (const row of defaultedRows) {
    const contract = row.contract;
    let overdueRemaining = 0;
    if (contract && contract.status === 'ACTIVE') {
      for (const installment of contract.installments ?? []) {
        if (installment.status === 'PAID') continue;
        if (!isOverdue(installment.dueDate)) continue;
        overdueRemaining += Math.max(0, (installment.amount ?? 0) - (installment.paidAmount ?? 0));
      }
    }

    if (overdueRemaining <= 0) {
      await prismaAny.temporaryUnlockRequest.update({
        where: { id: row.id },
        data: { status: TEMPORARY_UNLOCK_STATUS.FULFILLED, resolvedAt: new Date() },
      });
      released++;
    }
  }

  return { released };
}

/**
 * Live windows with enough context to chase them. The CSO queue uses this: a
 * customer inside a window is the most time-critical call on the list, because
 * the window closes on a fixed date and the phone relocks if nothing changes.
 */
export async function getLiveTemporaryUnlockDetails(
  contractIds?: string[],
  now: Date = new Date()
): Promise<
  Map<
    string,
    { id: string; expiresAt: Date; daysRemaining: number; approvedWeeks: number; arrearsAtApproval: number | null }
  >
> {
  const rows = await prismaAny.temporaryUnlockRequest.findMany({
    where: {
      ...activeWhereClause(now),
      ...(contractIds ? { contractId: { in: contractIds } } : {}),
    },
    select: {
      id: true,
      contractId: true,
      expiresAt: true,
      approvedWeeks: true,
      arrearsAtApproval: true,
    },
  });

  const map = new Map<string, any>();
  for (const row of rows) {
    map.set(row.contractId, {
      id: row.id,
      expiresAt: row.expiresAt,
      daysRemaining: Math.max(
        0,
        Math.ceil((new Date(row.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      ),
      approvedWeeks: row.approvedWeeks ?? 0,
      arrearsAtApproval: row.arrearsAtApproval ?? null,
    });
  }
  return map;
}
