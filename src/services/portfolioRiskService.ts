import prisma from '../config/database';

const prismaAny = prisma as any;
const DAY_MS = 86_400_000;

export interface AgentPortfolioRisk {
  agentId: string;
  activeContracts: number;
  outstanding: number;
  /** Outstanding on contracts whose oldest unpaid installment is 1+ days late. */
  atRisk1: number;
  /** Outstanding on contracts whose oldest unpaid installment is 30+ days late. */
  atRisk30: number;
  contractsAtRisk30: number;
  par1: number;
  par30: number;
}

/**
 * Portfolio at risk per agent, computed one way for every consumer.
 *
 * PAR30 is the headline: the share of an agent's outstanding book sitting on
 * contracts more than thirty days behind. The older "any overdue installment"
 * measure read 39% across the book against a true PAR30 of 12%, because phones
 * lock the day after a missed payment and most of those customers pay within
 * days — it made healthy agents look like failing ones and ranked them in the
 * wrong order. PAR1 is kept alongside as the early warning a cluster leader
 * can still act on this week.
 *
 * The block on new contracts, the cluster dashboard and the admin report all
 * read this, so an agent is never told one number and judged on another.
 *
 * Contracts inside an approved temporary unlock are left out of the at-risk
 * figures: an administrator has explicitly granted that customer time, and
 * counting it against the agent would undo the approval. If the window closes
 * unpaid, the agent is barred by that mechanism instead.
 */
export async function getAgentPortfolioRisk(agentIds?: string[]): Promise<Map<string, AgentPortfolioRisk>> {
  const now = Date.now();
  const contracts = await prismaAny.hirePurchaseContract.findMany({
    where: {
      status: 'ACTIVE',
      ...(agentIds ? { createdById: { in: agentIds } } : {}),
    },
    select: {
      id: true,
      createdById: true,
      outstandingBalance: true,
      installments: {
        where: { status: { in: ['OVERDUE', 'PARTIAL', 'PENDING'] }, dueDate: { lt: new Date() } },
        select: { dueDate: true, amount: true, paidAmount: true },
      },
      temporaryUnlocks: {
        where: { status: 'APPROVED', expiresAt: { gt: new Date() } },
        select: { id: true },
      },
    },
  });

  const out = new Map<string, AgentPortfolioRisk>();
  for (const c of contracts) {
    const e =
      out.get(c.createdById) ??
      { agentId: c.createdById, activeContracts: 0, outstanding: 0, atRisk1: 0, atRisk30: 0, contractsAtRisk30: 0, par1: 0, par30: 0 };
    e.activeContracts += 1;
    e.outstanding += c.outstandingBalance;

    const underWindow = (c.temporaryUnlocks ?? []).length > 0;
    const late = c.installments.filter((i: any) => i.amount - i.paidAmount > 0.005);
    if (!underWindow && late.length > 0) {
      const oldest = Math.min(...late.map((i: any) => new Date(i.dueDate).getTime()));
      const daysLate = (now - oldest) / DAY_MS;
      if (daysLate >= 1) e.atRisk1 += c.outstandingBalance;
      if (daysLate > 30) {
        e.atRisk30 += c.outstandingBalance;
        e.contractsAtRisk30 += 1;
      }
    }
    out.set(c.createdById, e);
  }

  for (const e of out.values()) {
    e.outstanding = Math.round(e.outstanding * 100) / 100;
    e.atRisk1 = Math.round(e.atRisk1 * 100) / 100;
    e.atRisk30 = Math.round(e.atRisk30 * 100) / 100;
    e.par1 = e.outstanding > 0 ? Math.round((e.atRisk1 / e.outstanding) * 1000) / 10 : 0;
    e.par30 = e.outstanding > 0 ? Math.round((e.atRisk30 / e.outstanding) * 1000) / 10 : 0;
  }
  return out;
}

export function emptyRisk(agentId: string): AgentPortfolioRisk {
  return { agentId, activeContracts: 0, outstanding: 0, atRisk1: 0, atRisk30: 0, contractsAtRisk30: 0, par1: 0, par30: 0 };
}

/**
 * Whether this agent's PAR30 breaches the configured limit.
 *
 * Below the minimum book size the rule does not apply at all: with three
 * contracts, one customer thirty days late is 33% — a single bad sale, not a
 * pattern, and blocking a new agent for it would stop them building the book
 * that would show whether there is one.
 */
export function breachesParLimit(
  risk: AgentPortfolioRisk,
  settings: { parBlockThreshold: number; parBlockMinContracts: number }
): boolean {
  return risk.activeContracts >= settings.parBlockMinContracts && risk.par30 > settings.parBlockThreshold;
}
