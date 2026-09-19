import prisma from '../config/database';
import { getAgentPortfolioRisk, breachesParLimit, emptyRisk } from './portfolioRiskService';

const prismaAny = prisma as any;

export interface SupervisionSettings {
  id: string;
  requireClusterAgent: boolean;
  requireCso: boolean;
  parBlockEnabled: boolean;
  parBlockThreshold: number;
  parBlockMinContracts: number;
}

const DEFAULTS = {
  requireClusterAgent: false,
  requireCso: false,
  parBlockEnabled: false,
  parBlockThreshold: 20,
  parBlockMinContracts: 10,
};

export async function getSupervisionSettings(): Promise<SupervisionSettings> {
  const existing = await prismaAny.supervisionSettings.findFirst();
  if (existing) return existing;
  return prismaAny.supervisionSettings.create({ data: { ...DEFAULTS } });
}

/**
 * Whether this agent is supervised, and by whom.
 *
 * An unsupervised agent is not a paperwork problem: nobody owns their
 * portfolio, nobody can request a temporary unlock for their customers, and
 * their contracts sit in a verification queue no officer can see. The rule
 * that stops them selling exists to make that visible at the moment it starts
 * rather than months later.
 */
export async function getAgentSupervision(agentId: string): Promise<{
  clusterAgentName: string | null;
  csoNames: string[];
}> {
  const [cluster, csos] = await Promise.all([
    prismaAny.clusterAgentAssignment.findUnique({
      where: { agentId },
      select: { clusterAgent: { select: { firstName: true, lastName: true, isActive: true } } },
    }),
    prismaAny.csoAgentAssignment.findMany({
      where: { agentId },
      select: { cso: { select: { firstName: true, lastName: true, isActive: true } } },
    }),
  ]);

  // A supervisor who can no longer log in is not supervision.
  const clusterAgentName =
    cluster?.clusterAgent && cluster.clusterAgent.isActive
      ? `${cluster.clusterAgent.firstName} ${cluster.clusterAgent.lastName}`.trim()
      : null;

  const csoNames = csos
    .filter((row: any) => row.cso?.isActive)
    .map((row: any) => `${row.cso.firstName} ${row.cso.lastName}`.trim());

  return { clusterAgentName, csoNames };
}

/**
 * The blockers an unsupervised agent should be stopped by, or an empty list
 * when the rule is off or they are covered.
 */
export async function getSupervisionBlockers(
  agentId: string,
  agentRole?: string | null
): Promise<string[]> {
  const settings = await getSupervisionSettings();
  if (!settings.requireClusterAgent && !settings.requireCso && !settings.parBlockEnabled) return [];

  const blockers: string[] = [];

  // Portfolio at risk. An agent whose own book is failing keeps adding to it
  // with every sale; the block makes collecting the priority. Applies to
  // cluster leaders too — they sell, and their book is the example their team
  // sees. It lifts by itself once collections bring PAR30 back under the limit.
  if (settings.parBlockEnabled) {
    const risk = (await getAgentPortfolioRisk([agentId])).get(agentId) ?? emptyRisk(agentId);
    if (breachesParLimit(risk, settings)) {
      blockers.push(
        `Your portfolio at risk is ${risk.par30}% — ${risk.contractsAtRisk30} customer${risk.contractsAtRisk30 === 1 ? ' is' : 's are'} more than 30 days behind, GHS ${risk.atRisk30.toFixed(2)} outstanding. ` +
          `The limit is ${settings.parBlockThreshold}%. Collect from these customers to bring it down before you create new contracts.`
      );
    }
  }

  if (!settings.requireClusterAgent && !settings.requireCso) return blockers;

  const { clusterAgentName, csoNames } = await getAgentSupervision(agentId);

  // A cluster leader supervises their own work. The tier is flat — no cluster
  // agent can be assigned to another — so without this exemption the three
  // leaders would be blocked permanently the moment the rule was switched on,
  // with nothing anyone could assign to unblock them. They are still held to
  // the officer rule below: their customers need verifying like anyone's.
  const isClusterLeader = agentRole === 'CLUSTER_AGENT';

  if (settings.requireClusterAgent && !isClusterLeader && !clusterAgentName) {
    blockers.push(
      'You are not assigned to a cluster agent, so no one supervises your portfolio. An administrator must assign you before you can create contracts.'
    );
  }
  if (settings.requireCso && csoNames.length === 0) {
    blockers.push(
      'You are not assigned to a customer service officer, so your contracts cannot be verified. An administrator must assign you before you can create contracts.'
    );
  }

  return blockers;
}
