import cron from 'node-cron';
import { enqueueSingletonJob } from '../backgroundJobService';
import { refreshTranssionContracts } from './registry';
import { getPayTriggerSettings } from './settings';
import { runMorningSweep } from './sweep';
import { retryStalledCommands } from './retry';

/**
 * Two cron jobs: the 08:36 morning sweep, and a five-minute pass that picks up
 * sends that failed or stalled. Everything else PayTrigger does is triggered
 * by events. Registered with a single line in src/index.ts and
 * wrapped so that nothing here can stop the server starting.
 */

const DEFAULT_CRON = '36 8 * * *';
/** Failed or stalled sends are picked up again on this tick, not left for the next morning. */
const RETRY_CRON = '*/5 * * * *';

export function startPayTriggerScheduler(): void {
  try {
    init().catch((err) => console.error('PayTrigger: scheduler failed to start', err));
  } catch (err) {
    console.error('PayTrigger: scheduler failed to start', err);
  }
}

async function init() {
  let expression = DEFAULT_CRON;
  try {
    const count = await refreshTranssionContracts();
    const settings = await getPayTriggerSettings();
    if (cron.validate(settings.morningSweepCron)) expression = settings.morningSweepCron;
    console.log(`📱 PayTrigger: ${count} Transsion contract(s) tracked; morning sweep ${expression}`);
  } catch (err) {
    // Tables missing (migration not applied) or DB down: keep the default and
    // let the first sweep try again.
    console.error('PayTrigger: could not load state at startup', (err as Error)?.message || err);
  }

  cron.schedule(expression, () => {
    const enqueued = enqueueSingletonJob('paytrigger-morning-sweep', async () => {
      try {
        const s = await runMorningSweep();
        console.log(
          `📱 PayTrigger sweep: ${s.reconciled} reconciled, ${s.sent} sent, ${s.released} released, ` +
            `${s.statusReads} status reads, ${s.errors} errors${s.breakerTripped ? ', BREAKER TRIPPED' : ''}`,
        );
      } catch (err) {
        console.error('PayTrigger: morning sweep failed', err);
      }
    });
    if (!enqueued) console.log('⏭️  PayTrigger sweep still running — skipped');
  });

  cron.schedule(RETRY_CRON, () => {
    enqueueSingletonJob('paytrigger-retry', async () => {
      try {
        const r = await retryStalledCommands();
        if (r.devices || r.abandoned) {
          console.log(`📱 PayTrigger retry: ${r.devices} device(s) re-checked, ${r.closed} row(s) closed, ${r.abandoned} abandoned`);
        }
      } catch (err) {
        console.error('PayTrigger: retry run failed', err);
      }
    });
  });
}
