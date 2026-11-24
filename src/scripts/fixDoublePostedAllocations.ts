/**
 * Repair contracts whose instalments show more paid than was received,
 * because one Mobile Money payment was posted twice to the instalment
 * schedule (a Hubtel callback and a status check arriving together, before
 * the claim fix of 17 November 2026). Contract totals were always right,
 * since they are summed from the payment rows; only the instalments are off.
 *
 *   npx ts-node --transpile-only src/scripts/fixDoublePostedAllocations.ts            # preview only
 *   npx ts-node --transpile-only src/scripts/fixDoublePostedAllocations.ts --apply    # write
 *   add --include-overdue to also fix contracts that become overdue (their
 *   phones may then lock under the normal rules), and --reschedule-days=N to
 *   move every instalment the correction leaves overdue to fall due N days
 *   from today instead, so the customer has that long to pay before the
 *   normal lock rules apply (the contract end date moves with it if needed)
 *
 * Only contracts whose over-credit equals one or two of their own successful
 * payments, with no hand-recorded payments and no late charges, are touched.
 * Each fix rebuilds the instalments from the payments (the same rebuild used
 * when a payment is deleted or reversed) and writes an audit entry holding
 * the instalments as they were. Devices are not touched here.
 */
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { rebuildContractFromPayments, REBUILD_TX } from '../controllers/paymentController';

const APPLY = process.argv.includes('--apply');
const INCLUDE_OVERDUE = process.argv.includes('--include-overdue');
const RESCHEDULE_DAYS = Number((process.argv.find((a) => a.startsWith('--reschedule-days=')) || '').slice('--reschedule-days='.length)) || 0;

/** Midnight UTC, N days from today: how due dates are stored. */
function dueDateInDays(days: number): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length).split(',').filter(Boolean);

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function main() {
  const rows: Array<{ id: string; contractNumber: string; over: number; paid: number }> = await prisma.$queryRawUnsafe(`
    WITH pay AS (SELECT "contractId", SUM(amount - COALESCE("unlockFee",0)) AS paid FROM "PaymentTransaction" WHERE status='SUCCESS' GROUP BY "contractId"),
         ins AS (SELECT "contractId", SUM("paidAmount") AS alloc FROM "InstallmentSchedule" GROUP BY "contractId")
    SELECT c.id, c."contractNumber", ROUND((ins.alloc - COALESCE(pay.paid,0))::numeric, 2)::float AS over, COALESCE(pay.paid,0)::float AS paid
    FROM "HirePurchaseContract" c JOIN ins ON ins."contractId"=c.id LEFT JOIN pay ON pay."contractId"=c.id
    WHERE ins.alloc - COALESCE(pay.paid,0) > 0.5 AND c.status = 'ACTIVE'`);

  const today = startOfToday();
  const fixed: string[] = [];
  const heldOverdue: string[] = [];
  const skipped: string[] = [];

  for (const r of rows) {
    if (ONLY.length && !ONLY.includes(r.contractNumber)) continue;
    const pays = await prisma.paymentTransaction.findMany({
      where: { contractId: r.id, status: 'SUCCESS' },
      select: { amount: true, unlockFee: true, paymentMethod: true, metadata: true },
    });
    const amounts = pays.map((x) => Math.round((x.amount - (x.unlockFee || 0)) * 100));
    const target = Math.round(r.over * 100);
    let doublePosted = amounts.some((a) => Math.abs(a - target) <= 2);
    if (!doublePosted) {
      for (let i = 0; i < amounts.length && !doublePosted; i++) {
        for (let j = i + 1; j < amounts.length; j++) if (Math.abs(amounts[i] + amounts[j] - target) <= 2) { doublePosted = true; break; }
      }
    }
    const handRecorded = pays.some((x) => !/^HUBTEL|^PAYSTACK/.test(x.paymentMethod) || /isManual/.test(x.metadata || ''));
    const penalties = await prisma.penalty.count({ where: { contractId: r.id } });
    if (!doublePosted || handRecorded || penalties > 0) {
      skipped.push(`${r.contractNumber} (${!doublePosted ? 'not a clean double posting' : handRecorded ? 'hand-recorded payments' : 'late charges'})`);
      continue;
    }

    const before = await prisma.installmentSchedule.findMany({
      where: { contractId: r.id },
      orderBy: { installmentNo: 'asc' },
      select: { installmentNo: true, dueDate: true, amount: true, paidAmount: true, status: true, paidAt: true },
    });
    // What the rebuild will leave overdue.
    let left = r.paid;
    let overdue = 0;
    for (const i of before) {
      if (i.status === 'WRITTEN_OFF') continue;
      const covered = Math.min(left, i.amount);
      left = Math.max(0, left - covered);
      if (i.amount - covered > 0.005 && i.dueDate < today) overdue += i.amount - covered;
    }
    overdue = Math.round(overdue * 100) / 100;
    if (overdue > 0 && !INCLUDE_OVERDUE) {
      heldOverdue.push(`${r.contractNumber} (would be GHS ${overdue.toFixed(2)} overdue)`);
      continue;
    }

    if (APPLY) {
      const newDue = overdue > 0 && RESCHEDULE_DAYS > 0 ? dueDateInDays(RESCHEDULE_DAYS) : null;
      const moved: Array<{ installmentNo: number; from: Date; to: Date }> = [];
      let endDateFrom: Date | null = null;
      await prisma.$transaction(async (tx) => {
        await rebuildContractFromPayments(r.id, tx);
        if (!newDue) return;
        // In the same transaction as the rebuild, so no device check ever sees
        // the instalments overdue: each one the correction left past due now
        // falls due on newDue.
        const late = await tx.installmentSchedule.findMany({
          where: { contractId: r.id, status: { notIn: ['PAID', 'WRITTEN_OFF'] }, dueDate: { lt: today } },
          select: { id: true, installmentNo: true, dueDate: true, amount: true, paidAmount: true },
        });
        for (const i of late) {
          if (i.amount - i.paidAmount <= 0.005) continue;
          await tx.installmentSchedule.update({
            where: { id: i.id },
            data: { dueDate: newDue, status: i.paidAmount > 0.005 ? 'PARTIAL' : 'PENDING' },
          });
          moved.push({ installmentNo: i.installmentNo, from: i.dueDate, to: newDue });
        }
        const c = await tx.hirePurchaseContract.findUnique({ where: { id: r.id }, select: { endDate: true } });
        if (c && c.endDate < newDue) {
          endDateFrom = c.endDate;
          await tx.hirePurchaseContract.update({ where: { id: r.id }, data: { endDate: newDue } });
        }
      }, REBUILD_TX);
      await createAuditLog({
        action: 'CORRECT_DOUBLE_POSTED_INSTALMENTS',
        entity: 'HirePurchaseContract',
        entityId: r.id,
        oldValues: { contractNumber: r.contractNumber, instalments: before },
        newValues: { contractNumber: r.contractNumber, overCreditRemoved: r.over, overdueAfter: overdue, rescheduled: moved.map((m) => ({ installmentNo: m.installmentNo, from: m.from.toISOString().slice(0, 10), to: m.to.toISOString().slice(0, 10) })), endDateMoved: endDateFrom ? { from: (endDateFrom as Date).toISOString().slice(0, 10), to: newDue!.toISOString().slice(0, 10) } : null, note: 'Instalments rebuilt from successful payments (payment posted twice before the 17 Nov 2026 fix).' },
      });
    }
    fixed.push(`${r.contractNumber} (removed GHS ${r.over.toFixed(2)} over-credit; GHS ${overdue.toFixed(2)} ${overdue > 0 && RESCHEDULE_DAYS > 0 ? `now due ${dueDateInDays(RESCHEDULE_DAYS).toISOString().slice(0, 10)}` : 'overdue'})`);
  }

  console.log(APPLY ? 'FIXED' : 'WOULD FIX', fixed.length);
  for (const f of fixed) console.log('  ' + f);
  console.log('HELD (would become overdue; needs --include-overdue):', heldOverdue.length);
  for (const h of heldOverdue) console.log('  ' + h);
  console.log('SKIPPED (check by hand):', skipped.length);
  for (const s of skipped) console.log('  ' + s);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
