import cron from 'node-cron';
import { enqueueSingletonJob } from './backgroundJobService';
import { sweepStuckAgentDeposits } from './agentDepositUssdService';
import { sweepPaystackCustomerPayments } from './gateways/settle';

/**
 * Every ten minutes: settle or fail charges the gateway never told us about.
 * Agent deposits on either gateway, and customer payments sent through
 * Paystack (Hubtel customer payments keep their own admin reconcile).
 */
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
      // Its own try, so a failed deposit sweep never skips customer payments.
      try {
        const r = await sweepPaystackCustomerPayments();
        if (r.checked > 0) console.log(`💳 Paystack payment sweep: ${r.checked} checked, ${r.settled} settled, ${r.failed} failed`);
      } catch (error) {
        console.error('❌ Paystack payment sweep failed:', error);
      }
      try {
        const { sweepCommissionTransfers } = await import('./payouts/commissionPayouts');
        const r = await sweepCommissionTransfers();
        if (r.checked || r.resumed) console.log(`💸 Commission payouts: ${r.checked} checked, ${r.resumed} resumed`);
      } catch (error) {
        console.error('❌ Commission payout sweep failed:', error);
      }
    });
  });
  console.log('✅ Payment sweep scheduler started (agent deposits, Paystack payments)');
}
