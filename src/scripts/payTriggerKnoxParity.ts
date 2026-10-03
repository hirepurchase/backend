/**
 * npm run paytrigger:knox-parity -- <snapshot.json>
 *
 * Knox parity check for the PayTrigger integration — LOCAL TEST DATABASE ONLY.
 *
 * Builds the same Samsung fixture contracts every run, puts them through Knox
 * enrolment and evaluation in dry run, and writes the normalised outcome to a
 * snapshot file. Run it on the commit before PayTrigger and on the commit
 * after, then compare the two files: any difference blocks release.
 *
 * Knox is forced into dry run and pointed at an unreachable address, so no
 * request can reach Samsung whatever .env says.
 */
process.env.KNOX_GUARD_DRY_RUN = 'true';
process.env.KNOX_GUARD_ENABLE_LIVE_ACTIONS = 'false';
process.env.KNOX_GUARD_BASE_URL = 'http://127.0.0.1:9';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}

import * as fs from 'fs';
import * as crypto from 'crypto';
import prisma from '../config/database';
import { enrollManagedDeviceForContract, evaluateManagedDeviceForContract } from '../services/deviceControlPolicyService';

const RUN = `parity-${process.pid}-${Date.now()}`;
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(12, 0, 0, 0);
  return d;
};

interface Scenario {
  name: string;
  firstDueOffset: number;
  paidFirst?: boolean;
  ledger?: number | null;
  approved?: boolean;
  tempUnlockDays?: number;
  penalty?: number;
  status?: string;
  enrolDesired?: 'LOCKED' | 'UNLOCKED';
}

const SCENARIOS: Scenario[] = [
  { name: 'current', firstDueOffset: 3 },
  { name: 'due today', firstDueOffset: 0 },
  { name: '1 day overdue', firstDueOffset: -1 },
  { name: '2 days overdue', firstDueOffset: -2 },
  { name: '40 days overdue', firstDueOffset: -40 },
  { name: 'first paid, next current', firstDueOffset: -4, paidFirst: true },
  { name: 'agent deposit unpaid', firstDueOffset: 3, ledger: 300 },
  { name: 'agent deposit paid', firstDueOffset: 3, ledger: 0 },
  { name: 'approved, no ledger', firstDueOffset: 3, ledger: null },
  { name: 'admin-created, no ledger', firstDueOffset: 3, ledger: null, approved: false },
  { name: 'overdue with temporary unlock', firstDueOffset: -5, tempUnlockDays: 7 },
  { name: 'overdue with penalty', firstDueOffset: -3, penalty: 50 },
  { name: 'enrolled locked, current', firstDueOffset: 3, enrolDesired: 'LOCKED' },
  { name: 'completed', firstDueOffset: -20, status: 'COMPLETED' },
];

/** Strip ids, timestamps and anything else that differs between two runs. */
function normalise(value: unknown): unknown {
  if (value instanceof Date) return '<date>';
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      if (/(^id$|Id$|At$|^createdAt|^updatedAt|transactionId|approveId|deviceUid|serial|contractNumber|traceId|imei)/i.test(k)) {
        out[k] = v === null || v === undefined ? v : '<x>';
        continue;
      }
      out[k] = normalise(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(new RegExp(`${RUN}[\\w-]*`, 'g'), '<run>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<iso>');
  }
  return value;
}

async function build(s: Scenario, i: number) {
  const role = await prisma.role.upsert({ where: { name: 'SALES_AGENT' }, create: { name: 'SALES_AGENT' }, update: {} });
  const agent = await prisma.adminUser.upsert({
    where: { email: `${RUN}@test.local` },
    create: { email: `${RUN}@test.local`, password: 'x', firstName: 'Parity', lastName: 'Agent', phone: '0240000001', roleId: role.id },
    update: {},
  });
  const category = await prisma.productCategory.upsert({ where: { name: `${RUN}-cat` }, create: { name: `${RUN}-cat` }, update: {} });
  const product = await prisma.product.create({ data: { name: `SAMSUNG GALAXY A${i}`, basePrice: 2000, categoryId: category.id } });
  const uuid = crypto.randomUUID();
  await prisma.customer.create({
    data: { id_uuid: uuid, membershipId: `${RUN}-m${i}`, firstName: 'Parity', lastName: `C${i}`, phone: `${RUN}-p${i}`, createdById: agent.id },
  });
  const contract = await prisma.hirePurchaseContract.create({
    data: {
      contractNumber: `${RUN}-C${i}`,
      customerId_uuid: uuid,
      totalPrice: 2000, depositAmount: 400, financeAmount: 1600, installmentAmount: 400,
      paymentFrequency: 'WEEKLY', totalInstallments: 4,
      startDate: day(-30), endDate: day(s.firstDueOffset + 21),
      status: 'ACTIVE', outstandingBalance: 1600, totalPaid: 400, createdById: agent.id,
      approvedAt: s.approved === false ? null : day(-1),
      installments: {
        create: [0, 1, 2, 3].map((n) => ({
          installmentNo: n + 1,
          dueDate: day(s.firstDueOffset + n * 7),
          amount: 400,
          paidAmount: s.paidFirst && n === 0 ? 400 : 0,
          status: s.paidFirst && n === 0 ? 'PAID' : s.firstDueOffset + n * 7 < 0 ? 'OVERDUE' : 'PENDING',
        })),
      },
    },
  });
  await prisma.inventoryItem.create({
    data: { productId: product.id, serialNumber: `${RUN}-S${i}`, status: 'SOLD', contractId: contract.id },
  });
  if (s.ledger !== undefined && s.ledger !== null) {
    await prisma.agentDepositLedger.create({
      data: { contractId: contract.id, agentId: agent.id, contractNumber: contract.contractNumber, customerName: 'P', depositAmount: 400, commissionAmount: 0, amountDueCompany: Math.max(s.ledger, 0), outstandingBalance: s.ledger },
    });
  }
  if (s.tempUnlockDays) {
    await prisma.temporaryUnlockRequest.create({
      data: { contractId: contract.id, agentId: agent.id, requestedById: agent.id, requestedWeeks: 1, reason: 'parity', status: 'APPROVED', approvedWeeks: 1, expiresAt: day(s.tempUnlockDays) },
    });
  }
  if (s.penalty) {
    await prisma.penalty.create({ data: { contractId: contract.id, amount: s.penalty, reason: 'parity' } });
  }
  return contract;
}

async function main() {
  const out = process.argv[2];
  if (!out) {
    console.error('Usage: paytrigger:knox-parity -- <snapshot.json>');
    process.exit(2);
  }
  const snapshot: Record<string, unknown> = {};
  for (const [i, s] of SCENARIOS.entries()) {
    const contract = await build(s, i);
    const record: Record<string, unknown> = {};
    try {
      record.enrol = await enrollManagedDeviceForContract(contract.id, {
        ...(s.enrolDesired ? { desiredState: s.enrolDesired } : {}),
        metadata: { customerExperience: { disclosureAccepted: true, supportPhone: '0300000000', paymentUssd: '*170#' } },
      });
    } catch (err: any) {
      record.enrolError = String(err?.message || err);
    }
    if (s.status) await prisma.hirePurchaseContract.update({ where: { id: contract.id }, data: { status: s.status } });
    try {
      record.evaluate = await evaluateManagedDeviceForContract(contract.id);
    } catch (err: any) {
      record.evaluateError = String(err?.message || err);
    }
    const device = await (prisma as any).managedDevice.findUnique({
      where: { contractId: contract.id },
      select: { desiredState: true, actualState: true, enrollmentStatus: true, lastKnoxAction: true, isActive: true },
    });
    const commands = await (prisma as any).managedDeviceCommand
      .findMany({ where: { managedDevice: { contractId: contract.id } }, orderBy: { createdAt: 'asc' }, select: { type: true, status: true } })
      .catch(() => []);
    record.device = device;
    record.commands = commands;
    snapshot[s.name] = normalise(record);
  }
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`Knox parity snapshot: ${Object.keys(snapshot).length} scenarios → ${out}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
