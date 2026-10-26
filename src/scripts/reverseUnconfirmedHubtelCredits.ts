/**
 * One-off repair, 23 Oct 2026: undo Hubtel payments that were credited
 * without Hubtel ever confirming them.
 *
 *   npx ts-node --transpile-only src/scripts/reverseUnconfirmedHubtelCredits.ts           # report only
 *   npx ts-node --transpile-only src/scripts/reverseUnconfirmedHubtelCredits.ts --apply   # make the changes
 *
 * Between 1f4e77c and 125ed6b the app's status poll read Hubtel's lookup code
 * "0000" as "paid" and marked payments SUCCESS seconds after the prompt was
 * sent. Those rows carry `"hubtelStatus":"PENDING"` from initiation and no
 * Hubtel callback data.
 *
 * Each such payment goes back to PENDING — the truth: unconfirmed — so the
 * fixed reconciliation can still credit any that Hubtel reports as Paid. The
 * contract is then rebuilt from its confirmed payments only, the same way
 * deleting a manual payment rebuilds it, and its device is re-evaluated.
 */
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { rebuildPenaltyAllocation } from '../services/penaltyService';
import { safelyEvaluateManagedDeviceForContract } from '../services/deviceControlPolicyService';
import { notifyPayTrigger } from '../services/payTrigger/events';

const APPLY = process.argv.includes('--apply');
const FROM = new Date('2026-10-22T17:00:00Z');
const round = (n: number) => Math.round(n * 100) / 100;

async function unconfirmedCredits() {
  const rows = await prisma.paymentTransaction.findMany({
    where: {
      status: 'SUCCESS',
      createdAt: { gte: FROM },
      paymentMethod: { in: ['HUBTEL_REGULAR', 'HUBTEL_MOMO'] },
      metadata: { contains: '"hubtelStatus":"PENDING"' },
    },
    orderBy: { createdAt: 'asc' },
    include: { contract: { select: { contractNumber: true, customer: { select: { firstName: true, lastName: true } } } } },
  });
  // Belt and braces: never touch a row that holds a Hubtel confirmation.
  return rows.filter((r) => {
    try {
      const m = JSON.parse(r.metadata || '{}');
      return !m.Data && !m.data && !m.ResponseCode && !m.callbackReceivedAt;
    } catch {
      return false;
    }
  });
}

/** Rebuild a contract from its SUCCESS payments, as deleteManualPayment does. */
async function rebuildContract(contractId: string, tx: any) {
  const contract = await tx.hirePurchaseContract.findUnique({ where: { id: contractId } });
  const confirmed = await tx.paymentTransaction.findMany({ where: { contractId, status: 'SUCCESS' }, select: { amount: true } });
  const paymentsSum = round(confirmed.reduce((s: number, p: { amount: number }) => s + p.amount, 0));
  const totalPaid = round(contract.depositAmount + paymentsSum);
  const outstanding = round(contract.totalPrice - totalPaid);

  const installments = await tx.installmentSchedule.findMany({ where: { contractId }, orderBy: { installmentNo: 'asc' } });
  const now = Date.now();
  let remaining = paymentsSum;
  for (const inst of installments) {
    let paidAmount = 0;
    let status = new Date(inst.dueDate).getTime() < now ? 'OVERDUE' : 'PENDING';
    let paidAt: Date | null = null;
    if (inst.status === 'WRITTEN_OFF') continue;
    if (remaining >= inst.amount - 0.005) {
      paidAmount = inst.amount;
      status = 'PAID';
      paidAt = inst.paidAt ?? new Date();
      remaining = round(remaining - inst.amount);
    } else if (remaining > 0) {
      paidAmount = remaining;
      status = 'PARTIAL';
      remaining = 0;
    }
    await tx.installmentSchedule.update({ where: { id: inst.id }, data: { paidAmount, status, paidAt } });
  }
  const penaltyOutstanding = await rebuildPenaltyAllocation(contractId, remaining, tx);
  const fullyPaid = outstanding <= 0.005 && penaltyOutstanding <= 0.005;
  await tx.hirePurchaseContract.update({
    where: { id: contractId },
    data: {
      totalPaid,
      outstandingBalance: Math.max(0, fullyPaid ? 0 : outstanding),
      status: fullyPaid ? 'COMPLETED' : contract.status === 'COMPLETED' ? 'ACTIVE' : contract.status,
      completedAt: fullyPaid ? contract.completedAt ?? new Date() : null,
    },
  });
  return { totalPaid, outstanding: Math.max(0, outstanding) };
}

async function main() {
  const rows = await unconfirmedCredits();
  const byContract = new Map<string, typeof rows>();
  for (const r of rows) byContract.set(r.contractId, [...(byContract.get(r.contractId) || []), r]);
  console.log(`${rows.length} unconfirmed credits on ${byContract.size} contracts, GHS ${round(rows.reduce((s, r) => s + r.amount, 0)).toFixed(2)}${APPLY ? '' : '  (report only — run with --apply to change them)'}\n`);

  for (const [contractId, list] of byContract) {
    const c = await prisma.hirePurchaseContract.findUniqueOrThrow({ where: { id: contractId } });
    const name = `${list[0].contract.customer.firstName} ${list[0].contract.customer.lastName}`.replace(/\s+/g, ' ').trim();
    const reverseSum = round(list.reduce((s, r) => s + r.amount, 0));
    console.log(`${list[0].contract.contractNumber} · ${name}: ${list.length} payment(s), GHS ${reverseSum.toFixed(2)} · balance now GHS ${c.outstandingBalance.toFixed(2)} → GHS ${round(c.outstandingBalance + reverseSum).toFixed(2)}`);
    if (!APPLY) continue;

    const result = await prisma.$transaction(async (tx) => {
      for (const r of list) {
        const meta = JSON.parse(r.metadata || '{}');
        await tx.paymentTransaction.update({
          where: { id: r.id },
          data: {
            status: 'PENDING',
            paymentDate: null,
            metadata: JSON.stringify({
              ...meta,
              creditReversedAt: new Date().toISOString(),
              creditReversedReason: 'Credited by the status check without a Hubtel confirmation (22–23 Oct). Back to pending until Hubtel confirms.',
            }),
          },
        });
      }
      return rebuildContract(contractId, tx);
      // The production database is reached over a slow pooled link.
    }, { maxWait: 30_000, timeout: 120_000 });
    for (const r of list) {
      await createAuditLog({
        action: 'REVERSE_UNCONFIRMED_HUBTEL_CREDIT',
        entity: 'PaymentTransaction',
        entityId: r.id,
        oldValues: { status: 'SUCCESS', amount: r.amount, transactionRef: r.transactionRef },
        newValues: { status: 'PENDING', contractNumber: r.contract.contractNumber },
      });
    }
    await safelyEvaluateManagedDeviceForContract(contractId);
    notifyPayTrigger(contractId, 'PAYMENT_REVERSED');
    const device = await prisma.managedDevice.findUnique({ where: { contractId }, select: { desiredState: true, actualState: true, lastError: true } });
    console.log(`   done: balance GHS ${result.outstanding.toFixed(2)}${device ? ` · phone ${device.desiredState}/${device.actualState}${device.lastError ? ' · ' + device.lastError : ''}` : ''}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, '<db>'));
  await prisma.$disconnect();
  process.exit(1);
});
