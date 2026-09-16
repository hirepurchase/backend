import { allocateToPenalties } from './penaltyService';

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function isMoneyGte(a: number, b: number): boolean {
  return a >= b - 0.005;
}

interface AllocatableInstallment {
  id: string;
  amount: number;
  paidAmount: number;
  status: string;
}

/**
 * Spreads a payment across a contract in the one order that is correct:
 * overdue installments, then unpaid penalties, then installments not yet due.
 *
 * The order matters beyond bookkeeping. The device lock keys off overdue
 * installments, so settling penalties first — as this used to — meant a
 * customer who paid exactly the arrears they were quoted still had an unpaid
 * overdue installment afterwards, and stayed locked out of their own phone.
 *
 * Every payment path shares this function. Cash, manual entry and Hubtel
 * mobile money previously each carried their own copy of the loop, which is
 * precisely the kind of duplication that drifts and then only shows up as one
 * class of customer mysteriously staying locked.
 */
export async function allocatePaymentAcrossContract(params: {
  contractId: string;
  installments: AllocatableInstallment[];
  amount: number;
  tx: any;
}): Promise<{ remaining: number; penaltiesPaid: number }> {
  const { contractId, installments, amount, tx } = params;

  const overdue = installments.filter((i) => i.status === 'OVERDUE');
  const rest = installments.filter((i) => i.status !== 'OVERDUE');
  const ordered = [...overdue, ...rest];

  let remaining = roundMoney(amount);
  let penaltiesPaid = 0;

  for (const [index, installment] of ordered.entries()) {
    // Reached once the arrears are cleared and before anything is paid ahead.
    if (index === overdue.length) {
      const result = await allocateToPenalties(contractId, remaining, tx);
      remaining = result.remaining;
      penaltiesPaid = roundMoney(penaltiesPaid + result.applied);
    }
    if (remaining <= 0) break;

    const installmentRemaining = roundMoney(installment.amount - installment.paidAmount);

    if (isMoneyGte(remaining, installmentRemaining)) {
      await tx.installmentSchedule.update({
        where: { id: installment.id },
        data: { paidAmount: installment.amount, status: 'PAID', paidAt: new Date() },
      });
      remaining = roundMoney(remaining - installmentRemaining);
    } else {
      await tx.installmentSchedule.update({
        where: { id: installment.id },
        data: { paidAmount: roundMoney(installment.paidAmount + remaining), status: 'PARTIAL' },
      });
      remaining = 0;
    }
  }

  // Every installment was overdue, so the loop never reached the penalty step
  // above. Anything left over goes to penalties now.
  if (overdue.length === ordered.length && remaining > 0) {
    const result = await allocateToPenalties(contractId, remaining, tx);
    remaining = result.remaining;
    penaltiesPaid = roundMoney(penaltiesPaid + result.applied);
  }

  return { remaining, penaltiesPaid };
}
