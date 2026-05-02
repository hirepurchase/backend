import prisma from '../config/database';
import { sanitizePhoneNumber } from '../utils/helpers';

export type ApprovalPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ContractGuardrailAssessment {
  blockers: string[];
  warnings: string[];
  riskFlags: string[];
  priority: ApprovalPriority;
  riskScore: number;
  suggestedSlaHours: number;
  relatedOpenContracts: number;
  defaultedContracts: number;
  sameProductContracts: number;
}

export interface ApprovalAssignment {
  contractId: string;
  assignedApproverId: string | null;
  assignedApproverName: string | null;
  assignedAt: Date | null;
  assignedById: string | null;
  assignedByName: string | null;
}

export interface ApprovalHistoryItem {
  id: string;
  action: string;
  label: string;
  actorName: string;
  createdAt: Date;
  note: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
}

export interface ApprovalSnapshot extends ContractGuardrailAssessment {
  ageHours: number;
  isBreached: boolean;
  currentAssignment: ApprovalAssignment | null;
  resubmissionCount: number;
  lastSubmittedAt: Date;
}

export interface ApprovalSnapshotContractInput {
  id: string;
  customerId_uuid: string;
  totalPrice: number;
  depositAmount: number;
  totalInstallments: number;
  startDate: Date;
  paymentMethod: string | null;
  mobileMoneyNumber: string | null;
  status: string;
  createdAt: Date;
  inventoryItem?: {
    productId?: string | null;
  } | null;
}

type CustomerContractContext = {
  id: string;
  status: string;
  inventoryItem?: {
    productId: string;
  } | null;
};

type CustomerContext = {
  phone: string;
  contracts: CustomerContractContext[];
};

const OPEN_CONTRACT_STATUSES = ['ACTIVE', 'PENDING_APPROVAL', 'REVISION_REQUESTED'];
const HIGH_VALUE_THRESHOLD = Number(process.env.CONTRACT_HIGH_VALUE_THRESHOLD || 7000);
const LOW_DEPOSIT_RATIO_THRESHOLD = Number(process.env.CONTRACT_LOW_DEPOSIT_RATIO_THRESHOLD || 0.15);
const LONG_TENOR_THRESHOLD = Number(process.env.CONTRACT_LONG_TENOR_THRESHOLD || 18);
const FUTURE_START_WARNING_DAYS = Number(process.env.CONTRACT_FUTURE_START_WARNING_DAYS || 14);
const BACKDATED_START_WARNING_DAYS = Number(process.env.CONTRACT_BACKDATED_START_WARNING_DAYS || 2);

function safeJsonParse(value?: string | null): Record<string, unknown> | null {
  if (!value) return null;

  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function uniqueItems(values: string[]): string[] {
  return Array.from(new Set(values));
}

function getPriorityFromFlags(riskFlags: string[], blockers: string[]): ApprovalPriority {
  if (
    blockers.length > 0 ||
    riskFlags.includes('DEFAULT_HISTORY') ||
    riskFlags.includes('HIGH_FINANCE_AMOUNT') ||
    riskFlags.includes('REVISION_LOOP')
  ) {
    return 'HIGH';
  }

  if (
    riskFlags.includes('LOW_DEPOSIT_RATIO') ||
    riskFlags.includes('MULTIPLE_OPEN_CONTRACTS') ||
    riskFlags.includes('DIRECT_DEBIT_REVIEW') ||
    riskFlags.includes('REPEAT_PRODUCT_FINANCING')
  ) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function getRiskScore(riskFlags: string[], blockers: string[]): number {
  let score = blockers.length * 30;

  for (const flag of riskFlags) {
    if (['DEFAULT_HISTORY', 'HIGH_FINANCE_AMOUNT', 'REVISION_LOOP'].includes(flag)) {
      score += 20;
      continue;
    }

    if (['LOW_DEPOSIT_RATIO', 'MULTIPLE_OPEN_CONTRACTS', 'DIRECT_DEBIT_REVIEW', 'REPEAT_PRODUCT_FINANCING'].includes(flag)) {
      score += 12;
      continue;
    }

    score += 6;
  }

  return score;
}

function getSuggestedSlaHours(priority: ApprovalPriority): number {
  if (priority === 'HIGH') return 6;
  if (priority === 'MEDIUM') return 12;
  return 24;
}

function getHistoryLabel(action: string, newValues: Record<string, unknown> | null): string {
  if (action === 'CREATE_CONTRACT') return 'Contract created';
  if (action === 'SUBMIT_CONTRACT_FOR_APPROVAL') return 'Submitted for approval';
  if (action === 'ASSIGN_CONTRACT_APPROVER') {
    return newValues?.assignedApproverId ? 'Assigned to approver' : 'Assignment cleared';
  }
  if (action === 'EDIT_PENDING_CONTRACT') return 'Approver edited pending terms';
  if (action === 'REQUEST_CONTRACT_REVISION') return 'Revision requested';
  if (action === 'EDIT_REVISION_REQUESTED_CONTRACT') return 'Agent edited revision';
  if (action === 'RESUBMIT_CONTRACT_FOR_APPROVAL') return 'Resubmitted for approval';
  if (action === 'APPROVE_CONTRACT') return 'Contract approved';
  return action.replace(/_/g, ' ').toLowerCase();
}

function getHistoryNote(action: string, newValues: Record<string, unknown> | null): string | null {
  const noteKeys = ['revisionReason', 'note', 'reason'];
  for (const key of noteKeys) {
    const value = newValues?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  if (action === 'ASSIGN_CONTRACT_APPROVER' && typeof newValues?.assignedApproverName === 'string') {
    return `Assigned to ${newValues.assignedApproverName}`;
  }

  return null;
}

function assessContractContext(input: {
  customer: CustomerContext | null;
  inventoryProductId: string | null;
  totalPrice: number;
  depositAmount: number;
  totalInstallments?: number;
  startDate?: Date;
  paymentMethod?: string | null;
  mobileMoneyNumber?: string | null;
  excludeContractId?: string;
}): ContractGuardrailAssessment {
  const {
    customer,
    inventoryProductId,
    totalPrice,
    depositAmount,
    totalInstallments,
    startDate,
    paymentMethod,
    mobileMoneyNumber,
    excludeContractId,
  } = input;

  const blockers: string[] = [];
  const warnings: string[] = [];
  const riskFlags: string[] = [];

  if (!customer) {
    blockers.push('Selected customer could not be found.');
  }

  if (!inventoryProductId) {
    blockers.push('Selected inventory item could not be found.');
  }

  if (totalPrice <= 0) {
    blockers.push('Total price must be greater than zero.');
  }

  if (depositAmount < 0) {
    blockers.push('Deposit amount cannot be negative.');
  }

  if (depositAmount >= totalPrice && totalPrice > 0) {
    blockers.push('Deposit must be less than total price.');
  }

  const depositRatio = totalPrice > 0 ? depositAmount / totalPrice : 0;
  const financeAmount = Math.max(totalPrice - depositAmount, 0);
  if (depositRatio < LOW_DEPOSIT_RATIO_THRESHOLD) {
    riskFlags.push('LOW_DEPOSIT_RATIO');
    warnings.push(`Deposit is below ${(LOW_DEPOSIT_RATIO_THRESHOLD * 100).toFixed(0)}% of the total price.`);
  }

  if (financeAmount >= HIGH_VALUE_THRESHOLD) {
    riskFlags.push('HIGH_FINANCE_AMOUNT');
    warnings.push(`Finance amount exceeds the high-value review threshold of GHS ${HIGH_VALUE_THRESHOLD.toFixed(2)}.`);
  }

  if (typeof totalInstallments === 'number' && totalInstallments >= LONG_TENOR_THRESHOLD) {
    riskFlags.push('LONG_TENOR');
    warnings.push(`Installment plan is ${totalInstallments} periods long and should receive extra review.`);
  }

  if (paymentMethod === 'HUBTEL_DIRECT_DEBIT') {
    riskFlags.push('DIRECT_DEBIT_REVIEW');
    warnings.push('Direct debit contracts should be reviewed carefully before approval.');
  }

  const relatedContracts = customer?.contracts.filter((contract) => contract.id !== excludeContractId) || [];

  if (customer) {
    const customerPhone = sanitizePhoneNumber(customer.phone);
    const momoPhone = mobileMoneyNumber ? sanitizePhoneNumber(mobileMoneyNumber) : '';
    if (momoPhone && customerPhone !== momoPhone) {
      riskFlags.push('MOMO_PHONE_MISMATCH');
      warnings.push('The selected mobile money number does not match the customer phone number.');
    }

    const openContracts = relatedContracts.filter((contract) => OPEN_CONTRACT_STATUSES.includes(contract.status));
    const defaultedContracts = relatedContracts.filter((contract) => contract.status === 'DEFAULTED');
    const sameProductContracts = inventoryProductId
      ? relatedContracts.filter((contract) => contract.inventoryItem?.productId === inventoryProductId)
      : [];
    const sameProductOpenReview = sameProductContracts.find((contract) =>
      ['PENDING_APPROVAL', 'REVISION_REQUESTED'].includes(contract.status)
    );

    if (openContracts.length > 0) {
      riskFlags.push('MULTIPLE_OPEN_CONTRACTS');
      warnings.push(`Customer already has ${openContracts.length} open contract(s).`);
    }

    if (defaultedContracts.length > 0) {
      riskFlags.push('DEFAULT_HISTORY');
      warnings.push(`Customer has ${defaultedContracts.length} defaulted contract(s) on record.`);
    }

    if (sameProductContracts.length > 0) {
      riskFlags.push('REPEAT_PRODUCT_FINANCING');
      warnings.push('Customer has financed the same product before.');
    }

    if (sameProductOpenReview) {
      blockers.push('Customer already has the same product under review. Resolve the pending submission before creating another one.');
    }

    const revisionContracts = relatedContracts.filter((contract) => contract.status === 'REVISION_REQUESTED');
    if (revisionContracts.length > 0) {
      riskFlags.push('REVISION_LOOP');
      warnings.push('Customer currently has contract(s) waiting for revision.');
    }
  }

  if (startDate) {
    const today = new Date();
    const start = new Date(startDate);
    const diffDays = Math.floor((start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays > FUTURE_START_WARNING_DAYS) {
      riskFlags.push('FUTURE_START_DATE');
      warnings.push(`Start date is more than ${FUTURE_START_WARNING_DAYS} days in the future.`);
    }

    if (diffDays < BACKDATED_START_WARNING_DAYS * -1) {
      riskFlags.push('BACKDATED_START_DATE');
      warnings.push(`Start date is backdated by more than ${BACKDATED_START_WARNING_DAYS} days.`);
    }
  }

  const priority = getPriorityFromFlags(riskFlags, blockers);
  const riskScore = getRiskScore(riskFlags, blockers);
  const openContractCount = relatedContracts.filter((contract) => OPEN_CONTRACT_STATUSES.includes(contract.status)).length;
  const defaultedContractCount = relatedContracts.filter((contract) => contract.status === 'DEFAULTED').length;
  const sameProductContractCount = inventoryProductId
    ? relatedContracts.filter((contract) => contract.inventoryItem?.productId === inventoryProductId).length
    : 0;

  return {
    blockers: uniqueItems(blockers),
    warnings: uniqueItems(warnings),
    riskFlags: uniqueItems(riskFlags),
    priority,
    riskScore,
    suggestedSlaHours: getSuggestedSlaHours(priority),
    relatedOpenContracts: openContractCount,
    defaultedContracts: defaultedContractCount,
    sameProductContracts: sameProductContractCount,
  };
}

export async function evaluateContractSubmissionGuardrails(input: {
  customerId: string;
  inventoryItemId: string;
  totalPrice: number;
  depositAmount: number;
  totalInstallments?: number;
  startDate?: Date;
  paymentMethod?: string | null;
  mobileMoneyNumber?: string | null;
  excludeContractId?: string;
}): Promise<ContractGuardrailAssessment> {
  const {
    customerId,
    inventoryItemId,
    totalPrice,
    depositAmount,
    totalInstallments,
    startDate,
    paymentMethod,
    mobileMoneyNumber,
    excludeContractId,
  } = input;

  const [customer, inventoryItem] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        phone: true,
        contracts: {
          include: {
            inventoryItem: {
              select: { productId: true },
            },
          },
        },
      },
    }),
    prisma.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      select: {
        productId: true,
      },
    }),
  ]);

  return assessContractContext({
    customer,
    inventoryProductId: inventoryItem?.productId || null,
    totalPrice,
    depositAmount,
    totalInstallments,
    startDate,
    paymentMethod,
    mobileMoneyNumber,
    excludeContractId,
  });
}

async function getApprovalHistoryForContracts(contractIds: string[]): Promise<Record<string, ApprovalHistoryItem[]>> {
  const historyMap: Record<string, ApprovalHistoryItem[]> = {};
  for (const contractId of contractIds) {
    historyMap[contractId] = [];
  }

  if (contractIds.length === 0) {
    return historyMap;
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      entity: 'HirePurchaseContract',
      entityId: { in: contractIds },
      action: {
        in: [
          'CREATE_CONTRACT',
          'SUBMIT_CONTRACT_FOR_APPROVAL',
          'ASSIGN_CONTRACT_APPROVER',
          'EDIT_PENDING_CONTRACT',
          'REQUEST_CONTRACT_REVISION',
          'EDIT_REVISION_REQUESTED_CONTRACT',
          'RESUBMIT_CONTRACT_FOR_APPROVAL',
          'APPROVE_CONTRACT',
        ],
      },
    },
    include: {
      user: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const log of logs) {
    if (!log.entityId) {
      continue;
    }

    const oldValues = safeJsonParse(log.oldValues);
    const newValues = safeJsonParse(log.newValues);
    const actorName = log.user
      ? `${log.user.firstName} ${log.user.lastName}`.trim()
      : 'System';

    historyMap[log.entityId] = historyMap[log.entityId] || [];
    historyMap[log.entityId].push({
      id: log.id,
      action: log.action,
      label: getHistoryLabel(log.action, newValues),
      actorName,
      createdAt: log.createdAt,
      note: getHistoryNote(log.action, newValues),
      oldValues,
      newValues,
    });
  }

  return historyMap;
}

export async function getApprovalHistory(contractId: string): Promise<ApprovalHistoryItem[]> {
  const historyMap = await getApprovalHistoryForContracts([contractId]);
  return historyMap[contractId] || [];
}

export async function getLatestApprovalAssignments(contractIds: string[]): Promise<Record<string, ApprovalAssignment | null>> {
  if (contractIds.length === 0) {
    return {};
  }

  const logs = await prisma.auditLog.findMany({
    where: {
      entity: 'HirePurchaseContract',
      entityId: { in: contractIds },
      action: 'ASSIGN_CONTRACT_APPROVER',
    },
    include: {
      user: {
        select: { firstName: true, lastName: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const assignments: Record<string, ApprovalAssignment | null> = {};

  for (const log of logs) {
    if (!log.entityId || log.entityId in assignments) {
      continue;
    }

    const newValues = safeJsonParse(log.newValues);
    assignments[log.entityId] = {
      contractId: log.entityId,
      assignedApproverId: typeof newValues?.assignedApproverId === 'string' ? newValues.assignedApproverId : null,
      assignedApproverName: typeof newValues?.assignedApproverName === 'string' ? newValues.assignedApproverName : null,
      assignedAt: log.createdAt,
      assignedById: log.userId || null,
      assignedByName: log.user ? `${log.user.firstName} ${log.user.lastName}`.trim() : null,
    };
  }

  for (const contractId of contractIds) {
    if (!(contractId in assignments)) {
      assignments[contractId] = null;
    }
  }

  return assignments;
}

export async function buildApprovalSnapshots(
  contracts: ApprovalSnapshotContractInput[]
): Promise<Record<string, ApprovalSnapshot>> {
  const snapshots: Record<string, ApprovalSnapshot> = {};
  if (contracts.length === 0) {
    return snapshots;
  }

  const contractIds = contracts.map((contract) => contract.id);
  const customerIds = uniqueItems(contracts.map((contract) => contract.customerId_uuid));
  const missingProductIds = contracts
    .filter((contract) => !contract.inventoryItem?.productId)
    .map((contract) => contract.id);

  const [customers, histories, assignments, inventoryItems] = await Promise.all([
    prisma.customer.findMany({
      where: { id_uuid: { in: customerIds } },
      select: {
        id_uuid: true,
        phone: true,
        contracts: {
          include: {
            inventoryItem: {
              select: { productId: true },
            },
          },
        },
      },
    }),
    getApprovalHistoryForContracts(contractIds),
    getLatestApprovalAssignments(contractIds),
    missingProductIds.length > 0
      ? prisma.inventoryItem.findMany({
          where: { contractId: { in: missingProductIds } },
          select: { contractId: true, productId: true },
        })
      : Promise.resolve([]),
  ]);

  const customerMap = new Map(customers.map((customer) => [customer.id_uuid, customer]));
  const productIdByContractId = new Map(
    inventoryItems
      .filter((item) => item.contractId)
      .map((item) => [item.contractId as string, item.productId])
  );

  for (const contract of contracts) {
    const history = histories[contract.id] || [];
    const customer = customerMap.get(contract.customerId_uuid) || null;
    const inventoryProductId = contract.inventoryItem?.productId || productIdByContractId.get(contract.id) || null;
    const baseAssessment = assessContractContext({
      customer,
      inventoryProductId,
      totalPrice: contract.totalPrice,
      depositAmount: contract.depositAmount,
      totalInstallments: contract.totalInstallments,
      startDate: contract.startDate,
      paymentMethod: contract.paymentMethod,
      mobileMoneyNumber: contract.mobileMoneyNumber,
      excludeContractId: contract.id,
    });

    const submitEvents = history.filter((item) =>
      ['CREATE_CONTRACT', 'SUBMIT_CONTRACT_FOR_APPROVAL', 'RESUBMIT_CONTRACT_FOR_APPROVAL'].includes(item.action)
    );
    const lastSubmittedAt = submitEvents.length > 0
      ? submitEvents[submitEvents.length - 1].createdAt
      : contract.createdAt;
    const ageHours = Math.max(0, (Date.now() - lastSubmittedAt.getTime()) / (1000 * 60 * 60));
    const resubmissionCount = history.filter((item) => item.action === 'RESUBMIT_CONTRACT_FOR_APPROVAL').length;
    const riskFlags = uniqueItems([
      ...baseAssessment.riskFlags,
      ...(resubmissionCount > 0 ? ['REVISION_LOOP'] : []),
    ]);
    const warnings = uniqueItems([
      ...baseAssessment.warnings,
      ...(resubmissionCount > 0 ? [`This contract has been resubmitted ${resubmissionCount} time(s).`] : []),
    ]);
    const blockers = baseAssessment.blockers;
    const priority = getPriorityFromFlags(riskFlags, blockers);
    const suggestedSlaHours = getSuggestedSlaHours(priority);

    snapshots[contract.id] = {
      ...baseAssessment,
      warnings,
      riskFlags,
      priority,
      riskScore: getRiskScore(riskFlags, blockers),
      suggestedSlaHours,
      ageHours,
      isBreached: contract.status === 'PENDING_APPROVAL' && ageHours > suggestedSlaHours,
      currentAssignment: assignments[contract.id] || null,
      resubmissionCount,
      lastSubmittedAt,
    };
  }

  return snapshots;
}

export async function buildApprovalSnapshot(contract: ApprovalSnapshotContractInput): Promise<ApprovalSnapshot> {
  const snapshots = await buildApprovalSnapshots([contract]);
  return snapshots[contract.id];
}
