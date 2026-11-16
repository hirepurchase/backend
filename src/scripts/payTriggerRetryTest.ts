/**
 * PayTrigger retry job, unexpected lock removal and settings re-check.
 * LOCAL TEST DATABASE and a MOCK PayTrigger only — nothing reaches Transsion.
 *
 *   DATABASE_URL=postgresql://…@localhost:…/db npx ts-node src/scripts/payTriggerRetryTest.ts
 *
 * Needs the demo data (prisma/seed.ts then prisma/demoSeed.ts). Adds its own
 * test phones and removes them at the end.
 */
import * as http from 'http';

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error('Refusing to run: DATABASE_URL is not a localhost test database.');
  process.exit(2);
}
const MOCK_PORT = 55993;
process.env.PAYTRIGGER_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;
process.env.PAYTRIGGER_API_KEY = 'mock-key';
process.env.PAYTRIGGER_DRY_RUN = 'false';
process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = 'true';
process.env.PAYTRIGGER_CANARY_CONTRACTS = '';
process.env.ENABLE_SMS_NOTIFICATIONS = 'false';
process.env.ENABLE_EMAIL_NOTIFICATIONS = 'false';

// ─── Mock PayTrigger: answers everything, or refuses our IP like the allow-list does ───
let mode: 'ok' | 'whitelist' = 'ok';
const calls: Array<{ path: string; body: any; code: number }> = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const path = (req.url || '').replace('/api/partner', '');
    const code = mode === 'whitelist' ? 40001 : 200;
    calls.push({ path, body, code });
    let data: unknown = {};
    if (path.endsWith('/findLockState')) data = { imei: body.imei, mobileStatus: 2000, lockState: 3000 };
    if (path.endsWith('/batchFindLockState')) data = [];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(code === 200 ? { code, message: 'Success', data } : { code, message: 'Request IP [127.0.0.1] is not in IP whitelist.' }));
  });
});

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const IMEI_PREFIX = '35999900000';
const MIN = 60_000;

async function main() {
  await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

  const prisma = (await import('../config/database')).default;
  const { reconcileContract } = await import('../services/payTrigger/reconcile');
  const { retryStalledCommands, isDue } = await import('../services/payTrigger/retry');
  const { spoolCallback, processCallback } = await import('../services/payTrigger/callbacks');
  const { getIssues } = await import('../services/payTrigger/admin');
  const { getPayTriggerSettings, invalidatePayTriggerSettings } = await import('../services/payTrigger/settings');
  const { describeCode } = await import('../services/payTrigger/errors');
  const { addTranssionContract } = await import('../services/payTrigger/registry');
  const { putSettings } = await import('../controllers/payTriggerController');

  const cleanup = async () => {
    const devices = await prisma.payTriggerDevice.findMany({ where: { imei: { startsWith: IMEI_PREFIX } }, select: { id: true } });
    const ids = devices.map((d) => d.id);
    await prisma.payTriggerCommand.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.payTriggerActionLog.deleteMany({ where: { deviceId: { in: ids } } });
    await prisma.payTriggerWebhookEvent.deleteMany({ where: { notifyType: '2000', body: { path: ['imei'], string_starts_with: IMEI_PREFIX } } });
    await prisma.payTriggerDevice.deleteMany({ where: { id: { in: ids } } });
  };
  await cleanup();

  const original = await getPayTriggerSettings();
  // The demo data has no agent-deposit ledgers; the deposit hold is not what is tested here.
  await prisma.payTriggerSettings.update({ where: { id: 'singleton' }, data: { lockOnUnpaidAgentDeposit: false, lockAfterOverdueDays: 1 } });
  invalidatePayTriggerSettings();

  const admin = await prisma.adminUser.findFirstOrThrow({ where: { email: 'admin@hirepurchase.com' }, select: { id: true } });
  const load = (n: string) =>
    prisma.hirePurchaseContract.findFirstOrThrow({ where: { contractNumber: n }, select: { id: true, status: true, inventoryItem: { select: { id: true } } } });
  const c1 = await load('CONDEMO001');
  const c6 = await load('CONDEMO006');
  const past = new Date(Date.now() - 2 * 86400_000);
  const mkDevice = (n: number, contract: typeof c1) =>
    prisma.payTriggerDevice.create({
      data: {
        imei: `${IMEI_PREFIX}${String(n).padStart(4, '0')}`,
        inventoryItemId: contract.inventoryItem!.id,
        contractId: contract.id,
        enrollmentStatus: 'ACTIVE',
        committedState: 'LOCKED',
        providerExpiresAt: past,
      },
    });
  const d1 = await mkDevice(1, c1);
  addTranssionContract(c1.id);
  const cmd = (where: object) => prisma.payTriggerCommand.findFirst({ where: { deviceId: d1.id, ...where }, orderBy: { createdAt: 'desc' } });
  const backdate = (id: string, ms: number) => prisma.$executeRaw`UPDATE "PayTriggerCommand" SET "updatedAt" = ${new Date(Date.now() - ms)} WHERE id = ${id}`;

  // ── 1. When a row is due ──────────────────────────────────────────────
  const now = new Date();
  const row = (o: Partial<Parameters<typeof isDue>[0]>) => ({ id: 'x', deviceId: 'd', status: 'FAILED', attempts: 4, nextAttemptAt: null, lastError: 'x', updatedAt: now, ...o });
  check('pending row waits for the in-process timer', !isDue(row({ status: 'PENDING', nextAttemptAt: new Date(now.getTime() - 30_000) }), now));
  check('pending row past its time + grace is due', isDue(row({ status: 'PENDING', nextAttemptAt: new Date(now.getTime() - 2 * MIN) }), now));
  check('send cut off by a restart (processing 15 min) is due', isDue(row({ status: 'PROCESSING', updatedAt: new Date(now.getTime() - 15 * MIN) }), now));
  check('send in progress (processing 2 min) is left alone', !isDue(row({ status: 'PROCESSING', updatedAt: new Date(now.getTime() - 2 * MIN) }), now));
  check('failed row backs off: 6 attempts waits 20 min (10 min: not yet)', !isDue(row({ attempts: 6, updatedAt: new Date(now.getTime() - 10 * MIN) }), now));
  check('failed row backs off: 6 attempts waits 20 min (25 min: due)', isDue(row({ attempts: 6, updatedAt: new Date(now.getTime() - 25 * MIN) }), now));
  check('backoff never exceeds an hour', isDue(row({ attempts: 30, updatedAt: new Date(now.getTime() - 61 * MIN) }), now));
  check('rate-limited row is never retried by the job', !isDue(row({ lastError: describeCode('50008'), updatedAt: new Date(now.getTime() - 5 * 3600_000) }), now));
  check('permanent error is never retried by the job', !isDue(row({ lastError: describeCode('20001'), updatedAt: new Date(now.getTime() - 5 * 3600_000) }), now));

  // ── 2. A payment while PayTrigger refuses our IP, then recovers ───────────
  mode = 'whitelist';
  const first = await reconcileContract(c1.id, { reasons: ['PAYMENT'] });
  const failedExtend = await cmd({ type: 'EXTEND' });
  check('unlock refused by the allow-list is left pending a retry', first.sent === 'extend failed' && failedExtend?.status === 'PENDING', { sent: first.sent, status: failedExtend?.status });
  const stillLocked = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: d1.id } });
  check('phone not recorded as opened while refused', stillLocked.providerExpiresAt?.getTime() === past.getTime());

  const early = await retryStalledCommands(new Date());
  check('job leaves a row whose in-process retry is still to come', early.devices === 0, early);

  mode = 'ok';
  const later = await retryStalledCommands(new Date(Date.now() + 3 * MIN));
  const afterRetry = await prisma.payTriggerCommand.findUniqueOrThrow({ where: { id: failedExtend!.id } });
  const opened = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: d1.id } });
  check('job re-checks the contract once PayTrigger answers', later.devices === 1, later);
  check('the same unlock succeeds on retry', afterRetry.status === 'SUCCEEDED', afterRetry.status);
  check('phone now has a future lock date', !!opened.providerExpiresAt && opened.providerExpiresAt > new Date(), opened.providerExpiresAt);

  // ── 3. Rows a restart left behind ────────────────────────────────────────
  const stale = await prisma.payTriggerCommand.create({
    data: { deviceId: d1.id, type: 'EXTEND', status: 'PROCESSING', idempotencyKey: `${d1.id}:EXTEND:stale-test`, payload: {}, attempts: 1, lastError: null },
  });
  await backdate(stale.id, 20 * MIN);
  const callsBefore = calls.length;
  const r3 = await retryStalledCommands(new Date());
  const staleAfter = await prisma.payTriggerCommand.findUniqueOrThrow({ where: { id: stale.id } });
  check('send cut off by a restart: contract re-checked', r3.devices === 1, r3);
  check('nothing re-sent when the phone is already in line', calls.length === callsBefore, calls.slice(callsBefore).map((c) => c.path));
  check('the overtaken row is closed so it is not picked up again', staleAfter.status === 'CANCELLED' && /Superseded/.test(staleAfter.lastError || ''), staleAfter);
  const again = await retryStalledCommands(new Date());
  check('closed rows stay closed', again.devices === 0, again);

  const limited = await prisma.payTriggerCommand.create({
    data: { deviceId: d1.id, type: 'EXTEND', status: 'FAILED', idempotencyKey: `${d1.id}:EXTEND:limited-test`, payload: {}, attempts: 4, lastError: describeCode('50008') },
  });
  await backdate(limited.id, 3 * 3600_000);
  const abandoned = await prisma.payTriggerCommand.create({
    data: { deviceId: d1.id, type: 'SYNC', status: 'PENDING', idempotencyKey: `${d1.id}:SYNC:old-test`, payload: {}, attempts: 1, lastError: describeCode('40001'), nextAttemptAt: new Date(Date.now() - 2 * 86400_000) },
  });
  await backdate(abandoned.id, 2 * 86400_000);
  const r4 = await retryStalledCommands(new Date());
  const limitedAfter = await prisma.payTriggerCommand.findUniqueOrThrow({ where: { id: limited.id } });
  const abandonedAfter = await prisma.payTriggerCommand.findUniqueOrThrow({ where: { id: abandoned.id } });
  check('rate-limited row left alone (no quota spent)', r4.devices === 0 && limitedAfter.status === 'FAILED', { r4, status: limitedAfter.status });
  check('row stuck pending for 2 days is closed, error kept', abandonedAfter.status === 'CANCELLED' && abandonedAfter.lastError === describeCode('40001') && r4.abandoned === 1, abandonedAfter);

  // ── 4. A settings change reaches every phone straight away ─────────────
  const res = () => {
    const out: { code: number; body: any } = { code: 200, body: null };
    return {
      out,
      status(code: number) { out.code = code; return this; },
      json(body: unknown) { out.body = body; return this; },
    };
  };
  const before4 = (await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: d1.id } })).providerExpiresAt!;
  const unchanged = res();
  await putSettings({ body: { lockAfterOverdueDays: 1 }, user: { id: admin.id, role: 'SUPER_ADMIN' }, ip: '127.0.0.1' } as any, unchanged as any);
  check('saving the same value does not re-check every phone', unchanged.out.code === 200 && unchanged.out.body?.recheckingPhones === false, unchanged.out);

  const changed = res();
  await putSettings({ body: { lockAfterOverdueDays: 3 }, user: { id: admin.id, role: 'SUPER_ADMIN' }, ip: '127.0.0.1' } as any, changed as any);
  check('changing when phones lock re-checks every phone', changed.out.body?.recheckingPhones === true, changed.out);
  let moved: Date | null = null;
  for (let i = 0; i < 40 && !moved; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const d = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: d1.id } });
    if (d.providerExpiresAt && d.providerExpiresAt.getTime() !== before4.getTime()) moved = d.providerExpiresAt;
  }
  const days = moved ? Math.round((moved.getTime() - before4.getTime()) / 86400_000) : null;
  check('phone lock date moved 2 days later without waiting for the sweep', days === 2, { before: before4, after: moved });

  // ── 5. Lock removed by Transsion while the customer owes ────────────────
  const expectedDevice = await mkDevice(2, c6);
  await prisma.payTriggerCommand.create({
    data: { deviceId: expectedDevice.id, type: 'RELEASE', status: 'SUCCEEDED', idempotencyKey: `${expectedDevice.id}:RELEASE:release`, payload: {}, attempts: 1 },
  });
  for (const d of [d1, expectedDevice]) {
    const id = await spoolCallback({ notifyType: 2000, imei: d.imei, clientRemoveTime: Math.floor(Date.now() / 1000) });
    await processCallback(id);
  }
  const removed = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: d1.id } });
  const released = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: expectedDevice.id } });
  check('unrequested removal on an active contract is flagged on the phone', removed.enrollmentStatus === 'REMOVED' && /Transsion removed the lock/.test(removed.lastError || ''), removed.lastError);
  const audit = await prisma.auditLog.findFirst({ where: { action: 'PAYTRIGGER_UNEXPECTED_REMOVAL', entityId: d1.id } });
  check('unrequested removal is written to the audit trail', !!audit);
  check('a removal we asked for is not flagged', released.enrollmentStatus === 'REMOVED' && !released.lastError, released.lastError);
  const issues = await getIssues();
  const listed = issues.removedWhileOwing.map((r) => r.deviceId);
  check('Issues page lists the unrequested removal', listed.includes(d1.id), listed);
  check('Issues page leaves out the removal we asked for', !listed.includes(expectedDevice.id), listed);
  check('it counts towards the issue total', issues.counts.removedWhileOwing >= 1 && issues.counts.total >= issues.counts.removedWhileOwing, issues.counts);

  // ── Tidy up ────────────────────────────────────────────────────────────
  await prisma.payTriggerSettings.update({
    where: { id: 'singleton' },
    data: { lockOnUnpaidAgentDeposit: original.lockOnUnpaidAgentDeposit, lockAfterOverdueDays: original.lockAfterOverdueDays },
  });
  invalidatePayTriggerSettings();
  await cleanup();
  mock.close();
  await prisma.$disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
