import { PAYTRIGGER_APP_PACKAGE } from './config';
import prisma from '../../config/database';
import * as client from './client';
import { describeCode } from './errors';
import { enqueue } from './events';
import { applyLockState, reconcileContract, sendUnlinkedMessage } from './reconcile';
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

/**
 * PayTrigger details for a page of inventory items, for the inventory table.
 * A product marked as Transsion, or an item already enrolled, is a PayTrigger
 * item; everything else keeps the Knox columns it had. Never throws: the
 * inventory page must load even if PayTrigger's tables are unavailable.
 */
export async function payTriggerInfoForItems(items: Array<{ id: string; productId: string }>) {
  const empty = new Map<string, { lockProvider: 'PAYTRIGGER' | 'KNOX'; payTrigger: Record<string, unknown> | null; needsEnrolment: boolean }>();
  try {
    if (!items.length) return empty;
    const [devices, marked] = await Promise.all([
      prisma.payTriggerDevice.findMany({
        where: { inventoryItemId: { in: items.map((i) => i.id) } },
        select: {
          id: true, inventoryItemId: true, enrollmentStatus: true, committedState: true, providerExpiresAt: true,
          awaitingPinSince: true, holdMessageShown: true, releaseAfter: true, apkVersion: true, contractId: true, lastError: true,
        },
      }),
      prisma.payTriggerProduct.findMany({ where: { productId: { in: [...new Set(items.map((i) => i.productId))] } }, select: { productId: true } }),
    ]);
    const deviceByItem = new Map(devices.map((d) => [d.inventoryItemId, d]));
    const liveProof = await liveEnrolmentProof(devices.map((d) => d.id));
    const markedProducts = new Set(marked.map((m) => m.productId));
    for (const item of items) {
      const device = deviceByItem.get(item.id);
      const isPt = !!device || markedProducts.has(item.productId);
      empty.set(item.id, {
        lockProvider: isPt ? 'PAYTRIGGER' : 'KNOX',
        payTrigger: device
          ? {
              ...device,
              needsKeyCode: needsKeyCode(device.apkVersion),
              enrolledLive: liveProof.has(device.id),
              needsEnrolment: needsEnrolment(device, liveProof),
            }
          : null,
        needsEnrolment: isPt ? needsEnrolment(device, liveProof) : false,
      });
    }
    return empty;
  } catch (err) {
    console.error('PayTrigger: inventory lookup failed', (err as Error)?.message || err);
    return empty;
  }
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

  const existing = new Map(
    (await prisma.payTriggerDevice.findMany({ where: { inventoryItemId: { in: items.map((i) => i.id) } } })).map((d) => [d.inventoryItemId, d]),
  );
  const eligible = items.filter((item) => {
    const current = existing.get(item.id);
    if (current && ['ACTIVE', 'UNENFORCEABLE', 'REMOVED'].includes(current.enrollmentStatus)) {
      results.push({ inventoryItemId: item.id, imei: item.serialNumber, ok: false, message: 'Already active on PayTrigger — use Verify instead.' });
      return false;
    }
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
    eligible.map((item) => ({ imei: item.serialNumber, orderNum: item.id, ruleNum: settings.defaultRuleNum, deeplink: settings.payDeeplink || undefined, deeplinkPkg: settings.payDeeplink ? PAYTRIGGER_APP_PACKAGE : undefined })),
    true,
  );
  const failures = new Map((Array.isArray(res.data) ? res.data : []).map((f) => [String(f.imei), f]));
  await logAction({ action: 'ENROL', result: res, actorId, response: { count: eligible.length, failures: [...failures.values()] } });

  for (const item of eligible) {
    let failure = failures.get(item.serialNumber);
    // 50015: PayTrigger already holds this IMEI — the goal is met.
    const alreadyThere = failure && String(failure.errCode) === '50015';
    if (alreadyThere) failure = undefined;
    // A whole-request failure (not 50021 "some failed") fails every IMEI.
    const failedAll = !res.success && res.code !== '50021';
    if (failure || failedAll) {
      const message = failure ? describeCode(failure.errCode, failure.message) : res.error || 'Enrolment failed';
      // Keep the failure on record, so inventory shows it and offers "Enrol again".
      const failed = await prisma.payTriggerDevice.upsert({
        where: { inventoryItemId: item.id },
        create: { inventoryItemId: item.id, imei: item.serialNumber, contractId: item.contractId, orderRef: item.id, enrollmentStatus: 'FAILED', lastError: message },
        update: { enrollmentStatus: 'FAILED', lastError: message },
      });
      await logAction({ deviceId: failed.id, contractId: item.contractId, action: 'ENROL', result: res, success: false, skippedReason: message, actorId });
      results.push({ inventoryItemId: item.id, imei: item.serialNumber, ok: false, message });
      continue;
    }
    const device = await prisma.payTriggerDevice.upsert({
      where: { inventoryItemId: item.id },
      create: { inventoryItemId: item.id, imei: item.serialNumber, contractId: item.contractId, orderRef: item.id, enrollmentStatus: 'QUEUED' },
      update: { enrollmentStatus: 'QUEUED', lastError: null },
    });
    // This phone's own outcome — in a batch where another IMEI was refused,
    // the request as a whole reports 50021 even though this one went through.
    await logAction({ deviceId: device.id, contractId: item.contractId, action: 'ENROL', result: res, success: true, actorId });
    if (item.contractId) {
      addTranssionContract(item.contractId);
      enqueue(item.contractId, 'DEVICE_ENROLLED').catch(() => undefined);
    }
    results.push({
      inventoryItemId: item.id,
      imei: item.serialNumber,
      ok: true,
      message: (res.dryRun ? 'Enrolled (dry run — simulated only). ' : alreadyThere ? 'Already enrolled on PayTrigger. ' : 'Enrolled. ') + (notes.get(item.id) || ''),
    });
  }
  return results;
}

/**
 * Which devices PayTrigger really holds: an enrolment counts only if a live
 * (not dry-run) ENROL or VERIFY succeeded for it.
 */
export async function liveEnrolmentProof(deviceIds: string[]): Promise<Set<string>> {
  if (!deviceIds.length) return new Set();
  const rows = await prisma.payTriggerActionLog.findMany({
    where: { deviceId: { in: deviceIds }, action: { in: ['ENROL', 'VERIFY', 'ACTIVATED'] }, success: true, dryRun: false },
    select: { deviceId: true },
    distinct: ['deviceId'],
  });
  return new Set(rows.map((r) => r.deviceId!).filter(Boolean));
}

/** Enrolment needs (re)doing: never sent, failed, cancelled, or only simulated in dry run. */
export function needsEnrolment(device: { id: string; enrollmentStatus: string } | null | undefined, liveProof: Set<string>): boolean {
  if (!device) return true;
  if (device.enrollmentStatus === 'FAILED' || device.enrollmentStatus === 'CANCELLED') return true;
  return device.enrollmentStatus === 'QUEUED' && !liveProof.has(device.id);
}

/**
 * Ask PayTrigger what it holds for this phone and bring our record in line:
 * unknown IMEI → marked FAILED (offer to enrol again); pre-enrolled → confirmed;
 * active → ACTIVE with its lock state; removable → REMOVED.
 */
export async function verifyDevice(deviceId: string, actorId: string) {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new Error('Device not found');
  const res = await client.getDevice(device.imei);

  if (res.dryRun) {
    await logAction({ deviceId, contractId: device.contractId, action: 'VERIFY', result: res, success: false, skippedReason: 'Dry run — nothing to check against.', actorId });
    return {
      status: 'DRY_RUN' as const,
      message: 'PayTrigger is in dry run, so the enrolment was only simulated and cannot be checked. Enrol again once live mode is on.',
    };
  }
  if (!res.success) {
    const unknown = ['20001', '50051', '50071'].includes(String(res.code));
    if (unknown) {
      await prisma.payTriggerDevice.update({
        where: { id: deviceId },
        data: device.enrollmentStatus === 'QUEUED' || device.enrollmentStatus === 'FAILED'
          ? { enrollmentStatus: 'FAILED', lastError: 'PayTrigger does not have this IMEI. Enrol it again.' }
          : { lastError: 'PayTrigger does not have this IMEI.' },
      });
    }
    await logAction({ deviceId, contractId: device.contractId, action: 'VERIFY', result: res, actorId });
    return unknown
      ? { status: 'NOT_REGISTERED' as const, message: 'PayTrigger does not have this IMEI. Enrol it again.' }
      : { status: 'ERROR' as const, message: res.error || 'PayTrigger could not be reached. Try again later.' };
  }

  const info = res.data || {};
  const serverState = Number(info.serverState ?? info.lockState);
  let status: 'WAITING' | 'ACTIVE' | 'REMOVED';
  let message: string;
  if (serverState === 5000) {
    await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { enrollmentStatus: 'REMOVED', committedState: 'UNLOCKED', lastError: null, deviceTag: info.deviceTag || device.deviceTag } });
    status = 'REMOVED';
    message = 'PayTrigger has released this phone.';
  } else if (serverState === 3000) {
    if (device.enrollmentStatus !== 'ACTIVE') {
      await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { enrollmentStatus: 'ACTIVE', licenceConsumedAt: device.licenceConsumedAt ?? new Date() } });
    }
    const lock = await client.findLockState(device);
    if (lock.success && !lock.dryRun && lock.data) await applyLockState(deviceId, lock.data);
    await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { lastError: null, deviceTag: info.deviceTag || device.deviceTag } });
    status = 'ACTIVE';
    message = 'Enrolled and active on PayTrigger.';
    if (device.contractId) enqueue(device.contractId, 'ADMIN_RECONCILE').catch(() => undefined);
    else {
      // Active with no contract: it is locked, so make sure its screen says why.
      const text = await sendUnlinkedMessage(deviceId);
      if (text.sent) message += ' It has no contract, so the "no contract" message was sent to its lock screen.';
      else if (text.upToDate) message += ' It has no contract; its lock screen already carries the "no contract" message.';
      else if (text.error) message += ` It has no contract, but the "no contract" message was not accepted: ${text.error}`;
    }
  } else {
    await prisma.payTriggerDevice.update({
      where: { id: deviceId },
      data: { enrollmentStatus: device.enrollmentStatus === 'FAILED' ? 'QUEUED' : device.enrollmentStatus, lastError: null, deviceTag: info.deviceTag || device.deviceTag },
    });
    status = 'WAITING';
    message = 'Enrolled on PayTrigger, waiting for the phone to be switched on.';
  }
  await logAction({ deviceId, contractId: device.contractId, action: 'VERIFY', result: res, success: true, actorId, response: { serverState, status } });
  return { status, message };
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
  const devices = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: { in: ['QUEUED', 'ACTIVE', 'UNENFORCEABLE', 'FAILED'] } } });
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

  // Sold (or awaiting approval) on a Transsion product, but PayTrigger was
  // never given the phone — or the attempt failed — so nothing can lock it.
  const transsionProducts = (await prisma.payTriggerProduct.findMany({ select: { productId: true } })).map((p) => p.productId);
  const soldItems = transsionProducts.length
    ? await prisma.inventoryItem.findMany({
        where: { productId: { in: transsionProducts }, contract: { status: { in: ['ACTIVE', 'PENDING_APPROVAL', 'REVISION_REQUESTED'] } } },
        select: {
          id: true,
          serialNumber: true,
          contract: { select: { id: true, contractNumber: true, status: true, customer: { select: { firstName: true, lastName: true, phone: true } } } },
        },
      })
    : [];
  const soldDevices = new Map(
    (await prisma.payTriggerDevice.findMany({ where: { inventoryItemId: { in: soldItems.map((i) => i.id) } }, select: { inventoryItemId: true, enrollmentStatus: true } })).map((d) => [d.inventoryItemId, d.enrollmentStatus]),
  );
  const soldNotEnrolled = soldItems
    .filter((i) => !soldDevices.has(i.id) || ['FAILED', 'CANCELLED'].includes(soldDevices.get(i.id) as string))
    .map((i) => ({
      inventoryItemId: i.id,
      imei: i.serialNumber,
      contractId: i.contract?.id ?? null,
      contractNumber: i.contract?.contractNumber ?? null,
      contractStatus: i.contract?.status ?? null,
      customer: i.contract ? `${i.contract.customer.firstName} ${i.contract.customer.lastName}` : null,
      customerPhone: i.contract?.customer.phone ?? null,
      enrolment: soldDevices.get(i.id) ?? null,
    }));

  // Callbacks PayTrigger sent that we could not act on in the last two weeks —
  // most often a phone active on our account that we hold no record of.
  const strayEvents = await prisma.payTriggerWebhookEvent.findMany({
    where: { processedAt: null, error: { not: null }, createdAt: { gte: new Date(now - 14 * 86400_000) }, NOT: { dedupeKey: { startsWith: 'unsigned:' } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const callbackErrors = strayEvents.map((e) => ({
    id: e.id,
    imei: String((e.body as any)?.imei ?? ''),
    notifyType: e.notifyType,
    error: e.error,
    createdAt: e.createdAt,
  }));

  const sweepLate = !settings.lastSweepAt || now - settings.lastSweepAt.getTime() > 26 * 3600_000;
  return {
    paidStillLocked,
    heldForDeposit,
    ledgerMissing,
    unconfirmedLocks,
    unenforceable,
    failing,
    stale,
    soldNotEnrolled,
    callbackErrors,
    sweep: { lastSweepAt: settings.lastSweepAt, late: sweepLate, summary: settings.lastSweepSummary },
    counts: {
      paidStillLocked: paidStillLocked.length,
      total: paidStillLocked.length + ledgerMissing.length + unconfirmedLocks.length + unenforceable.length + failing.length + soldNotEnrolled.length + callbackErrors.length + (sweepLate ? 1 : 0),
    },
  };
}

/** Send the current "no contract" text to every active phone that has no contract. */
export async function resendUnlinkedMessages(): Promise<number> {
  const loose = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: 'ACTIVE', contractId: null }, select: { id: true } });
  let sent = 0;
  for (const { id } of loose) if ((await sendUnlinkedMessage(id)).sent) sent++;
  return sent;
}
