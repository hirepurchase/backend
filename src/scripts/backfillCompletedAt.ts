/**
 * Fill in the completion date on completed contracts that have none.
 *
 * Contracts paid off through the Hubtel callback (and through Correct Terms)
 * were marked COMPLETED without a completedAt until 24 November 2026, so
 * anything that counts completions by date (completion pay by month, the
 * cluster scorecard) missed them.
 *
 * The date used is the day the successful payments first covered the price,
 * which is when the contract was really paid off. If the payments never add up
 * to the price (older data), the last successful payment is used; with no
 * payments at all, the last instalment marked paid; failing that, the day the
 * contract was last updated.
 *
 *   npx ts-node --transpile-only src/scripts/backfillCompletedAt.ts            # preview
 *   npx ts-node --transpile-only src/scripts/backfillCompletedAt.ts --apply
 */
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';

const APPLY = process.argv.includes('--apply');

type Basis = 'PAID_OFF' | 'LAST_PAYMENT' | 'LAST_INSTALMENT' | 'LAST_UPDATE';

async function main() {
  const contracts = await prisma.hirePurchaseContract.findMany({
    where: { status: 'COMPLETED', completedAt: null },
    select: {
      id: true, contractNumber: true, totalPrice: true, depositAmount: true, updatedAt: true, endDate: true,
      payments: { where: { status: 'SUCCESS' }, select: { amount: true, unlockFee: true, paymentDate: true, createdAt: true } },
      installments: { where: { paidAt: { not: null } }, select: { paidAt: true }, orderBy: { paidAt: 'desc' }, take: 1 },
    },
  });

  const plan: Array<{ id: string; contractNumber: string; completedAt: Date; basis: Basis }> = [];
  for (const c of contracts) {
    const pays = c.payments
      .map((p) => ({ at: p.paymentDate ?? p.createdAt, amount: p.amount - (p.unlockFee ?? 0) }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    let paid = c.depositAmount;
    let at: Date | null = null;
    let basis: Basis = 'PAID_OFF';
    for (const p of pays) {
      paid += p.amount;
      if (paid >= c.totalPrice - 0.005) { at = p.at; break; }
    }
    if (!at && pays.length) { at = pays[pays.length - 1].at; basis = 'LAST_PAYMENT'; }
    if (!at && c.installments[0]?.paidAt) { at = c.installments[0].paidAt; basis = 'LAST_INSTALMENT'; }
    if (!at) { at = c.updatedAt; basis = 'LAST_UPDATE'; }
    plan.push({ id: c.id, contractNumber: c.contractNumber, completedAt: at, basis });
  }

  const byBasis: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  for (const p of plan) {
    byBasis[p.basis] = (byBasis[p.basis] || 0) + 1;
    const m = p.completedAt.toISOString().slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  console.log(`Completed contracts with no completion date: ${plan.length}`);
  console.log('Date taken from:', byBasis);
  console.log('Completions by month:', Object.fromEntries(Object.entries(byMonth).sort()));
  for (const p of plan.slice(0, 5)) console.log(`  e.g. ${p.contractNumber} → ${p.completedAt.toISOString().slice(0, 10)} (${p.basis})`);

  if (APPLY && plan.length) {
    let done = 0;
    for (const p of plan) {
      // Only if still empty, so a run never overwrites a date set since.
      const r = await prisma.hirePurchaseContract.updateMany({
        where: { id: p.id, status: 'COMPLETED', completedAt: null },
        data: { completedAt: p.completedAt },
      });
      done += r.count;
    }
    await createAuditLog({
      action: 'BACKFILL_COMPLETED_AT',
      entity: 'HirePurchaseContract',
      newValues: {
        updated: done,
        byBasis,
        note: 'Completion date filled in on completed contracts that had none (Hubtel callback path before 24 Nov 2026).',
        contracts: plan.map((p) => [p.contractNumber, p.completedAt.toISOString().slice(0, 10), p.basis]),
      },
    });
    console.log(`UPDATED ${done}`);
  } else {
    console.log('PREVIEW ONLY');
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
