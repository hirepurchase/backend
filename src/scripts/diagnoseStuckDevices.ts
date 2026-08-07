import prisma from '../config/database';
import { getKnoxWebhookSecuritySummary } from '../utils/knoxWebhookSecurity';

/**
 * READ-ONLY diagnostic for Knox Guard devices that should be unlocked but aren't.
 *
 * Performs no writes and makes no Knox API calls. Safe to run against production.
 *
 *   npm run knox:diagnose
 *
 * Answers three questions:
 *   1. Is webhook reconciliation mode ON? (it parks devices in PENDING after a
 *      successful lock, waiting for a Samsung webhook that may never arrive)
 *   2. Which devices are stuck — locked/pending while nothing is overdue?
 *   3. For each, what did Knox actually return, and is a command still queued?
 */

const prismaAny = prisma as any;

function daysOverdue(dueDate: Date, gracePeriodDays: number): number {
  const dueWithGrace = new Date(dueDate);
  dueWithGrace.setDate(dueWithGrace.getDate() + gracePeriodDays);
  dueWithGrace.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = today.getTime() - dueWithGrace.getTime();
  return diff > 0 ? Math.floor(diff / 86400000) : 0;
}

function age(date: Date | null | undefined): string {
  if (!date) return 'never';
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function main() {
  // ---- 1. Configuration ----
  const security = getKnoxWebhookSecuritySummary();
  const reconciliationEnabled = security.signatureCertificateConfigured;

  console.log('='.repeat(72));
  console.log('KNOX GUARD DIAGNOSTIC (read-only)');
  console.log('='.repeat(72));
  console.log('');
  console.log('Webhook signature cert configured : ', security.signatureCertificateConfigured);
  console.log('Webhook shared token configured   : ', security.sharedTokenConfigured);
  console.log('RECONCILIATION MODE               : ', reconciliationEnabled ? 'ON' : 'OFF');
  console.log('');
  if (reconciliationEnabled) {
    console.log('  Reconciliation is ON: a successful LOCK/UNLOCK/APPROVE parks the device');
    console.log('  in actualState=PENDING and waits for a Samsung webhook to confirm.');
    console.log('  If those webhooks are not arriving, devices stay PENDING forever.');
  } else {
    console.log('  Reconciliation is OFF: lock/unlock write LOCKED/UNLOCKED directly.');
    console.log('  Any device in PENDING therefore got that state from a Knox *response*');
    console.log('  body (e.g. status "PROCESSING"/"QUEUED"), not from reconciliation mode.');
  }
  console.log('');

  // ---- 2. Load devices ----
  const devices = await prismaAny.managedDevice.findMany({
    where: { isActive: true },
    include: {
      contract: {
        include: {
          installments: { orderBy: { installmentNo: 'asc' } },
          penalties: { where: { isPaid: false } },
        },
      },
      commands: { orderBy: { createdAt: 'desc' }, take: 5 },
    },
  });

  const stateCounts: Record<string, number> = {};
  for (const d of devices) {
    stateCounts[d.actualState] = (stateCounts[d.actualState] || 0) + 1;
  }

  console.log(`Active managed devices: ${devices.length}`);
  console.log('actualState distribution:', stateCounts);
  console.log('');

  // ---- 3. Find stuck devices ----
  type Stuck = {
    contractNumber: string;
    actualState: string;
    desiredState: string;
    enrollmentStatus: string;
    knoxStatus: string | null;
    lastKnoxAction: string | null;
    lastError: string | null;
    lastSyncedAt: Date | null;
    lastLockedAt: Date | null;
    overdueAmount: number;
    liveCommands: string[];
    recentCommands: string[];
  };

  const stuck: Stuck[] = [];

  for (const device of devices) {
    const contract = device.contract;
    if (!contract || contract.status !== 'ACTIVE') continue;

    const overdueInstallments = contract.installments.filter(
      (i: any) => i.status !== 'PAID' && daysOverdue(i.dueDate, contract.gracePeriodDays) > 0
    );
    const overdueAmount = Number(
      overdueInstallments
        .reduce((sum: number, i: any) => sum + (i.amount - i.paidAmount), 0)
        .toFixed(2)
    );

    const lockedOrPending = ['LOCKED', 'PENDING'].includes(device.actualState);
    const shouldBeUnlocked = lockedOrPending && overdueAmount === 0;

    if (!shouldBeUnlocked) continue;

    const liveCommands = device.commands
      .filter((c: any) => ['PENDING', 'PROCESSING'].includes(c.status))
      .map((c: any) => `${c.type}:${c.status}(attempts=${c.attempts})`);

    stuck.push({
      contractNumber: contract.contractNumber,
      actualState: device.actualState,
      desiredState: device.desiredState,
      enrollmentStatus: device.enrollmentStatus,
      knoxStatus: device.knoxStatus,
      lastKnoxAction: device.lastKnoxAction,
      lastError: device.lastError,
      lastSyncedAt: device.lastSyncedAt,
      lastLockedAt: device.lastLockedAt,
      overdueAmount,
      liveCommands,
      recentCommands: device.commands.map(
        (c: any) =>
          `${c.type} ${c.status} attempts=${c.attempts} ${age(c.createdAt)}` +
          (c.errorMessage ? ` err="${String(c.errorMessage).slice(0, 80)}"` : '')
      ),
    });
  }

  console.log('='.repeat(72));
  console.log(`STUCK DEVICES: ${stuck.length}`);
  console.log('(locked or pending, but nothing overdue — these should be unlocked)');
  console.log('='.repeat(72));
  console.log('');

  if (stuck.length === 0) {
    console.log('None. No device is currently locked while its account is clear.');
  }

  for (const s of stuck) {
    console.log(`${s.contractNumber}`);
    console.log(`  actualState / desiredState : ${s.actualState} / ${s.desiredState}`);
    console.log(`  enrollmentStatus           : ${s.enrollmentStatus}`);
    console.log(`  knoxStatus (raw from Knox) : ${s.knoxStatus ?? '(none)'}`);
    console.log(`  lastKnoxAction             : ${s.lastKnoxAction ?? '(none)'}`);
    console.log(`  lastSyncedAt               : ${age(s.lastSyncedAt)}`);
    console.log(`  lastLockedAt               : ${age(s.lastLockedAt)}`);
    console.log(`  overdueAmount              : ${s.overdueAmount.toFixed(2)}`);
    console.log(`  live commands in queue     : ${s.liveCommands.length ? s.liveCommands.join(', ') : 'NONE'}`);
    if (s.lastError) {
      console.log(`  lastError                  : ${s.lastError.slice(0, 120)}`);
    }
    if (s.recentCommands.length) {
      console.log(`  recent commands:`);
      for (const c of s.recentCommands) console.log(`    - ${c}`);
    } else {
      console.log(`  recent commands            : NONE EVER QUEUED`);
    }
    console.log('');
  }

  // ---- 4. Diagnosis ----
  if (stuck.length > 0) {
    const pendingStuck = stuck.filter((s) => s.actualState === 'PENDING');
    const noLiveCommand = stuck.filter((s) => s.liveCommands.length === 0);

    console.log('='.repeat(72));
    console.log('DIAGNOSIS');
    console.log('='.repeat(72));
    console.log(`  stuck in PENDING            : ${pendingStuck.length}`);
    console.log(`  stuck in LOCKED             : ${stuck.length - pendingStuck.length}`);
    console.log(`  with NO live command queued : ${noLiveCommand.length}  <-- these are inert`);
    console.log('');

    if (pendingStuck.length > 0) {
      const distinctKnoxStatuses = Array.from(
        new Set(pendingStuck.map((s) => s.knoxStatus).filter(Boolean))
      );
      console.log('  Knox statuses seen on PENDING devices:',
        distinctKnoxStatuses.length ? distinctKnoxStatuses.join(', ') : '(none recorded)');
      console.log('');
      if (reconciliationEnabled) {
        console.log('  Reconciliation is ON, so PENDING is expected right after a lock.');
        console.log('  Devices PENDING for a long time => Samsung webhooks are NOT arriving.');
        console.log('  Check the /api/knox-guard/webhook endpoint is reachable from Samsung.');
      } else {
        console.log('  Reconciliation is OFF, so these came from Knox response bodies.');
        console.log('  resolveManagedState maps PROCESSING/QUEUED/REQUESTED/WAITING and any');
        console.log('  string containing PENDING/QUEUE/PROCESS to PENDING — likely too greedy.');
      }
    }
  }

  console.log('');
  console.log('Diagnostic complete. No data was modified.');
}

main()
  .catch((error) => {
    console.error('Diagnostic failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
