import cron from 'node-cron';
import { enqueueSingletonJob } from './backgroundJobService';
import { processPendingManagedDeviceCommands, resetStuckProcessingCommands } from './deviceControlPolicyService';

const DEVICE_CONTROL_CRON = process.env.KNOX_GUARD_COMMAND_CRON || '*/5 * * * *';
const DEVICE_CONTROL_BATCH_SIZE = Number(process.env.KNOX_GUARD_COMMAND_BATCH_SIZE || '10');

export async function resetStuckCommandsOnStartup() {
  try {
    const reset = await resetStuckProcessingCommands();
    if (reset > 0) {
      console.log(`⚠️  Knox Guard: reset ${reset} stuck PROCESSING command(s) to FAILED on startup`);
    }
  } catch (error) {
    console.error('Knox Guard: failed to reset stuck PROCESSING commands on startup:', error);
  }
}

export function startDeviceControlScheduler() {
  console.log('🔐 Knox Guard device control scheduler initialized');
  console.log(`📅 Cron schedule: ${DEVICE_CONTROL_CRON}`);
  console.log(`📦 Batch size: ${DEVICE_CONTROL_BATCH_SIZE}`);

  // Reset any commands that were stuck in PROCESSING when the server last stopped
  resetStuckCommandsOnStartup();

  cron.schedule(DEVICE_CONTROL_CRON, async () => {
    const enqueued = enqueueSingletonJob('knox-guard-command-processor', async () => {
      try {
        console.log('🔐 Running Knox Guard command processor...');
        const result = await processPendingManagedDeviceCommands(DEVICE_CONTROL_BATCH_SIZE);

        console.log('✅ Knox Guard command processor completed');
        console.log(`📊 Processed: ${result.processed}`);
        console.log(`✅ Succeeded: ${result.succeeded}`);
        console.log(`❌ Failed: ${result.failed}`);

        if (result.processed === 0) {
          console.log('ℹ️  No Knox Guard commands eligible for processing at this time');
        }
      } catch (error) {
        console.error('❌ Error in Knox Guard device control scheduler:', error);
      }
    });

    if (!enqueued) {
      console.log('⏭️  Skipping Knox Guard tick - previous command job still running');
    }
  });

  console.log('✅ Knox Guard device control scheduler started successfully');
}

export async function runDeviceControlSchedulerManually() {
  console.log('🔐 Running Knox Guard command processor manually...');
  const result = await processPendingManagedDeviceCommands(DEVICE_CONTROL_BATCH_SIZE);

  console.log('✅ Manual Knox Guard processing completed');
  console.log(`📊 Processed: ${result.processed}`);
  console.log(`✅ Succeeded: ${result.succeeded}`);
  console.log(`❌ Failed: ${result.failed}`);

  return result;
}

export default {
  startDeviceControlScheduler,
  runDeviceControlSchedulerManually,
};
