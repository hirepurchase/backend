/**
 * Knox resale relink test — LOCAL TEST DATABASE ONLY, Knox in dry run.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/knoxResaleRelinkTest.ts
 *
 * A phone sold, written off and sold again must take its Knox record to the
 * new contract; a record still on a live contract must never be taken.
 */
process.env.KNOX_GUARD_DRY_RUN = 'true';
process.env.KNOX_GUARD_ENABLE_LIVE_ACTIONS = 'false';
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.message || err}`); }
}
const TAG = `kr${Date.now()}`;
const day = (o: number) => new Date(Date.now() + o * 86400_000);
let seq = 0;

async function main() {
  const svc = await import('../services/deviceControlPolicyService');
  const role = await prisma.role.upsert({ where: { name: 'AGENT' }, create: { name: 'AGENT' }, update: {} });
  const agent = await prisma.adminUser.create({ data: { email: `${TAG}@t.local`, password: 'x', firstName: 'Test', lastName: 'Agent', roleId: role.id } });
  const cat = await prisma.productCategory.create({ data: { name: `${TAG}-cat` } });
  const product = await prisma.product.create({ data: { name: `SAMSUNG A17 ${TAG}`, basePrice: 2000, categoryId: cat.id } });
  const contract = async (status: string) => {
    seq++;
    const uuid = crypto.randomUUID();
    await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}-${seq}`, firstName: 'Cust', lastName: `N${seq}`, phone: `${TAG}${seq}`, createdById: agent.id } });
    return prisma.hirePurchaseContract.create({ data: {
      contractNumber: `${TAG}-C${seq}`, customerId_uuid: uuid, totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
      paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: day(-10), endDate: day(20), status, outstandingBalance: status === 'COMPLETED' ? 0 : 1600,
      totalPaid: status === 'COMPLETED' ? 2000 : 400, createdById: agent.id, approvedAt: day(-12),
      installments: { create: [0, 1, 2, 3].map((n) => ({ installmentNo: n + 1, dueDate: day(-3 + n * 7), amount: 400, paidAmount: status === 'COMPLETED' ? 400 : 0, status: status === 'COMPLETED' ? 'PAID' : 'PENDING' })) } } });
  };
  const phone = async (firstStatus: string) => {
    const old = await contract(firstStatus);
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: `35${String(Date.now()).slice(-10)}${String(++seq).padStart(3, '0')}`, status: 'SOLD', contractId: old.id } });
    const md = await prisma.managedDevice.create({ data: { contractId: old.id, inventoryItemId: item.id, customerId_uuid: old.customerId_uuid, deviceUid: item.serialNumber, approveId: old.contractNumber, enrollmentStatus: 'ACTIVE', desiredState: 'LOCKED', actualState: 'LOCKED', isActive: true } });
    return { old, item, md };
  };
  const resell = async (item: { id: string }, status = 'ACTIVE') => {
    const fresh = await contract(status);
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { contractId: fresh.id } });
    return fresh;
  };

  await check('written-off phone resold → the Knox record moves to the new contract', async () => {
    const { item, md } = await phone('WRITTEN_OFF');
    const fresh = await resell(item);
    const claimed = await svc.claimManagedDeviceForContract(item.id, fresh.id, agent.id);
    assert.strictEqual(claimed?.id, md.id);
    const after = await prisma.managedDevice.findUniqueOrThrow({ where: { id: md.id } });
    assert.deepStrictEqual([after.contractId, after.customerId_uuid], [fresh.id, fresh.customerId_uuid]);
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'MANAGED_DEVICE_RELINKED', entityId: md.id } }), 'audited');
  });
  await check('cancelled and paid-off earlier contracts are also given up', async () => {
    for (const s of ['CANCELLED', 'COMPLETED']) {
      const { item, md } = await phone(s);
      const fresh = await resell(item);
      assert.strictEqual((await svc.claimManagedDeviceForContract(item.id, fresh.id))?.id, md.id, s);
    }
  });
  await check('a record on a live contract is never taken', async () => {
    for (const s of ['ACTIVE', 'DEFAULTED', 'PENDING_APPROVAL']) {
      const { item, md, old } = await phone(s);
      const fresh = await resell(item);
      assert.strictEqual(await svc.claimManagedDeviceForContract(item.id, fresh.id), null, s);
      assert.strictEqual((await prisma.managedDevice.findUniqueOrThrow({ where: { id: md.id } })).contractId, old.id);
    }
  });
  await check('Knox enrolment of the new sale claims the record instead of failing', async () => {
    const { item, md } = await phone('WRITTEN_OFF');
    const fresh = await resell(item);
    await svc.enrollManagedDeviceForContract(fresh.id, { metadata: { customerExperience: { disclosureAccepted: true, supportPhone: '0300000000', paymentUssd: '*170#' } } } as any);
    const all = await prisma.managedDevice.findMany({ where: { inventoryItemId: item.id } });
    assert.strictEqual(all.length, 1, 'no duplicate record');
    assert.strictEqual(all[0].id, md.id);
    assert.strictEqual(all[0].contractId, fresh.id);
  });
  await check('paid off on the new contract → judged on it, so the phone is to be unlocked', async () => {
    const { item, md } = await phone('WRITTEN_OFF');
    const fresh = await resell(item, 'COMPLETED');
    await svc.claimManagedDeviceForContract(item.id, fresh.id);
    const r = await svc.unenrollManagedDeviceForContract(fresh.id, 'Contract completed — ownership transferred to customer.');
    assert.strictEqual(r?.deviceId, md.id);
    const after = await prisma.managedDevice.findUniqueOrThrow({ where: { id: md.id } });
    assert.deepStrictEqual([after.desiredState, after.enrollmentStatus], ['UNLOCKED', 'COMPLETING']);
  });

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll Knox resale checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
