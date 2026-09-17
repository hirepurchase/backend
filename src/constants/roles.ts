/**
 * Roles that write business: they register customers, hold inventory and create
 * contracts. Cluster agents supervise other agents but also sell, so every rule
 * written for an agent applies to them too.
 *
 * SALES_AGENT is deliberately excluded — it does not require contract approval
 * today, and folding it in here would silently change that.
 */
export const SELLING_AGENT_ROLES = ['AGENT', 'CLUSTER_AGENT'] as const;

/**
 * Roles a customer service officer can be given coverage of. Cluster agents
 * sell, so their own customers need an officer too.
 */
export const ASSIGNABLE_AGENT_ROLES = ['AGENT', 'SALES_AGENT', 'CLUSTER_AGENT'] as const;

/**
 * Roles a cluster agent can supervise — deliberately excluding CLUSTER_AGENT.
 *
 * The supervision hierarchy is flat by design. Scope resolution is a single
 * non-recursive lookup, so a cluster agent supervising another cluster agent
 * would see that person's own customers but none of their team's — a hierarchy
 * that half-works, which is worse than one that refuses. It also made mutual
 * supervision reachable: A takes B, then B takes A, since neither check sees a
 * conflict. Keeping the tier flat removes both without adding recursion.
 */
export const CLUSTER_SUPERVISABLE_ROLES = ['AGENT', 'SALES_AGENT'] as const;

export const CLUSTER_AGENT_ROLE = 'CLUSTER_AGENT';
export const CUSTOMER_SERVICE_ROLE = 'CUSTOMER_SERVICE';

export function isSellingAgentRole(role: string | undefined | null): boolean {
  return !!role && (SELLING_AGENT_ROLES as readonly string[]).includes(role);
}
