import prisma from '../config/database';

/**
 * Commission paid to an agent when their customer completes.
 *
 * At sale the agent keeps CommissionSettings.fixedAmount out of the deposit,
 * as before. If management has set a held-back amount or a completion bonus,
 * a row is written here at the same time, with the amounts copied from the
 * settings then, so a later change of rates does not alter what was promised.
 *
 * Whether it is due is read from the contract's status rather than set by the
 * code that completes contracts, which is left untouched:
 *
 *   COMPLETED                 → payable
 *   DEFAULTED                 → on hold (payable if it later completes)
 *   CANCELLED / WRITTEN_OFF   → forfeited
 *   anything else             → pending
 */

export type CompletionStatus = 'PENDING' | 'PAYABLE' | 'ON_HOLD' | 'FORFEITED' | 'PAID';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function deriveStatus(row: { status: string }, contractStatus: string | null | undefined): CompletionStatus {
  if (row.status === 'PAID') return 'PAID';
  if (contractStatus === 'COMPLETED') return 'PAYABLE';
  if (contractStatus === 'DEFAULTED') return 'ON_HOLD';
  if (contractStatus === 'CANCELLED' || contractStatus === 'WRITTEN_OFF' || !contractStatus) return 'FORFEITED';
  return 'PENDING';
}

/**
 * Called once per approved sale, right after its deposit ledger row. Never
 * throws: a failure here must not stop the ledger entry that preceded it.
 */
export async function accrueCompletionCommission(input: {
  contractId: string;
  agentId: string;
  ledgerEntryId: string;
  upfrontAmount: number;
  deferredAmount: number;
  completionBonus: number;
}): Promise<void> {
  try {
    const deferred = Math.max(0, input.deferredAmount || 0);
    const bonus = Math.max(0, input.completionBonus || 0);
    if (deferred + bonus <= 0) return; // the old single-payment scheme
    await prisma.agentCompletionCommission.upsert({
      where: { contractId: input.contractId },
      create: {
        contractId: input.contractId,
        agentId: input.agentId,
        ledgerEntryId: input.ledgerEntryId,
        upfrontAmount: round2(input.upfrontAmount),
        deferredAmount: round2(deferred),
        bonusAmount: round2(bonus),
        total: round2(deferred + bonus),
      },
      update: {},
    });
  } catch (error) {
    console.error(`Failed to record completion commission for contract ${input.contractId}:`, error);
  }
}

export interface CompletionRow {
  id: string;
  contractId: string;
  contractNumber: string | null;
  contractStatus: string | null;
  customerName: string | null;
  completedAt: Date | null;
  agentId: string;
  agentName: string | null;
  upfrontAmount: number;
  deferredAmount: number;
  bonusAmount: number;
  total: number;
  status: CompletionStatus;
  /** Paid, then the contract left COMPLETED (a payment was reversed). */
  needsReview: boolean;
  soldAt: Date;
  paidAt: Date | null;
  reference: string | null;
}

export interface CompletionFilter {
  agentId?: string;
  status?: CompletionStatus;
  /** YYYY-MM: completed in this month. */
  completedMonth?: string;
}

export async function listCompletionCommissions(filter: CompletionFilter = {}) {
  const rows = await prisma.agentCompletionCommission.findMany({
    where: filter.agentId ? { agentId: filter.agentId } : {},
    orderBy: { createdAt: 'desc' },
  });
  const [contracts, agents] = await Promise.all([
    prisma.hirePurchaseContract.findMany({
      where: { id: { in: rows.map((r) => r.contractId) } },
      select: { id: true, contractNumber: true, status: true, completedAt: true, customer: { select: { firstName: true, lastName: true } } },
    }),
    prisma.adminUser.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.agentId))] } },
      select: { id: true, firstName: true, lastName: true },
    }),
  ]);
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const agentById = new Map(agents.map((a) => [a.id, `${a.firstName} ${a.lastName}`.trim()]));

  let out: CompletionRow[] = rows.map((r) => {
    const c = contractById.get(r.contractId);
    const status = deriveStatus(r, c?.status);
    return {
      id: r.id,
      contractId: r.contractId,
      contractNumber: c?.contractNumber ?? null,
      contractStatus: c?.status ?? null,
      customerName: c ? `${c.customer.firstName} ${c.customer.lastName}`.trim() : null,
      completedAt: c?.completedAt ?? null,
      agentId: r.agentId,
      agentName: agentById.get(r.agentId) ?? null,
      upfrontAmount: r.upfrontAmount,
      deferredAmount: r.deferredAmount,
      bonusAmount: r.bonusAmount,
      total: r.total,
      status,
      needsReview: r.status === 'PAID' && c?.status !== 'COMPLETED',
      soldAt: r.createdAt,
      paidAt: r.paidAt,
      reference: r.reference,
    };
  });

  if (filter.completedMonth) {
    const [y, m] = filter.completedMonth.split('-').map(Number);
    const from = new Date(y, m - 1, 1).getTime();
    const to = new Date(y, m, 1).getTime();
    out = out.filter((r) => r.completedAt && r.completedAt.getTime() >= from && r.completedAt.getTime() < to);
  }

  const totals: Record<CompletionStatus, { count: number; amount: number }> = {
    PENDING: { count: 0, amount: 0 },
    PAYABLE: { count: 0, amount: 0 },
    ON_HOLD: { count: 0, amount: 0 },
    FORFEITED: { count: 0, amount: 0 },
    PAID: { count: 0, amount: 0 },
  };
  for (const r of out) {
    totals[r.status].count++;
    totals[r.status].amount = round2(totals[r.status].amount + r.total);
  }
  if (filter.status) out = out.filter((r) => r.status === filter.status);
  return { rows: out, totals, needsReview: out.filter((r) => r.needsReview).length };
}

export async function markCompletionPaid(id: string, actorId: string, reference: string) {
  const row = await prisma.agentCompletionCommission.findUnique({ where: { id } });
  if (!row) throw new Error('Not found');
  if (row.status === 'PAID') throw new Error('Already marked paid.');
  if (!reference?.trim()) throw new Error('Enter the payment reference.');
  const contract = await prisma.hirePurchaseContract.findUnique({ where: { id: row.contractId }, select: { status: true } });
  const status = deriveStatus(row, contract?.status);
  if (status !== 'PAYABLE') throw new Error('This commission is not payable — the customer has not completed.');
  return prisma.agentCompletionCommission.update({
    where: { id },
    data: { status: 'PAID', paidAt: new Date(), paidById: actorId, reference: reference.trim().slice(0, 100) },
  });
}

export async function undoCompletionPaid(id: string) {
  const row = await prisma.agentCompletionCommission.findUnique({ where: { id } });
  if (!row) throw new Error('Not found');
  if (row.status !== 'PAID') throw new Error('This commission is not marked paid.');
  return prisma.agentCompletionCommission.update({
    where: { id },
    data: { status: 'ACCRUED', paidAt: null, paidById: null, reference: null },
  });
}
