import { Request, Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import * as client from '../services/payTrigger/client';
import { PAYTRIGGER_API_KEY, getConfigurationSummary } from '../services/payTrigger/config';
import { verifyCallback } from '../services/payTrigger/sign';
import { spoolCallback, processCallback } from '../services/payTrigger/callbacks';
import { registryLoaded, registrySize } from '../services/payTrigger/registry';
import { EDITABLE_SETTINGS, getPayTriggerSettings, invalidatePayTriggerSettings } from '../services/payTrigger/settings';
import * as admin from '../services/payTrigger/admin';
import sharp from 'sharp';
import { uploadToSupabase } from '../services/storageService';

/**
 * PayTrigger HTTP API, mounted at /api/paytrigger. Every route is new; none
 * of the Knox routes are touched.
 */

const actor = (req: AuthenticatedRequest) => req.user as AdminUserPayload;
const fail = (res: Response, err: unknown, status = 400) =>
  res.status(status).json({ error: (err as Error)?.message || 'PayTrigger request failed' });

/** PIN unlock is for administrators by role, whatever permissions a custom role carries. */
const PIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

// ─── Webhook ───────────────────────────────────────────────────────────────

/**
 * PayTrigger re-sends a callback until it is answered with exactly
 * {"code":200,"message":"Success"}, so that is always the reply. A body that
 * fails the signature check is recorded but never acted on.
 */
export async function handlePayTriggerWebhook(req: Request, res: Response): Promise<void> {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  try {
    const signed = verifyCallback(req.header('sign') || undefined, body, PAYTRIGGER_API_KEY);
    if (!signed) {
      await prisma.payTriggerWebhookEvent
        .create({ data: { dedupeKey: `unsigned:${Date.now()}:${Math.random()}`, notifyType: String(body.notifyType ?? ''), body, error: 'Signature check failed — not processed' } })
        .catch(() => undefined);
    } else {
      const id = await spoolCallback(body);
      setImmediate(() => {
        processCallback(id).catch((err) => console.error('PayTrigger: callback processing failed', err));
      });
    }
  } catch (err) {
    console.error('PayTrigger: webhook spool failed', err);
  }
  res.status(200).json({ code: 200, message: 'Success' });
}

// ─── Overview ──────────────────────────────────────────────────────────────

export async function getHealth(_req: AuthenticatedRequest, res: Response) {
  try {
    const settings = await getPayTriggerSettings();
    const counts = await prisma.payTriggerDevice.groupBy({ by: ['enrollmentStatus'], _count: true });
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const eventsToday = await prisma.payTriggerActionLog.count({ where: { createdAt: { gte: since } } });
    const issues = await admin.getIssues();
    res.json({
      config: getConfigurationSummary(),
      registry: { loaded: registryLoaded(), contracts: registrySize() },
      devices: Object.fromEntries(counts.map((c) => [c.enrollmentStatus, c._count])),
      lastSweepAt: settings.lastSweepAt,
      lastSweepSummary: settings.lastSweepSummary,
      sweepLate: issues.sweep.late,
      eventsToday,
      paidStillLocked: issues.counts.paidStillLocked,
      openIssues: issues.counts.total,
    });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function getLicence(_req: AuthenticatedRequest, res: Response) {
  const result = await client.checkLicence();
  if (!result.success) return fail(res, result.error, 502);
  res.json({ dryRun: result.dryRun, ...(result.data || {}) });
}

export async function getIssues(_req: AuthenticatedRequest, res: Response) {
  try {
    res.json(await admin.getIssues());
  } catch (err) {
    fail(res, err, 500);
  }
}

// ─── Devices ───────────────────────────────────────────────────────────────

export async function listDevices(req: AuthenticatedRequest, res: Response) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const devices = await prisma.payTriggerDevice.findMany({
      where: {
        ...(status ? { enrollmentStatus: status } : {}),
        ...(search ? { imei: { contains: search } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });
    const contractIds = devices.map((d) => d.contractId).filter((id): id is string => !!id);
    const contracts = await prisma.hirePurchaseContract.findMany({
      where: { id: { in: contractIds } },
      select: { id: true, contractNumber: true, status: true, customer: { select: { firstName: true, lastName: true, phone: true } } },
    });
    const byId = new Map(contracts.map((c) => [c.id, c]));
    let rows = devices.map((d) => {
      const c = d.contractId ? byId.get(d.contractId) : undefined;
      return {
        ...d,
        contractNumber: c?.contractNumber ?? null,
        contractStatus: c?.status ?? null,
        customer: c ? `${c.customer.firstName} ${c.customer.lastName}` : null,
        customerPhone: c?.customer.phone ?? null,
      };
    });
    if (search) {
      const extra = await prisma.hirePurchaseContract.findMany({
        where: { OR: [{ contractNumber: { contains: search, mode: 'insensitive' } }, { customer: { lastName: { contains: search, mode: 'insensitive' } } }] },
        select: { id: true },
        take: 50,
      });
      if (extra.length && rows.length === 0) {
        const more = await prisma.payTriggerDevice.findMany({ where: { contractId: { in: extra.map((e) => e.id) } } });
        rows = more.map((d) => ({ ...d, contractNumber: null, contractStatus: null, customer: null, customerPhone: null }));
      }
    }
    res.json({ devices: rows });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function getDevice(req: AuthenticatedRequest, res: Response) {
  try {
    const device = await prisma.payTriggerDevice.findUnique({ where: { id: String(req.params.id) } });
    if (!device) return fail(res, new Error('Device not found'), 404);
    const [contract, logs, commands] = await Promise.all([
      device.contractId
        ? prisma.hirePurchaseContract.findUnique({
            where: { id: device.contractId },
            select: {
              id: true, contractNumber: true, status: true, totalPrice: true, totalPaid: true, outstandingBalance: true,
              customer: { select: { firstName: true, lastName: true, phone: true } },
              createdBy: { select: { firstName: true, lastName: true, phone: true } },
              agentLedger: { select: { outstandingBalance: true, status: true } },
              inventoryItem: { select: { product: { select: { name: true } } } },
            },
          })
        : null,
      prisma.payTriggerActionLog.findMany({ where: { deviceId: device.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.payTriggerCommand.findMany({ where: { deviceId: device.id }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    const role = actor(req).role;
    const proof = await admin.liveEnrolmentProof([device.id]);
    res.json({
      device: {
        ...device,
        needsKeyCode: admin.needsKeyCode(device.apkVersion),
        enrolledLive: proof.has(device.id),
        needsEnrolment: admin.needsEnrolment(device, proof),
      },
      contract,
      logs,
      commands,
      canIssuePin: PIN_ROLES.has(role),
    });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function reconcileDevice(req: AuthenticatedRequest, res: Response) {
  try {
    res.json(await admin.reconcileNow(String(req.params.id), actor(req).id));
  } catch (err) {
    fail(res, err);
  }
}

export async function issuePin(req: AuthenticatedRequest, res: Response) {
  const user = actor(req);
  if (!PIN_ROLES.has(user.role)) {
    res.status(403).json({ error: 'Only an Admin or Super Admin can issue an unlock PIN.' });
    return;
  }
  try {
    const keyCode = typeof req.body?.keyCode === 'string' ? req.body.keyCode : undefined;
    if (keyCode && !/^\d{4}$/.test(keyCode.trim())) return fail(res, new Error('The key on the lock screen is 4 digits.'));
    const result = await admin.issuePin(String(req.params.id), { id: user.id, role: user.role }, keyCode);
    await createAuditLog({
      userId: user.id,
      action: 'PAYTRIGGER_PIN_ISSUED',
      entity: 'PayTriggerDevice',
      entityId: String(req.params.id),
      newValues: { opensUntil: (result as any).opensUntil ?? null, needsKeyCode: (result as any).needsKeyCode ?? false },
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
}

export async function releaseDevice(req: AuthenticatedRequest, res: Response) {
  try {
    const result = await admin.releaseNow(String(req.params.id), String(req.body?.confirmation || ''), actor(req).id);
    await createAuditLog({ userId: actor(req).id, action: 'PAYTRIGGER_RELEASE', entity: 'PayTriggerDevice', entityId: String(req.params.id), ipAddress: req.ip });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
}

export async function holdRelease(req: AuthenticatedRequest, res: Response) {
  try {
    res.json(await admin.setReleaseHold(String(req.params.id), req.body?.held !== false, actor(req).id));
  } catch (err) {
    fail(res, err);
  }
}

export async function cancelEnrolment(req: AuthenticatedRequest, res: Response) {
  try {
    res.json(await admin.cancelEnrolment(String(req.params.id), actor(req).id));
  } catch (err) {
    fail(res, err);
  }
}

// ─── Enrolment / products ──────────────────────────────────────────────────

export async function getEnrolmentCandidates(_req: AuthenticatedRequest, res: Response) {
  try {
    res.json({ candidates: await admin.enrolmentCandidates() });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function enrolDevices(req: AuthenticatedRequest, res: Response) {
  const ids = Array.isArray(req.body?.inventoryItemIds) ? req.body.inventoryItemIds.filter((x: unknown) => typeof x === 'string') : [];
  if (!ids.length) return fail(res, new Error('Choose at least one phone.'));
  if (ids.length > 500) return fail(res, new Error('At most 500 phones at a time.'));
  try {
    // From the inventory form: mark the product as Transsion first, so a
    // TECNO/Infinix/itel model not yet on the Products screen can be enrolled.
    if (req.body?.markProducts === true) {
      const items = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { productId: true } });
      const marked = await admin.markProducts([...new Set(items.map((i) => i.productId))], actor(req).id);
      if (marked) await createAuditLog({ userId: actor(req).id, action: 'PAYTRIGGER_PRODUCTS', entity: 'PayTriggerProduct', newValues: { markedFromInventory: marked }, ipAddress: req.ip });
    }
    const results = await admin.enrolItems(ids, actor(req).id);
    await createAuditLog({ userId: actor(req).id, action: 'PAYTRIGGER_ENROL', entity: 'PayTriggerDevice', newValues: { requested: ids.length, enrolled: results.filter((r) => r.ok).length }, ipAddress: req.ip });
    res.json({ results });
  } catch (err) {
    fail(res, err);
  }
}

export async function getProducts(_req: AuthenticatedRequest, res: Response) {
  try {
    res.json({ products: await admin.listProducts() });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function putProducts(req: AuthenticatedRequest, res: Response) {
  const ids = Array.isArray(req.body?.productIds) ? req.body.productIds.filter((x: unknown) => typeof x === 'string') : null;
  if (!ids) return fail(res, new Error('productIds is required'));
  try {
    const products = await admin.setProducts(ids, actor(req).id);
    await createAuditLog({ userId: actor(req).id, action: 'PAYTRIGGER_PRODUCTS', entity: 'PayTriggerProduct', newValues: { productIds: ids }, ipAddress: req.ip });
    res.json({ products });
  } catch (err) {
    fail(res, err);
  }
}

// ─── Settings / ladder / branding ──────────────────────────────────────────

const INT_RANGES: Record<string, [number, number]> = {
  defaultRuleNum: [0, 5],
  lockAfterOverdueDays: [0, 30],
  maxUnlockHorizonDays: [7, 120],
  releaseHoldHours: [0, 720],
  extendBreakerPercent: [1, 100],
};

export async function getSettings(_req: AuthenticatedRequest, res: Response) {
  try {
    res.json({ settings: await getPayTriggerSettings(), config: getConfigurationSummary() });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function putSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const before = await getPayTriggerSettings();
    const data: Record<string, unknown> = {};
    for (const key of EDITABLE_SETTINGS) {
      if (!(key in (req.body || {}))) continue;
      const value = req.body[key];
      if (key in INT_RANGES) {
        const [min, max] = INT_RANGES[key];
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) return fail(res, new Error(`${key} must be a whole number from ${min} to ${max}.`));
        data[key] = n;
      } else if (key === 'lockOnUnpaidAgentDeposit' || key === 'holdOnUnpaidPenalties') {
        data[key] = Boolean(value);
      } else {
        const text = value === null || value === undefined ? null : String(value).trim();
        if ((key === 'depositHoldTitle' || key === 'depositHoldTips') && !text) return fail(res, new Error(`${key} cannot be empty.`));
        if (text && text.length > 400) return fail(res, new Error(`${key} is limited to 400 characters.`));
        data[key] = text || null;
      }
    }
    const settings = await prisma.payTriggerSettings.update({ where: { id: 'singleton' }, data: { ...data, updatedById: actor(req).id } });
    invalidatePayTriggerSettings();
    await createAuditLog({
      userId: actor(req).id,
      action: 'PAYTRIGGER_SETTINGS',
      entity: 'PayTriggerSettings',
      oldValues: Object.fromEntries(Object.keys(data).map((k) => [k, (before as any)[k]])),
      newValues: data,
      ipAddress: req.ip,
    });
    res.json({ settings });
  } catch (err) {
    fail(res, err);
  }
}

const STAGES = ['watermark', 'autoPopup', 'callsOut', 'callsIn', 'sms', 'apps', 'screen'] as const;

export const DEFAULT_LADDER: client.Ladder = {
  ruleNum: 0,
  description: 'Standard',
  watermark: { enabled: true, afterDays: 0, text: 'Payment overdue — pay now to keep full use of your phone.' },
  autoPopup: { enabled: true, afterDays: 0, title: 'Payment overdue', text: 'Your instalment is overdue. Pay by Mobile Money to avoid restrictions.' },
  callsOut: { enabled: false, afterDays: 7 },
  callsIn: { enabled: false, afterDays: 14 },
  sms: { enabled: false, afterDays: 7 },
  apps: { enabled: true, afterDays: 2 },
  screen: { enabled: true, afterDays: 3, title: 'Phone locked — payment overdue', text: 'Pay your instalment to unlock. Call your agent if you need help.' },
};

export async function getLadder(_req: AuthenticatedRequest, res: Response) {
  try {
    const settings = await getPayTriggerSettings();
    res.json({ ladder: (settings.ladder as unknown as client.Ladder) || DEFAULT_LADDER, saved: !!settings.ladder });
  } catch (err) {
    fail(res, err, 500);
  }
}

export async function putLadder(req: AuthenticatedRequest, res: Response) {
  const body = req.body || {};
  const ruleNum = Number(body.ruleNum ?? 0);
  if (!Number.isInteger(ruleNum) || ruleNum < 0 || ruleNum > 5) return fail(res, new Error('ruleNum must be 0–5.'));
  const ladder: client.Ladder = { ruleNum, description: typeof body.description === 'string' ? body.description.slice(0, 100) : undefined } as client.Ladder;
  for (const stage of STAGES) {
    const s = body[stage] || {};
    const afterDays = Number(s.afterDays ?? 0);
    if (!Number.isInteger(afterDays) || afterDays < 0 || afterDays > 90) return fail(res, new Error(`${stage}: days after due must be 0–90.`));
    ladder[stage] = {
      enabled: Boolean(s.enabled),
      afterDays,
      title: typeof s.title === 'string' ? s.title.slice(0, 80) : undefined,
      text: typeof s.text === 'string' ? s.text.slice(0, 400) : undefined,
    };
  }
  const result = await client.updateLadder(ladder);
  if (!result.success) return fail(res, result.error, 502);
  await prisma.payTriggerSettings.update({ where: { id: 'singleton' }, data: { ladder: ladder as any, updatedById: actor(req).id } });
  invalidatePayTriggerSettings();
  await createAuditLog({ userId: actor(req).id, action: 'PAYTRIGGER_LADDER', entity: 'PayTriggerSettings', newValues: ladder as any, ipAddress: req.ip });
  res.json({ ladder, dryRun: result.dryRun });
}

export async function putBranding(req: AuthenticatedRequest, res: Response) {
  const b = req.body || {};
  const numbers = Array.isArray(b.customerServiceNumbers)
    ? b.customerServiceNumbers.filter((n: any) => n && typeof n.number === 'string').map((n: any) => ({ countryName: String(n.countryName || 'Ghana'), number: n.number.trim() }))
    : undefined;
  const result = await client.updateBranding({
    companyName: typeof b.companyName === 'string' ? b.companyName.trim() : undefined,
    logoUrl: typeof b.logoUrl === 'string' ? b.logoUrl.trim() : undefined,
    callInPhoneNum: typeof b.callInPhoneNum === 'string' ? b.callInPhoneNum.trim() : undefined,
    callOutPhoneNum: typeof b.callOutPhoneNum === 'string' ? b.callOutPhoneNum.trim() : undefined,
    customerServiceNumbers: numbers,
  });
  if (!result.success) return fail(res, result.error, 502);
  await createAuditLog({ userId: actor(req).id, action: 'PAYTRIGGER_BRANDING', entity: 'PayTriggerSettings', newValues: b, ipAddress: req.ip });
  res.json({ ok: true, dryRun: result.dryRun });
}

/**
 * POST /paytrigger/branding/logo  (multipart, field "logo")
 *
 * PayTrigger shows the company logo in its app and wants a PNG of at most
 * 512×512 pixels and 50 KB, at a public address. Any JPEG or PNG chosen here
 * is fitted to that — resized, converted to PNG and compressed until it fits —
 * then stored publicly. The address comes back for the branding form; nothing
 * is sent to PayTrigger until "Send branding" is pressed.
 */
const LOGO_MAX_BYTES = 50 * 1024;

/** Resize and compress until the PNG is within PayTrigger's 512×512 and 50 KB, or give up. */
export async function fitPayTriggerLogo(input: Buffer): Promise<Buffer | null> {
  for (const size of [512, 384, 256, 192, 128]) {
    for (const colours of [256, 128, 64]) {
      const out = await sharp(input)
        .rotate()
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true, colours })
        .toBuffer();
      if (out.length <= LOGO_MAX_BYTES) return out;
    }
  }
  return null;
}

export async function uploadBrandingLogo(req: AuthenticatedRequest, res: Response) {
  const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, new Error('Choose a PNG or JPEG image.'));
  try {
    const meta = await sharp(file.buffer).metadata();
    if (!meta.width || !meta.height) return fail(res, new Error('That file is not an image PayTrigger can use.'));

    const png = await fitPayTriggerLogo(file.buffer);
    if (!png) return fail(res, new Error('This image is too detailed to fit in 50 KB. Try a simpler logo.'));

    const uploaded = await uploadToSupabase(png, 'paytrigger', 'logo.png');
    if (!uploaded.success || !uploaded.publicUrl) return fail(res, new Error(uploaded.error || 'Upload failed'), 502);

    const final = await sharp(png).metadata();
    await createAuditLog({
      userId: actor(req).id,
      action: 'PAYTRIGGER_LOGO_UPLOADED',
      entity: 'PayTriggerSettings',
      newValues: { url: uploaded.publicUrl, bytes: png.length, width: final.width, height: final.height },
      ipAddress: req.ip,
    });
    res.json({ url: uploaded.publicUrl, bytes: png.length, width: final.width, height: final.height });
  } catch (err) {
    fail(res, err);
  }
}

/** GET /paytrigger/lock-provider?productId=&imei= — which lock the inventory form should suggest. */
export async function getLockProvider(req: AuthenticatedRequest, res: Response) {
  const productId = typeof req.query.productId === 'string' ? req.query.productId : '';
  if (!productId) return fail(res, new Error('productId is required'));
  try {
    const imei = typeof req.query.imei === 'string' ? req.query.imei : null;
    res.json(await admin.detectLockProvider(productId, imei));
  } catch (err) {
    fail(res, err, 404);
  }
}

/** POST /paytrigger/devices/:id/verify — check the phone against what PayTrigger holds. */
export async function verifyDevice(req: AuthenticatedRequest, res: Response) {
  try {
    res.json(await admin.verifyDevice(String(req.params.id), actor(req).id));
  } catch (err) {
    fail(res, err);
  }
}
