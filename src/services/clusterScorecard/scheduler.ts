import cron from 'node-cron';
import { enqueueSingletonJob } from '../backgroundJobService';
import { syncAssignmentHistory } from './history';

/**
 * Hourly: keep the cluster assignment history in step with the live
 * assignments, so a removal is dated within the hour. Moves between leaders
 * are dated exactly regardless. Wrapped so nothing here can stop the server.
 */
export function startClusterScorecardScheduler(): void {
  try {
    syncAssignmentHistory().catch((err) => console.error('Cluster scorecard: history sync failed', err?.message || err));
    cron.schedule('17 * * * *', () => {
      enqueueSingletonJob('cluster-assignment-history', async () => {
        try {
          const r = await syncAssignmentHistory();
          if (r.opened || r.closed) console.log(`Cluster assignment history: ${r.opened} opened, ${r.closed} closed`);
        } catch (err) {
          console.error('Cluster scorecard: history sync failed', (err as Error)?.message || err);
        }
      });
    });
  } catch (err) {
    console.error('Cluster scorecard: scheduler failed to start', err);
  }
}
