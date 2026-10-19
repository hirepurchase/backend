/**
 * Temporary unlock "block sales" switch — LOCAL TEST DATABASE ONLY.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node --transpile-only src/scripts/temporaryUnlockBlockSettingTest.ts
 *
 * An agent whose customer's unlock ran out unpaid is blocked from new
 * contracts only while the admin switch is on (the default).
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { evaluateContractSubmissionGuardrails } from '../services/contractReviewService';

let failures = 0;
async function check(name: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✔ ${name}`); } catch (err: any) { failures++; console.log(`  ✘ ${name}\n      ${err?.message || err}`); }
}
const day = (o: number) => new Date(Date.now() + o * 86400_000);

async function main() {
  const T = `tub${Date.now()}`;
  const role = await prisma.role.upsert({ where: { name: 'AGENT' }, create: { name: 'AGENT' }, update: {} });
  const agent = await prisma.adminUser.create({ data: { email: `${T}@t.local`, password: 'x', firstName: 'Test', lastName: 'Agent', roleId: role.id } });
  const cat = await prisma.productCategory.create({ data: { name: T } });
  const product = await prisma.product.create({ data: { name: `SAMSUNG A06 ${T}`, basePrice: 1500, categoryId: cat.id } });
  const uuid = crypto.randomUUID();
  const customer = await prisma.customer.create({ data: { id_uuid: uuid, membershipId: T, firstName: 'Late', lastName: 'Payer', phone: T, createdById: agent.id } });
  const contract = await prisma.hirePurchaseContract.create({ data: {
    contractNumber: T, customerId_uuid: uuid, totalPrice: 1500, depositAmount: 300, financeAmount: 1200, installmentAmount: 300,
    paymentFrequency: 'WEEKLY', totalInstallments: 4, startDate: day(-30), endDate: day(10), status: 'ACTIVE',
    outstandingBalance: 1200, totalPaid: 300, createdById: agent.id, approvedAt: day(-31) } });
  await prisma.temporaryUnlockRequest.create({ data: { contractId: contract.id, agentId: agent.id, requestedById: agent.id, requestedWeeks: 1, reason: 'Test: promised to pay', status: 'DEFAULTED', resolvedAt: day(-1) } });
  const item = await prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: `35${String(Date.now()).slice(-13)}`, status: 'AVAILABLE', assignedAgentId: agent.id } });

  const assess = () => evaluateContractSubmissionGuardrails({ customerId: customer.id, inventoryItemId: item.id, totalPrice: 1500, depositAmount: 300, totalInstallments: 4, agentId: agent.id, agentRole: 'AGENT' });
  const blocked = (r: { blockers: string[] }) => r.blockers.some((b) => /expired with the overdue payments still unpaid/.test(b));
  const original = await prisma.knoxGuardSettings.findFirst();
  const setSwitch = async (on: boolean) => {
    const row = await prisma.knoxGuardSettings.findFirst();
    if (row) await prisma.knoxGuardSettings.update({ where: { id: row.id }, data: { temporaryUnlockDefaultBlocksSales: on } });
    else await prisma.knoxGuardSettings.create({ data: { id: 'singleton', temporaryUnlockDefaultBlocksSales: on } });
  };

  await check('switch on (the default) → the agent is blocked', async () => {
    await setSwitch(true);
    assert.ok(blocked(await assess()));
  });
  await check('switch off → the agent can sell, but is warned and the approver sees the flag', async () => {
    await setSwitch(false);
    const r = await assess();
    assert.ok(!blocked(r));
    assert.ok(r.warnings.some((w) => /ended with the overdue payments still unpaid/.test(w)), 'warned');
    assert.ok(r.riskFlags.includes('DEFAULTED_TEMPORARY_UNLOCK'), 'flag kept for the approver');
  });
  await check('switched back on → blocked again', async () => {
    await setSwitch(true);
    assert.ok(blocked(await assess()));
  });

  if (original) await prisma.knoxGuardSettings.update({ where: { id: original.id }, data: { temporaryUnlockDefaultBlocksSales: original.temporaryUnlockDefaultBlocksSales } });
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll temporary unlock switch checks passed');
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
