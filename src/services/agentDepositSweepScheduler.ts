import cron from 'node-cron';
import { enqueueSingletonJob } from './backgroundJobService';
import { sweepStuckAgentDeposits } from './agentDepositUssdService';

/** Every ten minutes: settle or fail agent deposit charges Hubtel never called back about. */
const AGENT_DEPOSIT_SWEEP_CRON = process.env.AGENT_DEPOSIT_SWEEP_CRON || '*/10 * * * *';

export function startAgentDepositSweepScheduler(): void {
  cron.schedule(AGENT_DEPOSIT_SWEEP_CRON, () => {
    enqueueSingletonJob('agent-deposit-sweep', async () => {
      try {
        const r = await sweepStuckAgentDeposits();
        if (r.checked > 0) console.log(`💳 Agent deposit sweep: ${r.checked} checked, ${r.settled} settled, ${r.failed} failed`);
      } catch (error) {
        console.error('❌ Agent deposit sweep failed:', error);
      }
    });
  });
  console.log('✅ Agent deposit sweep scheduler started');
}
