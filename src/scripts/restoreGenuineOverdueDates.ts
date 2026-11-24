/**
 * Follow-up to fixDoublePostedAllocations --reschedule-days: that run moved
 * every instalment left overdue to the new date, including arrears the
 * customer already had before the correction. Only the amount the correction
 * newly exposed should get the grace. This puts the original due dates back
 * on instalments covering the arrears that existed before, taken from the
 * correction's own audit entry.
 *
 *   npx ts-node --transpile-only src/scripts/restoreGenuineOverdueDates.ts           # preview
 *   npx ts-node --transpile-only src/scripts/restoreGenuineOverdueDates.ts --apply
 */
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';

const APPLY = process.argv.includes('--apply');

type OldInstalment = { installmentNo: number; dueDate: string; amount: number; paidAmount: number; status: string };
type Moved = { installmentNo: number; from: string; to: string };

function midnightOf(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

async function main() {
  const entries = await prisma.auditLog.findMany({
    where: { action: 'CORRECT_DOUBLE_POSTED_INSTALMENTS' },
    select: { entityId: true, createdAt: true, oldValues: true, newValues: true },
  });
  const done = new Set(
    (await prisma.auditLog.findMany({ where: { action: 'RESTORE_GENUINE_OVERDUE_DATES' }, select: { entityId: true } })).map((a) => a.entityId),
  );
  let changed = 0;
  for (const e of entries) {
    if (!e.entityId || done.has(e.entityId)) continue;
    const nv = JSON.parse(e.newValues || '{}');
    const moved: Moved[] = nv.rescheduled || [];
    if (moved.length === 0) continue;
    const old: OldInstalment[] = JSON.parse(e.oldValues || '{}').instalments || [];
    const fixDay = midnightOf(e.createdAt);
    // Arrears the customer had before the correction, by the old schedule.
    const genuine = old
      .filter((i) => i.status !== 'PAID' && i.status !== 'WRITTEN_OFF' && new Date(i.dueDate) < fixDay)
      .reduce((s, i) => s + Math.max(0, i.amount - i.paidAmount), 0);
    if (genuine <= 0.005) continue;

    // Oldest first: the earliest moved instalments are the ones that were truly late.
    const order = [...moved].sort((a, b) => a.from.localeCompare(b.from));
    const insts = await prisma.installmentSchedule.findMany({
      where: { contractId: e.entityId, installmentNo: { in: order.map((m) => m.installmentNo) } },
      select: { id: true, installmentNo: true, amount: true, paidAmount: true, dueDate: true },
    });
    const byNo = new Map(insts.map((i) => [i.installmentNo, i]));
    let left = genuine;
    const restored: Array<{ installmentNo: number; to: string }> = [];
    for (const m of order) {
      if (left <= 0.005) break;
      const i = byNo.get(m.installmentNo);
      if (!i) continue;
      const owed = Math.max(0, i.amount - i.paidAmount);
      if (owed <= 0.005) continue;
      restored.push({ installmentNo: m.installmentNo, to: m.from });
      left -= owed;
    }
    if (restored.length === 0) continue;

    const contract = await prisma.hirePurchaseContract.findUnique({ where: { id: e.entityId }, select: { contractNumber: true, endDate: true } });
    console.log(`${contract?.contractNumber}: arrears before GHS ${genuine.toFixed(2)}; restore ${restored.map((r) => `#${r.installmentNo} to ${r.to}`).join(', ')}`);
    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        for (const r of restored) {
          const i = byNo.get(r.installmentNo)!;
          await tx.installmentSchedule.update({
            where: { id: i.id },
            data: { dueDate: new Date(`${r.to}T00:00:00.000Z`), status: i.paidAmount > 0.005 ? 'PARTIAL' : 'OVERDUE' },
          });
        }
        // The end date moves back if nothing now falls due after its old value.
        if (nv.endDateMoved?.from) {
          const latest = await tx.installmentSchedule.findFirst({ where: { contractId: e.entityId! }, orderBy: { dueDate: 'desc' }, select: { dueDate: true } });
          const oldEnd = new Date(`${nv.endDateMoved.from}T00:00:00.000Z`);
          const end = latest && latest.dueDate > oldEnd ? latest.dueDate : oldEnd;
          await tx.hirePurchaseContract.update({ where: { id: e.entityId! }, data: { endDate: end } });
        }
      });
      await createAuditLog({
        action: 'RESTORE_GENUINE_OVERDUE_DATES',
        entity: 'HirePurchaseContract',
        entityId: e.entityId,
        newValues: { contractNumber: contract?.contractNumber, arrearsBefore: Math.round(genuine * 100) / 100, restored },
      });
      changed++;
    }
  }
  console.log(APPLY ? `RESTORED ${changed}` : 'PREVIEW ONLY');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
