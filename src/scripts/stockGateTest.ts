/**
 * Stock gate test — LOCAL TEST DATABASE ONLY.
 *
 *   KNOX_GUARD_DRY_RUN=true DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/stockGateTest.ts
 *
 * Agents below their sales or quality target last month are not given new
 * devices. Built relative to today, so "last month" is always the month just
 * gone. Exercises the rule itself, then the three places devices are handed
 * out: adding stock, editing a device, and a cluster transfer.
 */
const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

import assert from 'assert';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { setTargets, validateTarget } from '../services/kpi';
import { getStockGate } from '../services/kpi/stockGate';
import { transferClusterStock } from '../controllers/clusterStockController';
import { addInventoryItem, updateInventoryItem } from '../controllers/productController';

const TAG = `sg${Date.now()}`;
const now = new Date();
const monthsAgo = (n: number, day = 10) => new Date(now.getFullYear(), now.getMonth() - n, day, 12);
let failures = 0;
async function check(name: string, fn: () => Promise<unknown> | unknown) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err: any) {
    failures++;
    console.log(`  ✘ ${name}\n      ${err?.message || err}`);
  }
}

async function call(handler: (req: any, res: any) => Promise<unknown>, user: { id: string; role: string; permissions?: string[] }, body: unknown, params: Record<string, string> = {}) {
  let status = 200;
  let payload: any;
  const res: any = {
    status(s: number) { status = s; return res; },
    json(b: unknown) { payload = b; return res; },
  };
  await handler({ user: { email: 'x', permissions: [], ...user }, body, params, query: {}, ip: '127.0.0.1', headers: {} }, res);
  return { status, body: payload };
}

async function main() {
  await prisma.kpiTarget.deleteMany({});
  const role = (name: string) => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const [clusterRole, agentRole] = await Promise.all([role('CLUSTER_AGENT'), role('AGENT')]);
  const mk = (name: string, roleId: string, createdAt?: Date) =>
    prisma.adminUser.create({ data: { email: `${TAG}-${name.toLowerCase()}@t.local`, password: 'x', firstName: name, lastName: TAG, phone: '0240000000', roleId, ...(createdAt ? { createdAt } : {}) } });
  const L = await mk('Leader', clusterRole.id, monthsAgo(12));
  const G = await mk('Good', agentRole.id, monthsAgo(12));
  const C = await mk('Close', agentRole.id, monthsAgo(12));
  const B = await mk('Bad', agentRole.id, monthsAgo(12));
  const N = await mk('New', agentRole.id);
  for (const a of [G, C, B, N]) {
    await prisma.clusterAgentAssignment.create({ data: { clusterAgentId: L.id, agentId: a.id, assignedById: L.id } });
  }

  const cat = await prisma.productCategory.create({ data: { name: `${TAG}-cat` } });
  const product = await prisma.product.create({ data: { name: 'TEST PHONE', basePrice: 2000, categoryId: cat.id } });
  let n = 0;
  const sale = async (agentId: string, approvedAt: Date) => {
    n++;
    const uuid = crypto.randomUUID();
    await prisma.customer.create({ data: { id_uuid: uuid, membershipId: `${TAG}${n}`, firstName: 'C', lastName: `${n}`, phone: `${TAG}${n}`, createdById: agentId } });
    await prisma.hirePurchaseContract.create({
      data: {
        contractNumber: `${TAG}-${n}`, customerId_uuid: uuid, totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
        paymentFrequency: 'WEEKLY', totalInstallments: 1, startDate: approvedAt, endDate: monthsAgo(-3), status: 'ACTIVE',
        outstandingBalance: 1600, createdById: agentId, approvedAt,
        installments: { create: [{ installmentNo: 1, dueDate: monthsAgo(-2), amount: 1600 }] },
      },
    });
  };
  // Everyone but the new agent first sold long ago.
  for (const a of [G, C, B]) await sale(a.id, monthsAgo(6));
  // Last month: Good 10 sales, Close 9, Bad none.
  for (let i = 0; i < 10; i++) await sale(G.id, monthsAgo(1, 3 + i));
  for (let i = 0; i < 9; i++) await sale(C.id, monthsAgo(1, 3 + i));
  // Quality for last month = sales from two months before it, still current.
  await sale(G.id, monthsAgo(3));
  await sale(C.id, monthsAgo(3));

  const device = (agentId: string | null, serial: string) =>
    prisma.inventoryItem.create({ data: { productId: product.id, serialNumber: `${TAG}${serial}`, assignedAgentId: agentId } });
  const fromBad = await device(B.id, '01');
  const toBad1 = await device(G.id, '02');
  const toBad2 = await device(G.id, '03');
  const heldByBad = await device(B.id, '04');
  const unassigned = await device(null, '05');

  const leader = { id: L.id, role: 'CLUSTER_AGENT', permissions: ['VIEW_ASSIGNED_CONTRACTS'] };
  const admin = { id: L.id, role: 'ADMIN', permissions: ['MANAGE_INVENTORY', 'EDIT_INVENTORY'] };
  const agents = [G.id, C.id, B.id, N.id, L.id];

  console.log('The rule');
  await check('no sales or quality target → nobody is blocked', async () => {
    const gate = await getStockGate(agents);
    assert.strictEqual(gate.active, false);
    assert.ok(![...gate.blocks.values()].some((b) => b.blocked));
  });

  await setTargets('AGENT', [validateTarget('AGENT', 'NEW_CONTRACTS', 10), validateTarget('AGENT', 'QUALITY_CONTRACTS', 1)], L.id);
  const gate = await getStockGate(agents);
  await check('judged on last month', () => {
    const last = monthsAgo(1);
    assert.strictEqual(gate.month, `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`);
  });
  await check('on target → may receive devices', () => assert.strictEqual(gate.blocks.get(G.id)?.blocked, false));
  await check('close (9 of 10) → still may receive devices', () => assert.strictEqual(gate.blocks.get(C.id)?.blocked, false));
  await check('below on sales and quality → blocked, both reasons given', () => {
    const b = gate.blocks.get(B.id)!;
    assert.strictEqual(b.blocked, true);
    assert.strictEqual(b.reasons.length, 2);
    assert.match(b.reasons[0], /New contracts in .*: 0 against a target of 10/);
    assert.match(b.reasons[1], /Quality contracts in .*: 0 against a target of 1/);
  });
  await check('new agent → exempt', () => {
    const b = gate.blocks.get(N.id)!;
    assert.strictEqual(b.blocked, false);
    assert.match(b.exempt || '', /New agent/);
  });
  await check('cluster leader → exempt', () => {
    const b = gate.blocks.get(L.id)!;
    assert.strictEqual(b.blocked, false);
    assert.match(b.exempt || '', /Cluster leaders/);
  });
  await check('only the targets that are set count', async () => {
    await setTargets('AGENT', [validateTarget('AGENT', 'NEW_CONTRACTS', null)], L.id);
    const b = (await getStockGate([B.id])).blocks.get(B.id)!;
    assert.strictEqual(b.reasons.length, 1);
    assert.match(b.reasons[0], /Quality/);
    await setTargets('AGENT', [validateTarget('AGENT', 'NEW_CONTRACTS', 10)], L.id);
  });
  await check('fails open when the KPIs cannot be read', async () => {
    const real = (prisma as any).kpiTarget.findMany;
    (prisma as any).kpiTarget.findMany = () => Promise.reject(new Error('relation "KpiTarget" does not exist'));
    try {
      const g = await getStockGate([B.id]);
      assert.strictEqual(g.active, false);
      assert.strictEqual(g.blocks.get(B.id)?.blocked ?? false, false);
    } finally {
      (prisma as any).kpiTarget.findMany = real;
    }
  });

  console.log('Cluster transfers');
  await check('a leader moves stock away from a blocked agent', async () => {
    const r = await call(transferClusterStock, leader, { inventoryItemIds: [fromBad.id], toAgentId: G.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await prisma.inventoryItem.findUnique({ where: { id: fromBad.id } }))?.assignedAgentId, G.id);
  });
  await check('a leader cannot send stock to a blocked agent', async () => {
    const r = await call(transferClusterStock, leader, { inventoryItemIds: [toBad1.id], toAgentId: B.id });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.canOverride, false);
    assert.match(r.body.error, /below target last month/);
  });
  await check('…not even with a reason', async () => {
    const r = await call(transferClusterStock, leader, { inventoryItemIds: [toBad1.id], toAgentId: B.id, overrideReason: 'please' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await prisma.inventoryItem.findUnique({ where: { id: toBad1.id } }))?.assignedAgentId, G.id);
  });
  await check('an admin without a reason is told they can override', async () => {
    const r = await call(transferClusterStock, admin, { inventoryItemIds: [toBad1.id], toAgentId: B.id });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.canOverride, true);
  });
  await check('an admin with a reason can, and it is audited', async () => {
    const r = await call(transferClusterStock, admin, { inventoryItemIds: [toBad1.id], toAgentId: B.id, overrideReason: 'Replacement for a faulty phone' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const log = await prisma.auditLog.findFirst({ where: { action: 'STOCK_GATE_OVERRIDE', userId: L.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(log && /Replacement for a faulty phone/.test(log.newValues || ''));
  });
  await check('a leader can still give stock to an agent who is close to target', async () => {
    const r = await call(transferClusterStock, leader, { inventoryItemIds: [toBad2.id], toAgentId: C.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  console.log('Adding and editing devices');
  await check('adding a device for a blocked agent is refused', async () => {
    const r = await call(addInventoryItem, admin, { productId: product.id, serialNumber: `${TAG}10`, assignedAgentId: B.id });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await prisma.inventoryItem.count({ where: { serialNumber: `${TAG}10` } }), 0);
  });
  await check('…allowed for an admin with a reason', async () => {
    const r = await call(addInventoryItem, admin, { productId: product.id, serialNumber: `${TAG}11`, assignedAgentId: B.id, overrideReason: 'Agent covering a new area' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  });
  await check('adding a device for an agent on target works as before', async () => {
    const r = await call(addInventoryItem, admin, { productId: product.id, serialNumber: `${TAG}12`, assignedAgentId: G.id });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  });
  await check('assigning an existing device to a blocked agent is refused', async () => {
    const r = await call(updateInventoryItem, admin, { assignedAgentId: B.id }, { id: unassigned.id });
    assert.strictEqual(r.status, 409);
  });
  await check('editing a device the blocked agent already holds is not', async () => {
    const r = await call(updateInventoryItem, admin, { registeredUnder: 'Corrected name' }, { id: heldByBad.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });
  await check('taking a device off a blocked agent is not', async () => {
    const r = await call(updateInventoryItem, admin, { assignedAgentId: G.id }, { id: heldByBad.id });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  await prisma.kpiTarget.deleteMany({});
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Knox upload work started by addInventoryItem runs in the background.
    setTimeout(() => process.exit(failures ? 1 : 0), 500);
  });
