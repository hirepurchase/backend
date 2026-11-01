import prisma from '../config/database';
import { getLiveTemporaryUnlockDetails } from './temporaryUnlockService';
import { getDeviceLockIssues } from './deviceControlPolicyService';

/**
 * The rows of a collections call list: one per customer behind on an active
 * contract, plus customers whose phone is in the wrong lock state, in the
 * order they should be called — unlock windows closing first, then other
 * urgent ones, then the longest overdue.
 *
 * Used for the call queue and for sharing the morning's calls among customer
 * service (callAllocationService). `contractWhere` narrows the contracts;
 * `includeIssue` decides which lock-state problems belong on this list.
 */
export async function buildCallRows(
  contractWhere: Record<string, unknown>,
  includeIssue: (issue: { createdById: string; customerId: string }) => boolean,
): Promise<any[]> {
  const now = new Date();
  const where = { status: 'ACTIVE', ...contractWhere };

  const contracts = await prisma.hirePurchaseContract.findMany({
    where,
    include: {
      customer: { select: { id: true, id_uuid: true, firstName: true, lastName: true, membershipId: true, phone: true } },
      inventoryItem: { include: { product: { select: { name: true } } } },
      createdBy: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
      installments: { where: { status: 'OVERDUE' }, orderBy: { dueDate: 'asc' } },
      payments: {
        where: { status: 'SUCCESS' },
        orderBy: { paymentDate: 'desc' },
        take: 1,
        select: { paymentDate: true, amount: true },
      },
      contactAttempts: {
        where: { purpose: { in: ['COLLECTION', 'FOLLOW_UP'] } },
        orderBy: { contactedAt: 'desc' },
        take: 1,
        select: { contactedAt: true, outcome: true, promiseToPayDate: true },
      },
    },
  });

  // One row per customer, not per overdue installment. A customer 5 payments
  // behind is still one phone call; listing them 5 times made the queue look
  // 4x longer than the work in it.
  const byCustomer = new Map<string, any>();

  for (const contract of contracts) {
    if (contract.installments.length === 0) continue;

    const key = contract.customer.id;
    let row = byCustomer.get(key);

    if (!row) {
      row = {
        customer: {
          id: contract.customer.id,
          name: `${contract.customer.firstName} ${contract.customer.lastName}`.trim(),
          phone: contract.customer.phone,
          membershipId: contract.customer.membershipId,
        },
        agent: contract.createdBy
          ? {
              id: contract.createdBy.id,
              name: `${contract.createdBy.firstName} ${contract.createdBy.lastName}`.trim(),
              phone: contract.createdBy.phone,
              email: contract.createdBy.email,
            }
          : null,
        overdueCount: 0,
        amountOverdue: 0,
        daysOverdue: 0,
        oldestDueDate: null as Date | null,
        lastPaymentDate: null as Date | null,
        lastPaymentAmount: null as number | null,
        lastCallAt: null as Date | null,
        lastCallOutcome: null as string | null,
        promiseToPayDate: null as Date | null,
        isUrgent: false,
        urgentReason: null as string | null,
        temporaryUnlock: null as { expiresAt: Date; daysRemaining: number; arrearsAtApproval: number | null } | null,
        contracts: [] as any[],
      };
      byCustomer.set(key, row);
    }

    const contractOverdue = contract.installments.reduce(
      (sum, i) => sum + (i.amount - i.paidAmount),
      0
    );
    const oldest = contract.installments[0];
    const daysOverdue = Math.max(
      0,
      Math.floor((now.getTime() - new Date(oldest.dueDate).getTime()) / 86400000)
    );

    row.overdueCount += contract.installments.length;
    row.amountOverdue = Math.round((row.amountOverdue + contractOverdue) * 100) / 100;
    row.daysOverdue = Math.max(row.daysOverdue, daysOverdue);
    if (!row.oldestDueDate || new Date(oldest.dueDate) < new Date(row.oldestDueDate)) {
      row.oldestDueDate = oldest.dueDate;
    }

    // Most recent across all of the customer's contracts.
    const lastPayment = contract.payments[0] ?? null;
    if (lastPayment?.paymentDate && (!row.lastPaymentDate || lastPayment.paymentDate > row.lastPaymentDate)) {
      row.lastPaymentDate = lastPayment.paymentDate;
      row.lastPaymentAmount = lastPayment.amount;
    }
    const lastCall = contract.contactAttempts[0] ?? null;
    if (lastCall?.contactedAt && (!row.lastCallAt || lastCall.contactedAt > row.lastCallAt)) {
      row.lastCallAt = lastCall.contactedAt;
      row.lastCallOutcome = lastCall.outcome;
      row.promiseToPayDate = lastCall.promiseToPayDate;
    }

    row.contracts.push({
      contractId: contract.id,
      contractNumber: contract.contractNumber,
      product: contract.inventoryItem?.product?.name ?? null,
      overdueCount: contract.installments.length,
      amountOverdue: Math.round(contractOverdue * 100) / 100,
      daysOverdue,
      installments: contract.installments.map((i) => ({
        installmentId: i.id,
        installmentNo: i.installmentNo,
        dueDate: i.dueDate,
        amountOverdue: Math.round((i.amount - i.paidAmount) * 100) / 100,
      })),
    });
  }

  // Contracts with a device lock-state mismatch jump to the top of the
  // queue — a customer who's wrongly still locked despite clearing arrears,
  // or overdue enough to lock but Knox never applied it, needs a call
  // regardless of where they'd otherwise rank by days overdue.
  const contractIdToRow = new Map<string, any>();
  for (const row of byCustomer.values()) {
    for (const c of row.contracts) contractIdToRow.set(c.contractId, row);
  }

  const { categoryA, categoryB } = await getDeviceLockIssues();
  for (const issue of [...categoryA, ...categoryB]) {
    if (!includeIssue(issue)) continue;

    const existingRow = contractIdToRow.get(issue.contractId);
    if (existingRow) {
      existingRow.isUrgent = true;
      existingRow.urgentReason = issue.reason;
      continue;
    }

    // Not already in the queue (typically category B — arrears cleared, so
    // no OVERDUE installments exist to have pulled the contract in).
    let row = byCustomer.get(issue.customerId);
    if (!row) {
      row = {
        customer: { id: issue.customerId, uuid: null as string | null, name: issue.customerName, phone: issue.customerPhone, membershipId: null },
        agent: null,
        overdueCount: 0,
        amountOverdue: 0,
        daysOverdue: 0,
        oldestDueDate: null,
        lastPaymentDate: null,
        lastPaymentAmount: null,
        lastCallAt: null,
        lastCallOutcome: null,
        promiseToPayDate: null,
        isUrgent: false,
        urgentReason: null,
        temporaryUnlock: null,
        contracts: [],
      };
      byCustomer.set(issue.customerId, row);
    }
    row.isUrgent = true;
    row.urgentReason = issue.reason;
    contractIdToRow.set(issue.contractId, row);
    row.contracts.push({
      contractId: issue.contractId,
      contractNumber: issue.contractNumber,
      product: null,
      overdueCount: 0,
      amountOverdue: 0,
      daysOverdue: 0,
      installments: [],
      deviceIssue: issue.reason,
    });
  }

  // A customer inside an approved unlock window outranks everything else on
  // the list. The window has a fixed end date and the phone relocks if the
  // arrears are still there when it closes — and the agent who sold the
  // contract is barred from new business at that point. These are the calls
  // where a CSO's time actually changes the outcome.
  const liveUnlocks = await getLiveTemporaryUnlockDetails(Array.from(contractIdToRow.keys()));
  for (const [contractId, unlock] of liveUnlocks) {
    const row = contractIdToRow.get(contractId);
    if (!row) continue;
    row.isUrgent = true;
    row.temporaryUnlock = {
      expiresAt: unlock.expiresAt,
      daysRemaining: unlock.daysRemaining,
      arrearsAtApproval: unlock.arrearsAtApproval,
    };
    row.urgentReason =
      unlock.daysRemaining <= 1
        ? 'Temporary unlock ends today — phone relocks unless arrears are cleared'
        : `Temporary unlock ends in ${unlock.daysRemaining} days — phone relocks unless arrears are cleared`;
  }

  const rows = Array.from(byCustomer.values()).sort((a, b) => {
    // Unlock windows first (soonest to close first), then other urgent rows,
    // then by how far behind the customer is.
    const aWindow = a.temporaryUnlock ? 1 : 0;
    const bWindow = b.temporaryUnlock ? 1 : 0;
    if (aWindow !== bWindow) return bWindow - aWindow;
    if (aWindow && bWindow) return a.temporaryUnlock.daysRemaining - b.temporaryUnlock.daysRemaining;
    if (a.isUrgent !== b.isUrgent) return a.isUrgent ? -1 : 1;
    return b.daysOverdue - a.daysOverdue;
  });


  // Lock-state rows carry only the customer's record id; fill in the UUID.
  const missing = rows.filter((r) => !r.customer.uuid).map((r) => r.customer.id);
  if (missing.length) {
    const found = await prisma.customer.findMany({ where: { id: { in: missing } }, select: { id: true, id_uuid: true } });
    const uuidOf = new Map(found.map((c) => [c.id, c.id_uuid]));
    for (const r of rows) if (!r.customer.uuid) r.customer.uuid = uuidOf.get(r.customer.id) ?? null;
  }
  return rows;
}
