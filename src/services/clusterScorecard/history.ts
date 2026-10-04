import prisma from '../../config/database';

/**
 * Keep ClusterAssignmentHistory in step with ClusterAgentAssignment.
 *
 * Assignments are written in several places (team edits, supervision
 * settings, deactivation), so rather than touch each one, this compares the
 * live table with the open history rows and closes or opens rows to match.
 * It runs before every scorecard calculation and hourly.
 *
 * A move between leaders is dated exactly: assignment rows are recreated on
 * every change, so the new row's createdAt is when the move happened. Only a
 * plain removal (no new leader) is dated at the sync, at most an hour late.
 */
export async function syncAssignmentHistory(now = new Date()): Promise<{ opened: number; closed: number }> {
  const [live, open] = await Promise.all([
    prisma.clusterAgentAssignment.findMany({ select: { agentId: true, clusterAgentId: true, createdAt: true } }),
    prisma.clusterAssignmentHistory.findMany({ where: { endedAt: null }, select: { id: true, agentId: true, clusterAgentId: true } }),
  ]);
  const liveByAgent = new Map(live.map((a) => [a.agentId, a]));
  const openByAgent = new Map(open.map((h) => [h.agentId, h]));
  let opened = 0;
  let closed = 0;

  for (const row of open) {
    const current = liveByAgent.get(row.agentId);
    if (current && current.clusterAgentId === row.clusterAgentId) continue; // unchanged
    // Moved: end at the moment the new assignment was made. Removed: end now.
    const endedAt = current ? current.createdAt : now;
    await prisma.clusterAssignmentHistory.update({ where: { id: row.id }, data: { endedAt } });
    openByAgent.delete(row.agentId);
    closed++;
  }

  for (const a of live) {
    if (openByAgent.has(a.agentId)) continue;
    await prisma.clusterAssignmentHistory.create({
      data: { agentId: a.agentId, clusterAgentId: a.clusterAgentId, startedAt: a.createdAt },
    });
    opened++;
  }
  return { opened, closed };
}

export interface Interval {
  agentId: string;
  clusterAgentId: string;
  startedAt: Date;
  endedAt: Date | null;
}

/** Every stint overlapping [from, to). */
export async function intervalsBetween(from: Date, to: Date): Promise<Interval[]> {
  return prisma.clusterAssignmentHistory.findMany({
    where: { startedAt: { lt: to }, OR: [{ endedAt: null }, { endedAt: { gt: from } }] },
    select: { agentId: true, clusterAgentId: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: 'asc' },
  });
}

/** Who led this agent at this moment, from a preloaded list. */
export function leaderAt(intervals: Interval[], agentId: string, at: Date): string | null {
  const t = at.getTime();
  for (const iv of intervals) {
    if (iv.agentId !== agentId) continue;
    if (iv.startedAt.getTime() <= t && (!iv.endedAt || iv.endedAt.getTime() > t)) return iv.clusterAgentId;
  }
  return null;
}
