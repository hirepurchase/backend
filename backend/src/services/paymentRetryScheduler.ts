import cron from 'node-cron';
import { retryAllEligiblePayments } from './paymentRetryService';

// Schedule payment retries to run every 6 hours
export function startPaymentRetryScheduler() {
  // Run every 6 hours at 0 minutes (00:00, 06:00, 12:00, 18:00)
  const cronSchedule = '0 */6 * * *';

  console.log('🔄 Payment retry scheduler initialized');
  console.log(`📅 Cron schedule: ${cronSchedule} (every 6 hours)`);

  cron.schedule(cronSchedule, async () => {
    try {
      console.log('🔄 Running automatic payment retry process...');
      const result = await retryAllEligiblePayments();

      console.log('✅ Payment retry process completed');
      console.log(`📊 Processed: ${result.processed}`);
      console.log(`✅ Succeeded: ${result.succeeded}`);
      console.log(`❌ Failed: ${result.failed}`);

      if (result.processed === 0) {
        console.log('ℹ️  No payments eligible for retry at this time');
      }
    } catch (error) {
      console.error('❌ Error in payment retry scheduler:', error);
    }
  });

  console.log('✅ Payment retry scheduler started successfully');
}

// Optional: Run retry scheduler manually (for testing)
export async function runRetrySchedulerManually() {
  console.log('🔄 Running payment retry manually...');
  const result = await retryAllEligiblePayments();

  console.log('✅ Manual payment retry completed');
  console.log(`📊 Processed: ${result.processed}`);
  console.log(`✅ Succeeded: ${result.succeeded}`);
  console.log(`❌ Failed: ${result.failed}`);

  return result;
}

export default {
  startPaymentRetryScheduler,
  runRetrySchedulerManually,
};
