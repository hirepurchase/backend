import cron from 'node-cron';
import { enqueueSingletonJob } from '../backgroundJobService';
import { refreshTranssionContracts } from './registry';
import { getPayTriggerSettings } from './settings';
import { runMorningSweep } from './sweep';

/**
 * One cron job: the 08:36 morning sweep. Everything else PayTrigger does is
 * triggered by events. Registered with a single line in src/index.ts and
 * wrapped so that nothing here can stop the server starting.
 */

const DEFAULT_CRON = '36 8 * * *';

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
}
