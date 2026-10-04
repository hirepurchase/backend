import prisma from '../../config/database';
import * as client from './client';
import { describeCode } from './errors';
import { enqueue } from './events';
import { reconcileContract } from './reconcile';
import { releaseDevice } from './sweep';
import { getPayTriggerSettings } from './settings';
import { addTranssionContract } from './registry';
import { invalidatePayTriggerProducts } from './guard';
import { logAction } from './log';

/**
 * Admin actions behind the PayTrigger screens: enrolment, PIN, release,
 * products, and the Issues list.
 */

const TRANSSION_NAME = /\b(tecno|infinix|itel)\b/i;
const MIN_APK_WITHOUT_KEY = [2, 2, 6, 4]; // V2.2.6.004

/** Phones on PayTrigger app below V2.2.6.004 need the 4-digit key from the lock screen. */
export function needsKeyCode(apkVersion: string | null | undefined): boolean {
  if (!apkVersion) return false; // unknown — PayTrigger answers 50063 and the dialog asks
  const parts = apkVersion.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < MIN_APK_WITHOUT_KEY.length; i++) {
    if ((parts[i] ?? 0) !== MIN_APK_WITHOUT_KEY[i]) return (parts[i] ?? 0) < MIN_APK_WITHOUT_KEY[i];
  }
  return false;
}

// ─── Products ──────────────────────────────────────────────────────────────

export async function listProducts() {
  const [marked, products] = await Promise.all([
    prisma.payTriggerProduct.findMany(),
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);
  const markedIds = new Map(marked.map((m) => [m.productId, m]));
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    marked: markedIds.has(p.id),
    brand: markedIds.get(p.id)?.brand ?? null,
    // Suggestion only: routing is never inferred, an admin confirms it.
    suggested: !markedIds.has(p.id) && TRANSSION_NAME.test(p.name),
  }));
}

export async function setProducts(productIds: string[], actorId: string) {
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } });
  await prisma.$transaction([
    prisma.payTriggerProduct.deleteMany({ where: { productId: { notIn: products.map((p) => p.id) } } }),
    ...products.map((p) =>
      prisma.payTriggerProduct.upsert({
        where: { productId: p.id },
        create: { productId: p.id, brand: (p.name.match(TRANSSION_NAME)?.[1] || 'TECNO').toUpperCase(), addedById: actorId },
        update: {},
      }),
    ),
  ]);
  invalidatePayTriggerProducts();
  return listProducts();
}

// ─── Which lock a product needs ────────────────────────────────────────────

export type LockProvider = 'PAYTRIGGER' | 'KNOX' | 'NONE';
const SAMSUNG_NAME = /\b(samsung|galaxy)\b/i;

/**
 * Suggest the lock system for a new stock item, for the inventory form:
 *   1. a product marked on the PayTrigger products screen → PayTrigger
 *   2. a TECNO / Infinix / itel name → PayTrigger (product not yet marked)
 *   3. a Samsung / Galaxy name → Knox Guard
 *   4. with an IMEI and PayTrigger configured, PayTrigger's own model lookup
 *   5. otherwise no lock (TVs, fridges and other goods)
 * It is a suggestion; the person adding stock can choose otherwise.
 */
export async function detectLockProvider(productId: string, imei?: string | null) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true } });
  if (!product) throw new Error('Product not found');
  const marked = await prisma.payTriggerProduct.findUnique({ where: { productId } });
  const result = (provider: LockProvider, reason: string) => ({ provider, reason, productName: product.name, productMarked: !!marked });

  if (marked) return result('PAYTRIGGER', `${product.name} is marked as a PayTrigger (Transsion) product.`);
  if (TRANSSION_NAME.test(product.name)) return result('PAYTRIGGER', `${product.name} is a TECNO, Infinix or itel phone.`);
  if (SAMSUNG_NAME.test(product.name)) return result('KNOX', `${product.name} is a Samsung phone.`);

  if (imei && /^\d{15}$/.test(imei.trim())) {
    const model = await client.getModel(imei.trim()).catch(() => null);
    const brand = model?.success && !model.dryRun ? model.data?.brandName : undefined;
    if (brand && TRANSSION_NAME.test(brand)) {
      return result('PAYTRIGGER', `PayTrigger recognises this IMEI as a ${brand} ${model?.data?.modelMarketName || ''}`.trim() + '.');
    }
  }
  return result('NONE', `${product.name} is not a phone we lock. No lock will be set up.`);
}

/** Mark products as Transsion without touching the others (setProducts replaces the whole list). */
export async function markProducts(productIds: string[], actorId: string) {
  const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } });
  for (const p of products) {
    await prisma.payTriggerProduct.upsert({
      where: { productId: p.id },
      create: { productId: p.id, brand: (p.name.match(TRANSSION_NAME)?.[1] || 'TECNO').toUpperCase(), addedById: actorId },
      update: {},
    });
  }
  invalidatePayTriggerProducts();
  return products.length;
}

// ─── Enrolment ─────────────────────────────────────────────────────────────

/** Transsion stock not yet enrolled. */
export async function enrolmentCandidates() {
  const productIds = (await prisma.payTriggerProduct.findMany({ select: { productId: true } })).map((p) => p.productId);
  if (!productIds.length) return [];
  const enrolled = new Set((await prisma.payTriggerDevice.findMany({ select: { inventoryItemId: true } })).map((d) => d.inventoryItemId));
  const items = await prisma.inventoryItem.findMany({
    where: { productId: { in: productIds }, status: { in: ['AVAILABLE', 'RESERVED'] } },
    select: { id: true, serialNumber: true, status: true, product: { select: { name: true } }, assignedAgent: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return items
    .filter((i) => !enrolled.has(i.id))
    .map((i) => ({
      inventoryItemId: i.id,
      imei: i.serialNumber,
      product: i.product.name,
      status: i.status,
      assignedTo: i.assignedAgent ? `${i.assignedAgent.firstName} ${i.assignedAgent.lastName}` : null,
      validImei: /^\d{15,18}$/.test(i.serialNumber),
    }));
}

export async function enrolItems(inventoryItemIds: string[], actorId: string) {
  const settings = await getPayTriggerSettings();
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: inventoryItemIds } },
    select: { id: true, serialNumber: true, contractId: true, productId: true, product: { select: { name: true } } },
  });
  const transsion = new Set((await prisma.payTriggerProduct.findMany({ select: { productId: true } })).map((p) => p.productId));
  const results: Array<{ inventoryItemId: string; imei: string; ok: boolean; message: string }> = [];

  const eligible = items.filter((item) => {
    if (!transsion.has(item.productId)) {
      results.push({ inventoryItemId: item.id, imei: item.serialNumber, ok: false, message: 'Product is not marked as Transsion.' });
      return false;
    }
    if (!/^\d{15,18}$/.test(item.serialNumber)) {
      results.push({ inventoryItemId: item.id, imei: item.serialNumber, ok: false, message: describeCode('50020') });
      return false;
    }
    return true;
  });
  if (!eligible.length) return results;

  // Cross-check the model where PayTrigger knows the IMEI; a mismatch is shown, not blocking.
  const notes = new Map<string, string>();
  for (const item of eligible.slice(0, 50)) {
    const model = await client.getModel(item.serialNumber);
    if (model.success && !model.dryRun && model.data?.brandName && !TRANSSION_NAME.test(model.data.brandName)) {
      notes.set(item.id, `PayTrigger reports brand ${model.data.brandName}.`);
    }
  }

  const res = await client.enrolImeis(
    eligible.map((item) => ({ imei: item.serialNumber, orderNum: item.id, ruleNum: settings.defaultRuleNum, deeplink: settings.payDeeplink || undefined })),
    true,
  );
  const failures = new Map((Array.isArray(res.data) ? res.data : []).map((f) => [String(f.imei), f]));
  await logAction({ action: 'ENROL', result: res, actorId, response: { count: eligible.length, failures: [...failures.values()] } });

  for (const item of eligible) {
    const failure = failures.get(item.serialNumber);
    // A whole-request failure (not 50021 "some failed") fails every IMEI.
    const failedAll = !res.success && res.code !== '50021';
    if (failure || failedAll) {
      results.push({
        inventoryItemId: item.id,
        imei: item.serialNumber,
        ok: false,
        message: failure ? describeCode(failure.errCode, failure.message) : res.error || 'Enrolment failed',
      });
      continue;
    }
    const device = await prisma.payTriggerDevice.upsert({
      where: { inventoryItemId: item.id },
      create: { inventoryItemId: item.id, imei: item.serialNumber, contractId: item.contractId, orderRef: item.id, enrollmentStatus: 'QUEUED' },
      update: { enrollmentStatus: 'QUEUED', lastError: null },
    });
    await logAction({ deviceId: device.id, contractId: item.contractId, action: 'ENROL', result: res, actorId });
    if (item.contractId) {
      addTranssionContract(item.contractId);
      enqueue(item.contractId, 'DEVICE_ENROLLED').catch(() => undefined);
    }
    results.push({
      inventoryItemId: item.id,
      imei: item.serialNumber,
      ok: true,
      message: (res.dryRun ? 'Enrolled (dry run). ' : 'Enrolled. ') + (notes.get(item.id) || ''),
    });
  }
  return results;
}

export async function cancelEnrolment(deviceId: string, actorId: string) {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error('Device not found');
  if (device.enrollmentStatus !== 'QUEUED') throw new Error('Only a phone that has not activated can be cancelled.');
  const res = await client.cancelEnrolment([device.imei]);
  await logAction({ deviceId, contractId: device.contractId, action: 'CANCEL', result: res, actorId });
  if (!res.success) throw new Error(res.error || 'Cancel failed');
  await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { enrollmentStatus: 'CANCELLED' } });
  return { dryRun: res.dryRun };
}

// ─── Reconcile / PIN / release ─────────────────────────────────────────────

export async function reconcileNow(deviceId: string, actorId: string) {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device?.contractId) throw new Error('Device is not linked to a contract.');
  return reconcileContract(device.contractId, { reasons: ['ADMIN_RECONCILE'], actorId, force: true });
}

/**
 * Offline unlock. The PIN carries whatever lock date PayTrigger holds when it
 * is generated, so push the contract's current date first, then refuse if that
 * date is still in the past — a PIN for a past date unlocks nothing.
 */
export async function issuePin(deviceId: string, actor: { id: string; role: string }, keyCode?: string) {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error('Device not found');
  if (device.enrollmentStatus !== 'ACTIVE') throw new Error('The phone has not activated on PayTrigger yet.');
  if (!device.contractId) throw new Error('Device is not linked to a contract.');

  const outcome = await reconcileContract(device.contractId, { reasons: ['ADMIN_RECONCILE'], actorId: actor.id, force: true });
  const fresh = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!fresh?.providerExpiresAt || fresh.providerExpiresAt.getTime() <= Date.now() + 60_000) {
    const why = outcome.decision ? outcome.decision.reason : outcome.skipped || 'No future lock date';
    throw new Error(`No PIN issued: the contract does not allow the phone to open (${why}).`);
  }

  const res = await client.issuePin({ imei: device.imei, deviceTag: device.deviceTag, captcha: keyCode?.trim() || undefined });
  const lastPayment = await prisma.paymentTransaction
    .findFirst({ where: { contractId: device.contractId }, orderBy: { createdAt: 'desc' }, select: { id: true, amount: true, createdAt: true } })
    .catch(() => null);
  await logAction({
    deviceId,
    contractId: device.contractId,
    action: 'PIN',
    result: { ...res, data: res.data ? { issued: true } : undefined } as any, // never store the code itself
    actorId: actor.id,
    response: { role: actor.role, followedPayment: lastPayment, opensUntil: fresh.providerExpiresAt },
  });

  if (!res.success) {
    if (res.code === '50063') return { needsKeyCode: true, error: describeCode('50063') };
    throw new Error(res.error || 'PIN request failed');
  }
  await prisma.payTriggerDevice.update({
    where: { id: deviceId },
    data: { pinUnlocksUsed: { increment: 1 }, awaitingPinSince: null },
  });
  return { pin: res.data?.verifyCode, opensUntil: fresh.providerExpiresAt, dryRun: res.dryRun };
}

export async function releaseNow(deviceId: string, confirmation: string, actorId: string) {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error('Device not found');
  if (device.enrollmentStatus !== 'ACTIVE') throw new Error('Only an active phone can be released.');
  if (confirmation.trim().toUpperCase() !== 'RELEASE') {
    throw new Error('Type RELEASE to confirm.');
  }
  const contract = device.contractId
    ? await prisma.hirePurchaseContract.findUnique({ where: { id: device.contractId }, select: { id: true, contractNumber: true } })
    : null;
  const ok = await releaseDevice(device, contract, actorId);
  if (!ok) throw new Error('PayTrigger did not accept the release. See the device timeline.');
  return { released: true };
}

export async function setReleaseHold(deviceId: string, held: boolean, actorId: string) {
  const device = await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { releaseHeld: held } });
  await logAction({ deviceId, contractId: device.contractId, action: held ? 'RELEASE_HELD' : 'RELEASE_UNHELD', success: true, dryRun: false, actorId });
  return device;
}

// ─── Issues ────────────────────────────────────────────────────────────────

export async function getIssues() {
  const now = Date.now();
  const settings = await getPayTriggerSettings();
  const devices = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: { in: ['QUEUED', 'ACTIVE', 'UNENFORCEABLE'] } } });
  const contractIds = devices.map((d) => d.contractId).filter((id): id is string => !!id);
  const contracts = await prisma.hirePurchaseContract.findMany({
    where: { id: { in: contractIds } },
    select: {
      id: true,
      contractNumber: true,
      status: true,
      approvedAt: true,
      customer: { select: { firstName: true, lastName: true, phone: true } },
      createdBy: { select: { firstName: true, lastName: true, phone: true } },
      agentLedger: { select: { outstandingBalance: true, createdAt: true } },
      payments: { orderBy: { createdAt: 'desc' }, take: 1, select: { amount: true, createdAt: true } },
    },
  });
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const row = (d: (typeof devices)[number]) => {
    const c = d.contractId ? byId.get(d.contractId) : undefined;
    return {
      deviceId: d.id,
      imei: d.imei,
      contractId: c?.id ?? null,
      contractNumber: c?.contractNumber ?? null,
      customer: c ? `${c.customer.firstName} ${c.customer.lastName}` : null,
      customerPhone: c?.customer.phone ?? null,
      agent: c ? `${c.createdBy.firstName} ${c.createdBy.lastName}` : null,
      agentPhone: c?.createdBy.phone ?? null,
      lastPayment: c?.payments[0] ?? null,
      apkVersion: d.apkVersion,
      needsKeyCode: needsKeyCode(d.apkVersion),
      lastError: d.lastError,
      lastConnectAt: d.lastConnectAt,
    };
  };

  const paidStillLocked = devices
    .filter((d) => d.awaitingPinSince)
    .sort((a, b) => a.awaitingPinSince!.getTime() - b.awaitingPinSince!.getTime())
    .map((d) => ({ ...row(d), waitingMinutes: Math.round((now - d.awaitingPinSince!.getTime()) / 60000) }));

  const heldForDeposit = devices
    .filter((d) => d.holdMessageShown || (d.contractId && (byId.get(d.contractId)?.agentLedger?.outstandingBalance ?? 0) > 0.005))
    .map((d) => {
      const c = byId.get(d.contractId!);
      return {
        ...row(d),
        amount: c?.agentLedger?.outstandingBalance ?? null,
        days: c?.approvedAt ? Math.floor((now - c.approvedAt.getTime()) / 86400_000) : null,
      };
    });

  const ledgerMissing = contracts
    .filter((c) => c.status === 'ACTIVE' && c.approvedAt && !c.agentLedger && now - c.approvedAt.getTime() > 3600_000)
    .map((c) => ({ contractId: c.id, contractNumber: c.contractNumber, approvedAt: c.approvedAt }));

  const unconfirmedLocks = devices
    .filter((d) => d.enrollmentStatus === 'ACTIVE' && d.scheduleExpiresAt && d.scheduleExpiresAt.getTime() < now - 86400_000 && d.committedState !== 'LOCKED' && !d.awaitingPinSince)
    .map(row);

  const unenforceable = devices.filter((d) => d.enrollmentStatus === 'UNENFORCEABLE').map(row);
  const failing = devices.filter((d) => d.lastError).map(row);
  const stale = devices
    .filter((d) => d.enrollmentStatus === 'ACTIVE' && d.lastConnectAt && now - d.lastConnectAt.getTime() > 14 * 86400_000)
    .map(row);

  const sweepLate = !settings.lastSweepAt || now - settings.lastSweepAt.getTime() > 26 * 3600_000;
  return {
    paidStillLocked,
    heldForDeposit,
    ledgerMissing,
    unconfirmedLocks,
    unenforceable,
    failing,
    stale,
    sweep: { lastSweepAt: settings.lastSweepAt, late: sweepLate, summary: settings.lastSweepSummary },
    counts: {
      paidStillLocked: paidStillLocked.length,
      total: paidStillLocked.length + ledgerMissing.length + unconfirmedLocks.length + unenforceable.length + failing.length + (sweepLate ? 1 : 0),
    },
  };
}
