import 'dotenv/config';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  calculateEndDate,
  calculateInstallmentSchedule,
  sanitizePhoneNumber,
} from '../src/utils/helpers';
import {
  seedBaseCatalog,
  seedDefaultAdminUsers,
  seedPermissionsAndRoles,
} from './seedShared';

const prisma = new PrismaClient();
const prismaAny = prisma as any;
const DEMO_AGENT_PASSWORD = 'password@1';
const DEMO_ADMIN_PASSWORD = 'admin123';
const DEMO_SUPPORT_PHONE = '0300000099';
const DEMO_WARNING_MESSAGE = 'This financed device is restricted until overdue payments are cleared.';
const APPROVAL_AUDIT_ACTIONS = [
  'CREATE_CONTRACT',
  'SUBMIT_CONTRACT_FOR_APPROVAL',
  'ASSIGN_CONTRACT_APPROVER',
  'REQUEST_CONTRACT_REVISION',
  'RESUBMIT_CONTRACT_FOR_APPROVAL',
  'APPROVE_CONTRACT',
  'EDIT_PENDING_CONTRACT',
  'EDIT_REVISION_REQUESTED_CONTRACT',
] as const;

type PaymentFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
type ContractStatus =
  | 'ACTIVE'
  | 'COMPLETED'
  | 'DEFAULTED'
  | 'CANCELLED'
  | 'PENDING_APPROVAL'
  | 'REVISION_REQUESTED';
type PaymentStatus = 'SUCCESS' | 'PENDING' | 'FAILED';
type InstallmentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';

type DemoUserSeed = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  roleName: 'ADMIN' | 'AGENT';
  password: string;
};

type DemoCustomerSeed = {
  membershipId: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address: string;
  nationalId: string;
  createdByEmail: string;
};

type DemoInventorySeed = {
  serialNumber: string;
  productId: string;
};

type DemoPreapprovalSeed = {
  clientReferenceId: string;
  customerMembershipId: string;
  customerMsisdn: string;
  channel: string;
  status: 'PENDING' | 'APPROVED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
  verificationType: string | null;
  otpPrefix?: string | null;
  hubtelPreapprovalId?: string | null;
  approvedAt?: Date | null;
  expiresAt?: Date | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
};

type DemoPaymentSeed = {
  transactionRef: string;
  amount: number;
  status: PaymentStatus;
  paymentMethod: string;
  mobileMoneyProvider?: string | null;
  mobileMoneyNumber?: string | null;
  externalRef?: string | null;
  paymentDate?: Date | null;
  createdAt: Date;
  failureReason?: string | null;
  metadata?: Record<string, unknown>;
};

type DemoAuditLogSeed = {
  action: typeof APPROVAL_AUDIT_ACTIONS[number];
  actorEmail: string;
  createdAt: Date;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
};

type DemoManagedDeviceCommandSeed = {
  type: 'APPROVE_DEVICE' | 'LOCK_DEVICE' | 'UNLOCK_DEVICE' | 'SYNC_DEVICE';
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  createdAt: Date;
  completedAt?: Date | null;
  payload?: Record<string, unknown>;
  response?: Record<string, unknown>;
  errorMessage?: string | null;
};

type DemoManagedDeviceSeed = {
  deviceUid: string;
  deviceUidType: 'SERIAL_NUMBER' | 'IMEI';
  approveId: string;
  knoxObjectId: string;
  knoxTenantDomain: string;
  knoxStatus: string;
  enrollmentStatus: string;
  desiredState: 'LOCKED' | 'UNLOCKED';
  actualState: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN' | 'PENDING';
  lastLockedAt?: Date | null;
  lastUnlockedAt?: Date | null;
  lastEvaluatedAt?: Date | null;
  lastSyncedAt?: Date | null;
  commands: DemoManagedDeviceCommandSeed[];
};

type DemoContractSeed = {
  contractNumber: string;
  customerMembershipId: string;
  inventorySerialNumber: string;
  createdByEmail: string;
  approvedByEmail?: string | null;
  totalPrice: number;
  depositAmount: number;
  paymentFrequency: PaymentFrequency;
  totalInstallments: number;
  gracePeriodDays: number;
  penaltyPercentage: number;
  startDate: Date;
  createdAt: Date;
  status: ContractStatus;
  paymentMethod: string | null;
  mobileMoneyNetwork?: string | null;
  mobileMoneyNumber?: string | null;
  hubtelPreapprovalClientReferenceId?: string | null;
  approvedAt?: Date | null;
  rejectionReason?: string | null;
  ownershipTransferred?: boolean;
  successfulPaymentAllocations: DemoPaymentSeed[];
  additionalPayments?: DemoPaymentSeed[];
  auditLogs: DemoAuditLogSeed[];
  managedDevice?: DemoManagedDeviceSeed;
};

type InstallmentRecord = {
  installmentNo: number;
  dueDate: Date;
  amount: number;
  paidAmount: number;
  status: InstallmentStatus;
  paidAt: Date | null;
};

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function withTime(date: Date, hours: number, minutes = 0): Date {
  const next = new Date(date);
  next.setHours(hours, minutes, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addWeeks(date: Date, weeks: number): Date {
  return addDays(date, weeks * 7);
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function addHours(date: Date, hours: number): Date {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function addMinutes(date: Date, minutes: number): Date {
  const next = new Date(date);
  next.setMinutes(next.getMinutes() + minutes);
  return next;
}

function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function buildInstallments(
  financeAmount: number,
  paymentFrequency: PaymentFrequency,
  totalInstallments: number,
  startDate: Date,
  successfulPaymentsTotal: number,
  contractStatus: ContractStatus,
  today: Date
): InstallmentRecord[] {
  const baseSchedule = calculateInstallmentSchedule(
    financeAmount,
    paymentFrequency,
    totalInstallments,
    startDate
  );

  let remainingSuccessfulAmount = successfulPaymentsTotal;

  return baseSchedule.map((item) => {
    let paidAmount = 0;
    let status: InstallmentStatus = 'PENDING';
    let paidAt: Date | null = null;

    if (remainingSuccessfulAmount >= item.amount) {
      paidAmount = item.amount;
      remainingSuccessfulAmount = roundCurrency(remainingSuccessfulAmount - item.amount);
      status = 'PAID';
      paidAt = item.dueDate;
    } else if (remainingSuccessfulAmount > 0) {
      paidAmount = roundCurrency(remainingSuccessfulAmount);
      remainingSuccessfulAmount = 0;
      status = item.dueDate < today ? 'OVERDUE' : 'PARTIAL';
    } else if (contractStatus === 'ACTIVE' || contractStatus === 'DEFAULTED') {
      status = item.dueDate < today ? 'OVERDUE' : 'PENDING';
    } else if (contractStatus === 'COMPLETED') {
      paidAmount = item.amount;
      status = 'PAID';
      paidAt = item.dueDate;
    }

    return {
      installmentNo: item.installmentNo,
      dueDate: item.dueDate,
      amount: item.amount,
      paidAmount: roundCurrency(paidAmount),
      status,
      paidAt,
    };
  });
}

async function ensureDemoUsers(
  agentRoleId: string,
  adminRoleId: string
): Promise<Record<string, { id: string; email: string; firstName: string; lastName: string }>> {
  const users: DemoUserSeed[] = [
    {
      email: 'grace.agent@hirepurchase.com',
      firstName: 'Grace',
      lastName: 'Mensah',
      phone: '0246002101',
      roleName: 'AGENT',
      password: DEMO_AGENT_PASSWORD,
    },
    {
      email: 'kwame.agent@hirepurchase.com',
      firstName: 'Kwame',
      lastName: 'Boateng',
      phone: '0246002102',
      roleName: 'AGENT',
      password: DEMO_AGENT_PASSWORD,
    },
    {
      email: 'ops.demo@hirepurchase.com',
      firstName: 'Operations',
      lastName: 'Lead',
      phone: '0246002103',
      roleName: 'ADMIN',
      password: DEMO_ADMIN_PASSWORD,
    },
  ];

  const byEmail: Record<string, { id: string; email: string; firstName: string; lastName: string }> = {};

  for (const user of users) {
    const passwordHash = await bcrypt.hash(user.password, 12);
    const roleId = user.roleName === 'ADMIN' ? adminRoleId : agentRoleId;
    const created = await prisma.adminUser.upsert({
      where: { email: user.email },
      update: {
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        roleId,
        password: passwordHash,
        isActive: true,
      },
      create: {
        email: user.email,
        password: passwordHash,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        roleId,
      },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    byEmail[user.email] = created;
  }

  const defaultAdmins = await prisma.adminUser.findMany({
    where: {
      email: {
        in: ['admin@hirepurchase.com', 'sales@hirepurchase.com'],
      },
    },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  for (const admin of defaultAdmins) {
    byEmail[admin.email] = admin;
  }

  return byEmail;
}

async function ensureDemoCustomers(
  usersByEmail: Record<string, { id: string }>
): Promise<Record<string, { id: string; id_uuid: string; membershipId: string; phone: string }>> {
  const customers: DemoCustomerSeed[] = [
    {
      membershipId: 'HPDEMO001',
      firstName: 'Ama',
      lastName: 'Mensah',
      phone: '0243001001',
      email: 'ama.demo@hirepurchase.com',
      address: 'East Legon, Accra',
      nationalId: 'GHA-AMA-001',
      createdByEmail: 'grace.agent@hirepurchase.com',
    },
    {
      membershipId: 'HPDEMO002',
      firstName: 'Kojo',
      lastName: 'Owusu',
      phone: '0243001002',
      email: 'kojo.demo@hirepurchase.com',
      address: 'Kasoa, Central Region',
      nationalId: 'GHA-KOJ-002',
      createdByEmail: 'grace.agent@hirepurchase.com',
    },
    {
      membershipId: 'HPDEMO003',
      firstName: 'Efua',
      lastName: 'Boateng',
      phone: '0243001003',
      email: 'efua.demo@hirepurchase.com',
      address: 'Adenta, Accra',
      nationalId: 'GHA-EFU-003',
      createdByEmail: 'grace.agent@hirepurchase.com',
    },
    {
      membershipId: 'HPDEMO004',
      firstName: 'Yaw',
      lastName: 'Asare',
      phone: '0243001004',
      email: 'yaw.demo@hirepurchase.com',
      address: 'Tema Community 6',
      nationalId: 'GHA-YAW-004',
      createdByEmail: 'grace.agent@hirepurchase.com',
    },
    {
      membershipId: 'HPDEMO005',
      firstName: 'Adwoa',
      lastName: 'Nyarko',
      phone: '0243001005',
      email: 'adwoa.demo@hirepurchase.com',
      address: 'Koforidua, Eastern Region',
      nationalId: 'GHA-ADW-005',
      createdByEmail: 'kwame.agent@hirepurchase.com',
    },
    {
      membershipId: 'HPDEMO006',
      firstName: 'Malik',
      lastName: 'Sulemana',
      phone: '0553001006',
      email: 'malik.demo@hirepurchase.com',
      address: 'Tamale, Northern Region',
      nationalId: 'GHA-MAL-006',
      createdByEmail: 'kwame.agent@hirepurchase.com',
    },
  ];

  const byMembershipId: Record<string, { id: string; id_uuid: string; membershipId: string; phone: string }> = {};

  for (const customer of customers) {
    const normalizedPhone = sanitizePhoneNumber(customer.phone);
    const passwordHash = await bcrypt.hash(normalizedPhone, 12);
    const existing = await prisma.customer.findUnique({
      where: { membershipId: customer.membershipId },
      select: { id: true, id_uuid: true, activatedAt: true },
    });

    const record = existing
      ? await prisma.customer.update({
          where: { membershipId: customer.membershipId },
          data: {
            firstName: customer.firstName,
            lastName: customer.lastName,
            phone: normalizedPhone,
            email: customer.email,
            address: customer.address,
            nationalId: customer.nationalId,
            createdById: usersByEmail[customer.createdByEmail].id,
            password: passwordHash,
            isActivated: true,
            activatedAt: existing.activatedAt || new Date(),
          },
          select: { id: true, id_uuid: true, membershipId: true, phone: true },
        })
      : await prisma.customer.create({
          data: {
            id_uuid: randomUUID(),
            membershipId: customer.membershipId,
            firstName: customer.firstName,
            lastName: customer.lastName,
            phone: normalizedPhone,
            email: customer.email,
            address: customer.address,
            nationalId: customer.nationalId,
            createdById: usersByEmail[customer.createdByEmail].id,
            password: passwordHash,
            isActivated: true,
            activatedAt: new Date(),
          },
          select: { id: true, id_uuid: true, membershipId: true, phone: true },
        });

    byMembershipId[customer.membershipId] = record;
  }

  return byMembershipId;
}

async function ensureDemoProductsAndInventory(
  categories: { mobilePhonesId: string; televisionsId: string; laptopsId: string },
  baseProducts: { samsungId: string; iphoneId: string; tvId: string }
): Promise<Record<string, { id: string; serialNumber: string }>> {
  const products = [
    {
      id: 'demo-samsung-a15',
      name: 'Samsung Galaxy A15',
      description: '128GB, device-financing portfolio model',
      basePrice: 2200,
      categoryId: categories.mobilePhonesId,
    },
    {
      id: 'demo-tecno-camon-30',
      name: 'Tecno Camon 30',
      description: '256GB, fast-selling mid-range Android phone',
      basePrice: 3600,
      categoryId: categories.mobilePhonesId,
    },
    {
      id: 'demo-lenovo-ideapad-5',
      name: 'Lenovo IdeaPad 5',
      description: '14-inch business laptop',
      basePrice: 5400,
      categoryId: categories.laptopsId,
    },
  ];

  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: {
        name: product.name,
        description: product.description,
        basePrice: product.basePrice,
        categoryId: product.categoryId,
        isActive: true,
      },
      create: product,
    });
  }

  const inventorySeeds: DemoInventorySeed[] = [
    { serialNumber: 'DEMO-S24-001', productId: baseProducts.samsungId },
    { serialNumber: 'DEMO-S24-002', productId: baseProducts.samsungId },
    { serialNumber: 'DEMO-IP15-001', productId: baseProducts.iphoneId },
    { serialNumber: 'DEMO-TV-001', productId: baseProducts.tvId },
    { serialNumber: 'DEMO-TV-002', productId: baseProducts.tvId },
    { serialNumber: 'DEMO-A15-001', productId: 'demo-samsung-a15' },
    { serialNumber: 'DEMO-TECNO-001', productId: 'demo-tecno-camon-30' },
    { serialNumber: 'DEMO-LENOVO-001', productId: 'demo-lenovo-ideapad-5' },
  ];

  await prisma.inventoryItem.updateMany({
    where: {
      serialNumber: {
        in: inventorySeeds.map((item) => item.serialNumber),
      },
    },
    data: {
      contractId: null,
      status: 'AVAILABLE',
      registeredUnder: null,
      lockStatus: 'UNLOCKED',
    },
  });

  for (const item of inventorySeeds) {
    await prisma.inventoryItem.upsert({
      where: { serialNumber: item.serialNumber },
      update: {
        productId: item.productId,
        status: 'AVAILABLE',
        contractId: null,
        registeredUnder: null,
        lockStatus: 'UNLOCKED',
      },
      create: {
        serialNumber: item.serialNumber,
        productId: item.productId,
        status: 'AVAILABLE',
        lockStatus: 'UNLOCKED',
      },
    });
  }

  const inventoryItems = await prisma.inventoryItem.findMany({
    where: {
      serialNumber: {
        in: inventorySeeds.map((item) => item.serialNumber),
      },
    },
    select: { id: true, serialNumber: true },
  });

  return inventoryItems.reduce<Record<string, { id: string; serialNumber: string }>>((acc, item) => {
    acc[item.serialNumber] = item;
    return acc;
  }, {});
}

async function ensurePreapprovals(
  customersByMembershipId: Record<string, { id_uuid: string }>
): Promise<Record<string, { id: string; clientReferenceId: string }>> {
  const today = startOfDay(new Date());
  const createdYesterday = withTime(addDays(today, -1), 10, 15);
  const createdTwoMonthsAgo = withTime(addMonths(today, -2), 9, 10);
  const createdOneMonthAgo = withTime(addMonths(today, -1), 11, 20);

  const preapprovals: DemoPreapprovalSeed[] = [
    {
      clientReferenceId: 'DEMO-PRE-AMA-001',
      customerMembershipId: 'HPDEMO001',
      customerMsisdn: '0243001001',
      channel: 'mtn-gh-direct-debit',
      status: 'APPROVED',
      verificationType: 'USSD',
      otpPrefix: '911',
      hubtelPreapprovalId: 'HPA-DEMO-AMA-001',
      approvedAt: addHours(createdTwoMonthsAgo, 4),
      expiresAt: addDays(createdTwoMonthsAgo, 7),
      createdAt: createdTwoMonthsAgo,
      metadata: {
        note: 'Approved direct debit mandate for customer portal demo.',
      },
    },
    {
      clientReferenceId: 'DEMO-PRE-EFUA-001',
      customerMembershipId: 'HPDEMO003',
      customerMsisdn: '0243001003',
      channel: 'mtn-gh-direct-debit',
      status: 'PENDING',
      verificationType: 'USSD',
      otpPrefix: '527',
      expiresAt: addDays(createdYesterday, 3),
      createdAt: createdYesterday,
      metadata: {
        note: 'Pending mandate used to show approval queue and report filters.',
      },
    },
    {
      clientReferenceId: 'DEMO-PRE-MALIK-001',
      customerMembershipId: 'HPDEMO006',
      customerMsisdn: '0553001006',
      channel: 'vodafone-gh-direct-debit',
      status: 'FAILED',
      verificationType: 'OTP',
      otpPrefix: '301',
      hubtelPreapprovalId: null,
      expiresAt: addDays(createdOneMonthAgo, 2),
      createdAt: createdOneMonthAgo,
      metadata: {
        reason: 'Customer abandoned mandate authorization.',
      },
    },
  ];

  const byClientReferenceId: Record<string, { id: string; clientReferenceId: string }> = {};

  for (const preapproval of preapprovals) {
    const record = await prisma.hubtelPreapproval.upsert({
      where: { clientReferenceId: preapproval.clientReferenceId },
      update: {
        customerId_uuid: customersByMembershipId[preapproval.customerMembershipId].id_uuid,
        customerMsisdn: sanitizePhoneNumber(preapproval.customerMsisdn),
        channel: preapproval.channel,
        hubtelPreapprovalId: preapproval.hubtelPreapprovalId || null,
        verificationType: preapproval.verificationType,
        otpPrefix: preapproval.otpPrefix || null,
        status: preapproval.status,
        approvedAt: preapproval.approvedAt || null,
        expiresAt: preapproval.expiresAt || null,
        metadata: preapproval.metadata ? toJson(preapproval.metadata) : null,
        createdAt: preapproval.createdAt,
      },
      create: {
        customerId_uuid: customersByMembershipId[preapproval.customerMembershipId].id_uuid,
        customerMsisdn: sanitizePhoneNumber(preapproval.customerMsisdn),
        channel: preapproval.channel,
        clientReferenceId: preapproval.clientReferenceId,
        hubtelPreapprovalId: preapproval.hubtelPreapprovalId || null,
        verificationType: preapproval.verificationType,
        otpPrefix: preapproval.otpPrefix || null,
        status: preapproval.status,
        approvedAt: preapproval.approvedAt || null,
        expiresAt: preapproval.expiresAt || null,
        metadata: preapproval.metadata ? toJson(preapproval.metadata) : null,
        createdAt: preapproval.createdAt,
      },
      select: { id: true, clientReferenceId: true },
    });

    byClientReferenceId[preapproval.clientReferenceId] = record;
  }

  return byClientReferenceId;
}

async function resetContractArtifacts(contractNumber: string): Promise<void> {
  const existing = await prismaAny.hirePurchaseContract.findUnique({
    where: { contractNumber },
    include: {
      payments: {
        select: { id: true },
      },
      managedDevice: {
        select: { id: true },
      },
    },
  });

  if (!existing) {
    return;
  }

  const paymentIds = existing.payments.map((payment) => payment.id);
  if (paymentIds.length > 0) {
    await prisma.paymentRetry.deleteMany({
      where: {
        paymentId: {
          in: paymentIds,
        },
      },
    });
  }

  if (existing.managedDevice) {
    await prismaAny.managedDeviceCommand.deleteMany({
      where: { managedDeviceId: existing.managedDevice.id },
    });
    await prismaAny.managedDevice.delete({
      where: { id: existing.managedDevice.id },
    });
  }

  await prisma.auditLog.deleteMany({
    where: {
      entity: 'HirePurchaseContract',
      entityId: existing.id,
      action: {
        in: [...APPROVAL_AUDIT_ACTIONS],
      },
    },
  });
  await prisma.notificationLog.deleteMany({ where: { contractId: existing.id } });
  await prisma.penalty.deleteMany({ where: { contractId: existing.id } });
  await prisma.paymentTransaction.deleteMany({ where: { contractId: existing.id } });
  await prisma.installmentSchedule.deleteMany({ where: { contractId: existing.id } });
  await prisma.inventoryItem.updateMany({
    where: { contractId: existing.id },
    data: {
      contractId: null,
      status: 'AVAILABLE',
      registeredUnder: null,
      lockStatus: 'UNLOCKED',
    },
  });
}

async function upsertContractScenario(
  scenario: DemoContractSeed,
  customersByMembershipId: Record<string, { id: string; id_uuid: string; phone: string }>,
  inventoryBySerial: Record<string, { id: string }>,
  usersByEmail: Record<string, { id: string; firstName: string; lastName: string }>,
  preapprovalsByClientReferenceId: Record<string, { id: string }>,
  today: Date
): Promise<void> {
  await resetContractArtifacts(scenario.contractNumber);

  const customer = customersByMembershipId[scenario.customerMembershipId];
  const inventoryItem = inventoryBySerial[scenario.inventorySerialNumber];
  const createdBy = usersByEmail[scenario.createdByEmail];
  const approvedBy = scenario.approvedByEmail ? usersByEmail[scenario.approvedByEmail] : null;
  const preapproval = scenario.hubtelPreapprovalClientReferenceId
    ? preapprovalsByClientReferenceId[scenario.hubtelPreapprovalClientReferenceId]
    : null;

  const financeAmount = roundCurrency(scenario.totalPrice - scenario.depositAmount);
  const successfulPayments = scenario.successfulPaymentAllocations.filter((payment) => payment.status === 'SUCCESS');
  const successfulPaymentsTotal = roundCurrency(
    successfulPayments.reduce((sum, payment) => sum + payment.amount, 0)
  );
  const totalPaid = roundCurrency(scenario.depositAmount + successfulPaymentsTotal);
  const outstandingBalance = roundCurrency(Math.max(0, financeAmount - successfulPaymentsTotal));
  const installments = buildInstallments(
    financeAmount,
    scenario.paymentFrequency,
    scenario.totalInstallments,
    scenario.startDate,
    successfulPaymentsTotal,
    scenario.status,
    today
  );
  const payments = [
    ...scenario.successfulPaymentAllocations,
    ...(scenario.additionalPayments || []),
  ];

  const contract = await prisma.hirePurchaseContract.upsert({
    where: { contractNumber: scenario.contractNumber },
    update: {
      customerId_uuid: customer.id_uuid,
      totalPrice: scenario.totalPrice,
      depositAmount: scenario.depositAmount,
      financeAmount,
      installmentAmount: installments[0]?.amount || 0,
      paymentFrequency: scenario.paymentFrequency,
      totalInstallments: scenario.totalInstallments,
      gracePeriodDays: scenario.gracePeriodDays,
      penaltyPercentage: scenario.penaltyPercentage,
      startDate: scenario.startDate,
      endDate: calculateEndDate(scenario.startDate, scenario.paymentFrequency, scenario.totalInstallments),
      status: scenario.status,
      totalPaid,
      outstandingBalance,
      ownershipTransferred: Boolean(scenario.ownershipTransferred),
      paymentMethod: scenario.paymentMethod,
      mobileMoneyNetwork: scenario.mobileMoneyNetwork || null,
      mobileMoneyNumber: scenario.mobileMoneyNumber || null,
      hubtelPreapprovalId: preapproval?.id || null,
      approvedById: approvedBy?.id || null,
      approvedAt: scenario.approvedAt || null,
      rejectionReason: scenario.rejectionReason || null,
      createdById: createdBy.id,
      createdAt: scenario.createdAt,
    },
    create: {
      contractNumber: scenario.contractNumber,
      customerId_uuid: customer.id_uuid,
      totalPrice: scenario.totalPrice,
      depositAmount: scenario.depositAmount,
      financeAmount,
      installmentAmount: installments[0]?.amount || 0,
      paymentFrequency: scenario.paymentFrequency,
      totalInstallments: scenario.totalInstallments,
      gracePeriodDays: scenario.gracePeriodDays,
      penaltyPercentage: scenario.penaltyPercentage,
      startDate: scenario.startDate,
      endDate: calculateEndDate(scenario.startDate, scenario.paymentFrequency, scenario.totalInstallments),
      status: scenario.status,
      totalPaid,
      outstandingBalance,
      ownershipTransferred: Boolean(scenario.ownershipTransferred),
      paymentMethod: scenario.paymentMethod,
      mobileMoneyNetwork: scenario.mobileMoneyNetwork || null,
      mobileMoneyNumber: scenario.mobileMoneyNumber || null,
      hubtelPreapprovalId: preapproval?.id || null,
      approvedById: approvedBy?.id || null,
      approvedAt: scenario.approvedAt || null,
      rejectionReason: scenario.rejectionReason || null,
      createdById: createdBy.id,
      createdAt: scenario.createdAt,
    },
    select: { id: true, contractNumber: true },
  });

  await prisma.installmentSchedule.createMany({
    data: installments.map((installment) => ({
      contractId: contract.id,
      installmentNo: installment.installmentNo,
      dueDate: installment.dueDate,
      amount: installment.amount,
      paidAmount: installment.paidAmount,
      status: installment.status,
      paidAt: installment.paidAt,
    })),
  });

  if (payments.length > 0) {
    await prisma.paymentTransaction.createMany({
      data: payments.map((payment) => ({
        transactionRef: payment.transactionRef,
        contractId: contract.id,
        customerId_uuid: customer.id_uuid,
        amount: payment.amount,
        paymentMethod: payment.paymentMethod,
        mobileMoneyProvider: payment.mobileMoneyProvider || null,
        mobileMoneyNumber: payment.mobileMoneyNumber || null,
        status: payment.status,
        externalRef: payment.externalRef || null,
        paymentDate: payment.paymentDate || null,
        metadata: payment.metadata ? toJson(payment.metadata) : null,
        failureReason: payment.failureReason || null,
        createdAt: payment.createdAt,
        isAutoRetryEnabled: payment.status !== 'FAILED',
        maxRetries: 3,
      })),
    });
  }

  await prisma.inventoryItem.update({
    where: { id: inventoryItem.id },
    data: {
      contractId: contract.id,
      status: scenario.status === 'PENDING_APPROVAL' || scenario.status === 'REVISION_REQUESTED' ? 'RESERVED' : 'SOLD',
      registeredUnder: `${scenario.customerMembershipId} ${scenario.contractNumber}`,
      lockStatus: scenario.managedDevice?.actualState === 'LOCKED' ? 'LOCKED' : 'UNLOCKED',
    },
  });

  for (const auditLog of scenario.auditLogs) {
    const actor = usersByEmail[auditLog.actorEmail];
    await prisma.auditLog.create({
      data: {
        userId: actor.id,
        action: auditLog.action,
        entity: 'HirePurchaseContract',
        entityId: contract.id,
        oldValues: auditLog.oldValues ? toJson(auditLog.oldValues) : null,
        newValues: auditLog.newValues ? toJson(auditLog.newValues) : null,
        ipAddress: '127.0.0.1',
        userAgent: 'demo-seed',
        createdAt: auditLog.createdAt,
      },
    });
  }

  if (!scenario.managedDevice) {
    return;
  }

  const device = await prismaAny.managedDevice.create({
    data: {
      contractId: contract.id,
      inventoryItemId: inventoryItem.id,
      customerId_uuid: customer.id_uuid,
      provider: 'KNOX_GUARD',
      deviceUid: scenario.managedDevice.deviceUid,
      deviceUidType: scenario.managedDevice.deviceUidType,
      approveId: scenario.managedDevice.approveId,
      knoxObjectId: scenario.managedDevice.knoxObjectId,
      knoxTenantDomain: scenario.managedDevice.knoxTenantDomain,
      knoxStatus: scenario.managedDevice.knoxStatus,
      enrollmentStatus: scenario.managedDevice.enrollmentStatus,
      desiredState: scenario.managedDevice.desiredState,
      actualState: scenario.managedDevice.actualState,
      isActive: true,
      lastLockedAt: scenario.managedDevice.lastLockedAt || null,
      lastUnlockedAt: scenario.managedDevice.lastUnlockedAt || null,
      lastEvaluatedAt: scenario.managedDevice.lastEvaluatedAt || null,
      lastSyncedAt: scenario.managedDevice.lastSyncedAt || null,
      metadata: toJson({
        customerExperience: {
          disclosureAccepted: true,
          disclosureAcceptedAt: scenario.createdAt.toISOString(),
          disclosureVersion: 'demo-v1',
          supportPhone: DEMO_SUPPORT_PHONE,
          supportMessage: 'Call support or pay from the customer portal to restore access.',
          warningMessage: DEMO_WARNING_MESSAGE,
          paymentAppLabel: 'Customer Portal',
          paymentUssd: '*170#',
          refreshActionLabel: 'Refresh account status',
        },
      }),
    },
    select: { id: true },
  });

  if (scenario.managedDevice.commands.length > 0) {
    await prismaAny.managedDeviceCommand.createMany({
      data: scenario.managedDevice.commands.map((command, index) => ({
        managedDeviceId: device.id,
        type: command.type,
        status: command.status,
        idempotencyKey: `${scenario.contractNumber}-${command.type}-${index + 1}`,
        payload: command.payload ? toJson(command.payload) : null,
        response: command.response ? toJson(command.response) : null,
        attempts: command.status === 'SUCCEEDED' ? 1 : 0,
        lastAttemptAt: command.status === 'SUCCEEDED' ? command.createdAt : null,
        completedAt: command.completedAt || null,
        errorMessage: command.errorMessage || null,
        createdAt: command.createdAt,
      })),
    });
  }
}

function buildDemoScenarios(): {
  contracts: DemoContractSeed[];
} {
  const today = startOfDay(new Date());
  const futureAnchorDay = Math.min(today.getDate() + 7, 28);
  const amaStartDate = withTime(new Date(today.getFullYear(), today.getMonth() - 2, futureAnchorDay), 9, 0);
  const kojoStartDate = withTime(addWeeks(today, -10), 9, 0);
  const efuaStartDate = withTime(addDays(today, 5), 10, 0);
  const yawStartDate = withTime(addDays(today, 7), 11, 0);
  const adwoaStartDate = withTime(new Date(today.getFullYear(), today.getMonth() - 6, 15), 9, 0);
  const malikStartDate = withTime(today, 10, 0);
  const efuaHistoryStartDate = withTime(new Date(today.getFullYear() - 1, today.getMonth(), 10), 9, 0);

  const contracts: DemoContractSeed[] = [
    {
      contractNumber: 'CONDEMO001',
      customerMembershipId: 'HPDEMO001',
      inventorySerialNumber: 'DEMO-S24-001',
      createdByEmail: 'grace.agent@hirepurchase.com',
      approvedByEmail: 'sales@hirepurchase.com',
      totalPrice: 6500,
      depositAmount: 1500,
      paymentFrequency: 'MONTHLY',
      totalInstallments: 8,
      gracePeriodDays: 3,
      penaltyPercentage: 5,
      startDate: amaStartDate,
      createdAt: addDays(amaStartDate, -2),
      approvedAt: addDays(amaStartDate, -1),
      status: 'ACTIVE',
      paymentMethod: 'HUBTEL_DIRECT_DEBIT',
      mobileMoneyNetwork: 'MTN',
      mobileMoneyNumber: '0243001001',
      hubtelPreapprovalClientReferenceId: 'DEMO-PRE-AMA-001',
      successfulPaymentAllocations: [
        {
          transactionRef: 'TXN-DEMO-AMA-001',
          amount: 625,
          status: 'SUCCESS',
          paymentMethod: 'HUBTEL_DIRECT_DEBIT',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001001',
          externalRef: 'HUBTEL-DEMO-AMA-001',
          paymentDate: amaStartDate,
          createdAt: addHours(amaStartDate, 1),
          metadata: { source: 'demo-seed' },
        },
        {
          transactionRef: 'TXN-DEMO-AMA-002',
          amount: 625,
          status: 'SUCCESS',
          paymentMethod: 'HUBTEL_DIRECT_DEBIT',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001001',
          externalRef: 'HUBTEL-DEMO-AMA-002',
          paymentDate: addMonths(amaStartDate, 1),
          createdAt: addHours(addMonths(amaStartDate, 1), 1),
          metadata: { source: 'demo-seed' },
        },
      ],
      additionalPayments: [
        {
          transactionRef: 'TXN-DEMO-AMA-003',
          amount: 625,
          status: 'PENDING',
          paymentMethod: 'HUBTEL_DIRECT_DEBIT',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001001',
          externalRef: 'HUBTEL-DEMO-AMA-003',
          createdAt: addDays(today, -1),
          metadata: { source: 'demo-seed', note: 'Used for reconciliation preview.' },
        },
      ],
      auditLogs: [
        {
          action: 'CREATE_CONTRACT',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addDays(amaStartDate, -2),
          newValues: { contractNumber: 'CONDEMO001', status: 'DRAFT' },
        },
        {
          action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addMinutes(addDays(amaStartDate, -2), 20),
          oldValues: { status: 'DRAFT' },
          newValues: { status: 'PENDING_APPROVAL' },
        },
        {
          action: 'ASSIGN_CONTRACT_APPROVER',
          actorEmail: 'sales@hirepurchase.com',
          createdAt: addHours(addDays(amaStartDate, -2), 3),
          newValues: {
            assignedApproverId: 'sales@hirepurchase.com',
            assignedApproverName: 'Sales Admin',
          },
        },
        {
          action: 'APPROVE_CONTRACT',
          actorEmail: 'sales@hirepurchase.com',
          createdAt: addDays(amaStartDate, -1),
          oldValues: { status: 'PENDING_APPROVAL' },
          newValues: { status: 'ACTIVE' },
        },
      ],
      managedDevice: {
        deviceUid: 'DEMO-S24-001',
        deviceUidType: 'SERIAL_NUMBER',
        approveId: 'DEMO-APPROVE-AMA-001',
        knoxObjectId: 'demo-knox-ama-001',
        knoxTenantDomain: 'DEVICE_FINANCING',
        knoxStatus: 'UNLOCKED',
        enrollmentStatus: 'ACTIVE',
        desiredState: 'UNLOCKED',
        actualState: 'UNLOCKED',
        lastUnlockedAt: addMonths(amaStartDate, 1),
        lastEvaluatedAt: addHours(today, 8),
        lastSyncedAt: addHours(today, 8),
        commands: [
          {
            type: 'APPROVE_DEVICE',
            status: 'SUCCEEDED',
            createdAt: addDays(amaStartDate, -1),
            completedAt: addHours(addDays(amaStartDate, -1), 1),
            payload: { approveId: 'DEMO-APPROVE-AMA-001' },
            response: { result: 'APPROVED', objectId: 'demo-knox-ama-001' },
          },
          {
            type: 'UNLOCK_DEVICE',
            status: 'SUCCEEDED',
            createdAt: addMonths(amaStartDate, 1),
            completedAt: addHours(addMonths(amaStartDate, 1), 1),
            payload: { objectId: 'demo-knox-ama-001' },
            response: { result: 'UNLOCKED' },
          },
        ],
      },
    },
    {
      contractNumber: 'CONDEMO002',
      customerMembershipId: 'HPDEMO002',
      inventorySerialNumber: 'DEMO-A15-001',
      createdByEmail: 'grace.agent@hirepurchase.com',
      approvedByEmail: 'sales@hirepurchase.com',
      totalPrice: 2200,
      depositAmount: 400,
      paymentFrequency: 'WEEKLY',
      totalInstallments: 12,
      gracePeriodDays: 1,
      penaltyPercentage: 5,
      startDate: kojoStartDate,
      createdAt: addDays(kojoStartDate, -4),
      approvedAt: addDays(kojoStartDate, -3),
      status: 'ACTIVE',
      paymentMethod: 'MANUAL',
      mobileMoneyNetwork: 'MTN',
      mobileMoneyNumber: '0243001002',
      successfulPaymentAllocations: [
        {
          transactionRef: 'TXN-DEMO-KOJO-001',
          amount: 150,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001002',
          externalRef: 'CASH-KOJO-001',
          paymentDate: addWeeks(kojoStartDate, 1),
          createdAt: addHours(addWeeks(kojoStartDate, 1), 2),
        },
        {
          transactionRef: 'TXN-DEMO-KOJO-002',
          amount: 150,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001002',
          externalRef: 'CASH-KOJO-002',
          paymentDate: addWeeks(kojoStartDate, 2),
          createdAt: addHours(addWeeks(kojoStartDate, 2), 2),
        },
        {
          transactionRef: 'TXN-DEMO-KOJO-003',
          amount: 150,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001002',
          externalRef: 'CASH-KOJO-003',
          paymentDate: addWeeks(kojoStartDate, 4),
          createdAt: addHours(addWeeks(kojoStartDate, 4), 2),
        },
      ],
      additionalPayments: [
        {
          transactionRef: 'TXN-DEMO-KOJO-004',
          amount: 150,
          status: 'FAILED',
          paymentMethod: 'HUBTEL_REGULAR',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001002',
          externalRef: 'HUBTEL-KOJO-004',
          createdAt: addDays(today, -6),
          failureReason: 'Insufficient funds',
          metadata: { responseCode: '1001' },
        },
        {
          transactionRef: 'TXN-DEMO-KOJO-005',
          amount: 150,
          status: 'PENDING',
          paymentMethod: 'HUBTEL_REGULAR',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001002',
          externalRef: 'HUBTEL-KOJO-005',
          createdAt: addDays(today, -2),
          metadata: { note: 'Pending mobile money prompt.' },
        },
      ],
      auditLogs: [
        {
          action: 'CREATE_CONTRACT',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addDays(kojoStartDate, -4),
          newValues: { contractNumber: 'CONDEMO002', status: 'DRAFT' },
        },
        {
          action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addMinutes(addDays(kojoStartDate, -4), 15),
          oldValues: { status: 'DRAFT' },
          newValues: { status: 'PENDING_APPROVAL' },
        },
        {
          action: 'APPROVE_CONTRACT',
          actorEmail: 'sales@hirepurchase.com',
          createdAt: addDays(kojoStartDate, -3),
          oldValues: { status: 'PENDING_APPROVAL' },
          newValues: { status: 'ACTIVE' },
        },
      ],
      managedDevice: {
        deviceUid: 'DEMO-A15-001',
        deviceUidType: 'SERIAL_NUMBER',
        approveId: 'DEMO-APPROVE-KOJO-001',
        knoxObjectId: 'demo-knox-kojo-001',
        knoxTenantDomain: 'DEVICE_FINANCING',
        knoxStatus: 'LOCKED',
        enrollmentStatus: 'ACTIVE',
        desiredState: 'LOCKED',
        actualState: 'LOCKED',
        lastLockedAt: addDays(today, -5),
        lastEvaluatedAt: addHours(today, 8),
        lastSyncedAt: addHours(today, 8),
        commands: [
          {
            type: 'APPROVE_DEVICE',
            status: 'SUCCEEDED',
            createdAt: addDays(kojoStartDate, -3),
            completedAt: addHours(addDays(kojoStartDate, -3), 1),
            payload: { approveId: 'DEMO-APPROVE-KOJO-001' },
            response: { result: 'APPROVED', objectId: 'demo-knox-kojo-001' },
          },
          {
            type: 'LOCK_DEVICE',
            status: 'SUCCEEDED',
            createdAt: addDays(today, -5),
            completedAt: addHours(addDays(today, -5), 1),
            payload: { objectId: 'demo-knox-kojo-001', reason: 'Overdue account' },
            response: { result: 'LOCKED' },
          },
        ],
      },
    },
    {
      contractNumber: 'CONDEMO003',
      customerMembershipId: 'HPDEMO003',
      inventorySerialNumber: 'DEMO-IP15-001',
      createdByEmail: 'grace.agent@hirepurchase.com',
      totalPrice: 8500,
      depositAmount: 700,
      paymentFrequency: 'MONTHLY',
      totalInstallments: 18,
      gracePeriodDays: 3,
      penaltyPercentage: 7,
      startDate: efuaStartDate,
      createdAt: addDays(today, -2),
      status: 'PENDING_APPROVAL',
      paymentMethod: 'HUBTEL_DIRECT_DEBIT',
      mobileMoneyNetwork: 'MTN',
      mobileMoneyNumber: '0243001003',
      hubtelPreapprovalClientReferenceId: 'DEMO-PRE-EFUA-001',
      successfulPaymentAllocations: [],
      auditLogs: [
        {
          action: 'CREATE_CONTRACT',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addDays(today, -2),
          newValues: { contractNumber: 'CONDEMO003', status: 'DRAFT' },
        },
        {
          action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addMinutes(addDays(today, -2), 20),
          oldValues: { status: 'DRAFT' },
          newValues: { status: 'PENDING_APPROVAL' },
        },
        {
          action: 'ASSIGN_CONTRACT_APPROVER',
          actorEmail: 'ops.demo@hirepurchase.com',
          createdAt: addHours(addDays(today, -2), 4),
          newValues: {
            assignedApproverId: 'ops.demo@hirepurchase.com',
            assignedApproverName: 'Operations Lead',
          },
        },
      ],
    },
    {
      contractNumber: 'CONDEMO004',
      customerMembershipId: 'HPDEMO004',
      inventorySerialNumber: 'DEMO-TECNO-001',
      createdByEmail: 'grace.agent@hirepurchase.com',
      totalPrice: 3600,
      depositAmount: 600,
      paymentFrequency: 'MONTHLY',
      totalInstallments: 10,
      gracePeriodDays: 2,
      penaltyPercentage: 5,
      startDate: yawStartDate,
      createdAt: addDays(today, -4),
      status: 'REVISION_REQUESTED',
      paymentMethod: 'MANUAL',
      mobileMoneyNetwork: 'MTN',
      mobileMoneyNumber: '0243001004',
      rejectionReason: 'Deposit too low for the selected tenor.',
      successfulPaymentAllocations: [],
      auditLogs: [
        {
          action: 'CREATE_CONTRACT',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addDays(today, -4),
          newValues: { contractNumber: 'CONDEMO004', status: 'DRAFT' },
        },
        {
          action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addMinutes(addDays(today, -4), 25),
          oldValues: { status: 'DRAFT' },
          newValues: { status: 'PENDING_APPROVAL' },
        },
        {
          action: 'REQUEST_CONTRACT_REVISION',
          actorEmail: 'ops.demo@hirepurchase.com',
          createdAt: addDays(today, -3),
          oldValues: { status: 'PENDING_APPROVAL' },
          newValues: {
            status: 'REVISION_REQUESTED',
            revisionReason: 'Increase the deposit or shorten the tenor before resubmitting.',
          },
        },
      ],
    },
    {
      contractNumber: 'CONDEMO005',
      customerMembershipId: 'HPDEMO005',
      inventorySerialNumber: 'DEMO-TV-001',
      createdByEmail: 'kwame.agent@hirepurchase.com',
      approvedByEmail: 'sales@hirepurchase.com',
      totalPrice: 4500,
      depositAmount: 1500,
      paymentFrequency: 'MONTHLY',
      totalInstallments: 6,
      gracePeriodDays: 2,
      penaltyPercentage: 4,
      startDate: adwoaStartDate,
      createdAt: addDays(adwoaStartDate, -3),
      approvedAt: addDays(adwoaStartDate, -2),
      status: 'COMPLETED',
      paymentMethod: 'MANUAL',
      mobileMoneyNetwork: 'MTN',
      mobileMoneyNumber: '0243001005',
      ownershipTransferred: true,
      successfulPaymentAllocations: [
        {
          transactionRef: 'TXN-DEMO-ADWOA-001',
          amount: 500,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001005',
          externalRef: 'CASH-ADWOA-001',
          paymentDate: adwoaStartDate,
          createdAt: addHours(adwoaStartDate, 1),
        },
        {
          transactionRef: 'TXN-DEMO-ADWOA-002',
          amount: 500,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001005',
          externalRef: 'CASH-ADWOA-002',
          paymentDate: addMonths(adwoaStartDate, 1),
          createdAt: addHours(addMonths(adwoaStartDate, 1), 1),
        },
        {
          transactionRef: 'TXN-DEMO-ADWOA-003',
          amount: 500,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001005',
          externalRef: 'CASH-ADWOA-003',
          paymentDate: addMonths(adwoaStartDate, 2),
          createdAt: addHours(addMonths(adwoaStartDate, 2), 1),
        },
        {
          transactionRef: 'TXN-DEMO-ADWOA-004',
          amount: 500,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001005',
          externalRef: 'CASH-ADWOA-004',
          paymentDate: addMonths(adwoaStartDate, 3),
          createdAt: addHours(addMonths(adwoaStartDate, 3), 1),
        },
        {
          transactionRef: 'TXN-DEMO-ADWOA-005',
          amount: 500,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001005',
          externalRef: 'CASH-ADWOA-005',
          paymentDate: addMonths(adwoaStartDate, 4),
          createdAt: addHours(addMonths(adwoaStartDate, 4), 1),
        },
        {
          transactionRef: 'TXN-DEMO-ADWOA-006',
          amount: 500,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001005',
          externalRef: 'CASH-ADWOA-006',
          paymentDate: addMonths(adwoaStartDate, 5),
          createdAt: addHours(addMonths(adwoaStartDate, 5), 1),
        },
      ],
      auditLogs: [
        {
          action: 'CREATE_CONTRACT',
          actorEmail: 'kwame.agent@hirepurchase.com',
          createdAt: addDays(adwoaStartDate, -3),
          newValues: { contractNumber: 'CONDEMO005', status: 'DRAFT' },
        },
        {
          action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
          actorEmail: 'kwame.agent@hirepurchase.com',
          createdAt: addMinutes(addDays(adwoaStartDate, -3), 25),
          oldValues: { status: 'DRAFT' },
          newValues: { status: 'PENDING_APPROVAL' },
        },
        {
          action: 'APPROVE_CONTRACT',
          actorEmail: 'sales@hirepurchase.com',
          createdAt: addDays(adwoaStartDate, -2),
          oldValues: { status: 'PENDING_APPROVAL' },
          newValues: { status: 'ACTIVE' },
        },
      ],
    },
    {
      contractNumber: 'CONDEMO006',
      customerMembershipId: 'HPDEMO006',
      inventorySerialNumber: 'DEMO-LENOVO-001',
      createdByEmail: 'kwame.agent@hirepurchase.com',
      approvedByEmail: 'sales@hirepurchase.com',
      totalPrice: 5400,
      depositAmount: 1400,
      paymentFrequency: 'MONTHLY',
      totalInstallments: 10,
      gracePeriodDays: 2,
      penaltyPercentage: 4,
      startDate: malikStartDate,
      createdAt: addDays(today, -2),
      approvedAt: addDays(today, -1),
      status: 'ACTIVE',
      paymentMethod: 'HUBTEL_REGULAR',
      mobileMoneyNetwork: 'TELECEL',
      mobileMoneyNumber: '0553001006',
      successfulPaymentAllocations: [
        {
          transactionRef: 'TXN-DEMO-MALIK-001',
          amount: 400,
          status: 'SUCCESS',
          paymentMethod: 'HUBTEL_REGULAR',
          mobileMoneyProvider: 'TELECEL',
          mobileMoneyNumber: '0553001006',
          externalRef: 'HUBTEL-DEMO-MALIK-001',
          paymentDate: withTime(today, 9, 30),
          createdAt: withTime(today, 9, 45),
          metadata: { source: 'daily-payments-banner' },
        },
      ],
      auditLogs: [
        {
          action: 'CREATE_CONTRACT',
          actorEmail: 'kwame.agent@hirepurchase.com',
          createdAt: addDays(today, -2),
          newValues: { contractNumber: 'CONDEMO006', status: 'DRAFT' },
        },
        {
          action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
          actorEmail: 'kwame.agent@hirepurchase.com',
          createdAt: addMinutes(addDays(today, -2), 15),
          oldValues: { status: 'DRAFT' },
          newValues: { status: 'PENDING_APPROVAL' },
        },
        {
          action: 'APPROVE_CONTRACT',
          actorEmail: 'sales@hirepurchase.com',
          createdAt: addDays(today, -1),
          oldValues: { status: 'PENDING_APPROVAL' },
          newValues: { status: 'ACTIVE' },
        },
      ],
    },
    {
      contractNumber: 'CONDEMO007',
      customerMembershipId: 'HPDEMO003',
      inventorySerialNumber: 'DEMO-TV-002',
      createdByEmail: 'grace.agent@hirepurchase.com',
      approvedByEmail: 'sales@hirepurchase.com',
      totalPrice: 2800,
      depositAmount: 500,
      paymentFrequency: 'MONTHLY',
      totalInstallments: 8,
      gracePeriodDays: 2,
      penaltyPercentage: 5,
      startDate: efuaHistoryStartDate,
      createdAt: addDays(efuaHistoryStartDate, -3),
      approvedAt: addDays(efuaHistoryStartDate, -2),
      status: 'DEFAULTED',
      paymentMethod: 'MANUAL',
      mobileMoneyNetwork: 'MTN',
      mobileMoneyNumber: '0243001003',
      successfulPaymentAllocations: [
        {
          transactionRef: 'TXN-DEMO-EFUA-001',
          amount: 287.5,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001003',
          externalRef: 'CASH-EFUA-001',
          paymentDate: efuaHistoryStartDate,
          createdAt: addHours(efuaHistoryStartDate, 1),
        },
        {
          transactionRef: 'TXN-DEMO-EFUA-002',
          amount: 287.5,
          status: 'SUCCESS',
          paymentMethod: 'MANUAL',
          mobileMoneyProvider: 'MTN',
          mobileMoneyNumber: '0243001003',
          externalRef: 'CASH-EFUA-002',
          paymentDate: addMonths(efuaHistoryStartDate, 1),
          createdAt: addHours(addMonths(efuaHistoryStartDate, 1), 1),
        },
      ],
      auditLogs: [
        {
          action: 'CREATE_CONTRACT',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addDays(efuaHistoryStartDate, -3),
          newValues: { contractNumber: 'CONDEMO007', status: 'DRAFT' },
        },
        {
          action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
          actorEmail: 'grace.agent@hirepurchase.com',
          createdAt: addMinutes(addDays(efuaHistoryStartDate, -3), 30),
          oldValues: { status: 'DRAFT' },
          newValues: { status: 'PENDING_APPROVAL' },
        },
        {
          action: 'APPROVE_CONTRACT',
          actorEmail: 'sales@hirepurchase.com',
          createdAt: addDays(efuaHistoryStartDate, -2),
          oldValues: { status: 'PENDING_APPROVAL' },
          newValues: { status: 'ACTIVE' },
        },
      ],
    },
  ];

  return { contracts };
}

async function main() {
  console.log('Preparing prospect demo dataset...');

  const today = startOfDay(new Date());
  const roles = await seedPermissionsAndRoles(prisma);
  await seedDefaultAdminUsers(prisma, roles);
  const catalog = await seedBaseCatalog(prisma);

  const usersByEmail = await ensureDemoUsers(roles.agentRole.id, roles.adminRole.id);
  const customersByMembershipId = await ensureDemoCustomers(usersByEmail);
  const inventoryBySerial = await ensureDemoProductsAndInventory(
    {
      mobilePhonesId: catalog.categories.mobilePhonesId,
      televisionsId: catalog.categories.televisionsId,
      laptopsId: catalog.categories.laptopsId,
    },
    {
      samsungId: catalog.products.samsungId,
      iphoneId: catalog.products.iphoneId,
      tvId: catalog.products.tvId,
    }
  );
  const preapprovalsByClientReferenceId = await ensurePreapprovals(customersByMembershipId);

  const { contracts } = buildDemoScenarios();
  for (const contract of contracts) {
    await upsertContractScenario(
      contract,
      customersByMembershipId,
      inventoryBySerial,
      usersByEmail,
      preapprovalsByClientReferenceId,
      today
    );
  }

  console.log('Demo dataset is ready.');
  console.log('\nDemo logins');
  console.log(`- Super admin: admin@hirepurchase.com / ${DEMO_ADMIN_PASSWORD}`);
  console.log(`- Ops admin: ops.demo@hirepurchase.com / ${DEMO_ADMIN_PASSWORD}`);
  console.log(`- Agent: grace.agent@hirepurchase.com / ${DEMO_AGENT_PASSWORD}`);
  console.log(`- Agent: kwame.agent@hirepurchase.com / ${DEMO_AGENT_PASSWORD}`);
  console.log('- Customer portal: 0243001001 / 0243001001');
  console.log('\nKey demo contracts');
  console.log('- CONDEMO001: Active Samsung contract with approved direct debit and unlocked Knox device');
  console.log('- CONDEMO002: Overdue Samsung contract with locked Knox device');
  console.log('- CONDEMO003: Pending approval, high-value iPhone application');
  console.log('- CONDEMO004: Revision requested contract');
  console.log('- CONDEMO005: Completed television contract');
  console.log('- CONDEMO006: Active laptop contract with a successful payment today');
  console.log('- CONDEMO007: Historical defaulted contract used for risk scoring');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
