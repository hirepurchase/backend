/**
 * One-off repair, 16 Oct 2026: two resold phones whose Knox record still
 * followed the written-off first sale. Moves each record to the phone's
 * current contract and lets the normal evaluation act on it — for a paid-off
 * contract that is the ownership transfer and Knox release.
 *
 *   npx ts-node --transpile-only src/scripts/repairKnoxResaleLinks.ts [--apply]
 *
 * Without --apply it only reports. Each phone is checked again before any
 * change, and skipped if it is no longer in the state found on 16 October.
 */
import prisma from '../config/database';
import { claimManagedDeviceForContract, evaluateManagedDeviceForContract } from '../services/deviceControlPolicyService';
import { createAuditLog } from '../services/auditService';

const APPLY = process.argv.includes('--apply');
const PHONES = [
  { imei: '350074729965732', oldContract: 'CON2602Z1C6UR', newContract: 'CON26075P7JE8' },
  { imei: '354880844191095', oldContract: 'CON2605MBC9EH', newContract: 'CON2608C65QN4' },
];

async function main() {
  for (const ph of PHONES) {
    const md = await prisma.managedDevice.findFirst({ where: { deviceUid: ph.imei, isActive: true }, include: { contract: { select: { contractNumber: true, status: true } } } });
    const item = await prisma.inventoryItem.findFirst({ where: { serialNumber: ph.imei }, include: { contract: { select: { id: true, contractNumber: true, status: true, completedAt: true, outstandingBalance: true } } } });
    const ok = md && item?.contract && md.contract?.contractNumber === ph.oldContract && item.contract.contractNumber === ph.newContract;
    console.log(`\n${ph.imei}: Knox on ${md?.contract?.contractNumber} (${md?.contract?.status}), phone sold on ${item?.contract?.contractNumber} (${item?.contract?.status}, owes ${item?.contract?.outstandingBalance}) — Knox ${md?.desiredState}/${md?.actualState}`);
    if (!ok || !md || !item?.contract) { console.log('  state has changed since 16 October — skipped'); continue; }
    if (!APPLY) { console.log('  would relink and re-evaluate (run with --apply)'); continue; }

    const target = item.contract;
    if (target.status === 'COMPLETED' && !target.completedAt) {
      const last = await prisma.paymentTransaction.findFirst({ where: { contractId: target.id, status: 'SUCCESS' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      await prisma.hirePurchaseContract.update({ where: { id: target.id }, data: { completedAt: last?.createdAt ?? new Date() } });
      console.log(`  completion date set to ${(last?.createdAt ?? new Date()).toISOString()}`);
    }
    await claimManagedDeviceForContract(item.id, target.id);
    console.log(`  Knox record moved to ${target.contractNumber}`);
    const result: any = await evaluateManagedDeviceForContract(target.id);
    console.log('  evaluation:', JSON.stringify({ action: result?.action, success: result?.success, dryRun: result?.dryRun, desired: result?.desiredState, error: result?.error }));
    const after = await prisma.managedDevice.findUnique({ where: { id: md.id }, select: { contractId: true, enrollmentStatus: true, desiredState: true, actualState: true, lastKnoxAction: true, lastError: true } });
    console.log('  now:', JSON.stringify(after));
    await createAuditLog({ action: 'REPAIR_KNOX_RESALE_LINK', entity: 'ManagedDevice', entityId: md.id,
      oldValues: { contract: ph.oldContract }, newValues: { contract: ph.newContract, enrollmentStatus: after?.enrollmentStatus, desiredState: after?.desiredState } });
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, '<db>')); await prisma.$disconnect(); process.exit(1); });
