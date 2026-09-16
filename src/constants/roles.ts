/**
 * Roles that write business: they register customers, hold inventory and create
 * contracts. Cluster agents supervise other agents but also sell, so every rule
 * written for an agent applies to them too.
 *
 * SALES_AGENT is deliberately excluded — it does not require contract approval
 * today, and folding it in here would silently change that.
 */
export const SELLING_AGENT_ROLES = ['AGENT', 'CLUSTER_AGENT'] as const;

/** Roles that can be supervised by a cluster agent or covered by a CSO. */
export const ASSIGNABLE_AGENT_ROLES = ['AGENT', 'SALES_AGENT', 'CLUSTER_AGENT'] as const;

export const CLUSTER_AGENT_ROLE = 'CLUSTER_AGENT';
export const CUSTOMER_SERVICE_ROLE = 'CUSTOMER_SERVICE';

export function isSellingAgentRole(role: string | undefined | null): boolean {
  return !!role && (SELLING_AGENT_ROLES as readonly string[]).includes(role);
}
