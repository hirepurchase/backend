import { Response } from 'express';
import prisma from '../config/database';
import {
  uploadKnoxGuardDevices,
  getKnoxGuardUploadStatus,
  listDevicesFromApi,
  deleteDevicesFromApi,
  lookupKnoxGuardDevice,
} from '../services/knoxGuardService';
import { AuthenticatedRequest } from '../types';

const MAX_RETRIES = 5;

// Knox Guard portal status → local state mapping
function resolveStateFromPortalStatus(
  status: string | null
): { enrollmentStatus: string; actualState: string; lastError: string | null } | null {
  const derived = deriveManagedDeviceSyncFromPortalStatus(normalizeKnoxPortalStatus(status));
  if (!derived.enrollmentStatus || !derived.actualState) {
    return null;
  }

  return {
    enrollmentStatus: derived.enrollmentStatus,
    actualState: derived.actualState,
    lastError: derived.lastError,
  };
}

export async function syncManagedDevicesFromKnoxPortal(): Promise<number> {
  const allManagedDevices = await (prisma as any).managedDevice.findMany({
    where: { isActive: true },
    select: {
      id: true,
      deviceUid: true,
      approveId: true,
      knoxObjectId: true,
      enrollmentStatus: true,
      actualState: true,
      knoxStatus: true,
      lastError: true,
    },
  });

  let synced = 0;
  for (const device of allManagedDevices) {
    try {
      const lookup = await lookupKnoxGuardDevice({
        objectId: device.knoxObjectId || undefined,
        deviceUid: device.deviceUid,
        approveId: device.approveId,
      });

      if (!lookup.success || lookup.dryRun) continue;

      const deviceList = (lookup.data as any)?.deviceList;
      const portalDevice = Array.isArray(deviceList)
        ? deviceList.find((d: any) =>
            d?.deviceUid === device.deviceUid ||
            d?.imei === device.deviceUid ||
            (device.knoxObjectId && d?.objectId === device.knoxObjectId)
          ) ?? deviceList[0] ?? null
        : null;

      // Device not found on portal — if locally ACTIVE, downgrade to APPROVAL_QUEUED
      if (!portalDevice) {
        if (device.enrollmentStatus === 'ACTIVE') {
          await (prisma as any).managedDevice.update({
            where: { id: device.id },
            data: {
              enrollmentStatus: 'APPROVAL_QUEUED',
              actualState: 'UNKNOWN',
              lastSyncedAt: new Date(),
              lastError: 'Device not found on Knox Guard portal',
            },
          });
          synced++;
        }
        continue;
      }

      const portalStatus: string | null = portalDevice.status || null;
      const resolved = resolveStateFromPortalStatus(portalStatus);
      if (!resolved) continue;

      // Only update if state has changed
      const stateChanged = resolved.enrollmentStatus !== device.enrollmentStatus
        || resolved.actualState !== device.actualState
        || portalStatus !== device.knoxStatus
        || resolved.lastError !== device.lastError;
      if (!stateChanged) continue;

      const knoxObjectId = normalizeDeviceIdentifier(portalDevice.objectId);
      await (prisma as any).managedDevice.update({
        where: { id: device.id },
        data: {
          enrollmentStatus: resolved.enrollmentStatus,
          actualState: resolved.actualState,
          knoxStatus: portalStatus,
          ...(knoxObjectId ? { knoxObjectId } : {}),
          lastSyncedAt: new Date(),
          lastError: resolved.lastError,
        },
      });
      synced++;
    } catch (err) {
      console.error(`Portal sync failed for device ${device.deviceUid}:`, err);
    }
  }
  return synced;
}

function normalizeDeviceIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function collectFailedDeviceIdentifiers(devices: unknown): Set<string> {
  if (!Array.isArray(devices)) {
    return new Set<string>();
  }

  const ids = new Set<string>();

  for (const device of devices) {
    if (!device || typeof device !== 'object') {
      continue;
    }

    const record = device as Record<string, unknown>;
    const candidates = [
      record.imei,
      record.deviceUid,
      record.serialNumber,
      record.serial,
      record.device,
      record.id,
    ];

    for (const candidate of candidates) {
      const normalized = normalizeDeviceIdentifier(candidate);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }

  return ids;
}

function extractFailedDeviceError(devices: unknown, serialNumber: string): string {
  if (!Array.isArray(devices)) {
    return 'Upload failed';
  }

  for (const device of devices) {
    if (!device || typeof device !== 'object') {
      continue;
    }

    const record = device as Record<string, unknown>;
    const matches = [
      record.imei,
      record.deviceUid,
      record.serialNumber,
      record.serial,
      record.device,
      record.id,
    ].some((value) => normalizeDeviceIdentifier(value) === serialNumber);

    if (!matches) {
      continue;
    }

    return normalizeDeviceIdentifier(record.message)
      || normalizeDeviceIdentifier(record.error)
      || normalizeDeviceIdentifier(record.reason)
      || 'Upload failed';
  }

  return 'Upload failed';
}

function normalizeKnoxPortalStatus(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function deriveManagedDeviceSyncFromPortalStatus(status: string | null) {
  const normalized = (status || '').trim().toUpperCase();

  if (normalized === 'ACCEPTED') {
    return {
      actualState: 'PENDING',
      enrollmentStatus: 'APPROVAL_QUEUED',
      lastError: 'Device uploaded to Knox and waiting for the Knox Guard app to connect.',
    };
  }

  if (normalized === 'ENROLLED') {
    return {
      actualState: 'UNLOCKED',
      enrollmentStatus: 'ACTIVE',
      lastError: null,
    };
  }

  if (normalized.includes('UNLOCK')) {
    return {
      actualState: 'UNLOCKED',
      enrollmentStatus: 'ACTIVE',
      lastError: null,
    };
  }

  if (normalized.includes('LOCK')) {
    return {
      actualState: 'LOCKED',
      enrollmentStatus: 'ACTIVE',
      lastError: null,
    };
  }

  if (normalized.includes('APPROV')) {
    return {
      actualState: 'UNLOCKED',
      enrollmentStatus: 'APPROVED',
      lastError: null,
    };
  }

  return {
    actualState: undefined,
    enrollmentStatus: undefined,
    lastError: null,
  };
}

function findExactPortalDeviceForSerial(serialNumber: string, payload: unknown): Record<string, unknown> | null {
  const deviceList = (payload as any)?.deviceList;
  if (!Array.isArray(deviceList)) {
    return null;
  }

  for (const candidate of deviceList) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const matches = [
      record.deviceUid,
      record.imei,
      record.serialNumber,
      record.serial,
    ].some((value) => normalizeDeviceIdentifier(value) === serialNumber);

    if (matches) {
      return record;
    }
  }

  return null;
}

function extractPortalDeviceForSerial(serialNumber: string, payload: unknown): Record<string, unknown> | null {
  const exactMatch = findExactPortalDeviceForSerial(serialNumber, payload);
  if (exactMatch) {
    return exactMatch;
  }

  const deviceList = (payload as any)?.deviceList;
  if (!Array.isArray(deviceList)) {
    return null;
  }

  return (deviceList[0] && typeof deviceList[0] === 'object') ? deviceList[0] as Record<string, unknown> : null;
}

async function verifyVisibleKnoxSerials(serialNumbers: string[]): Promise<Set<string>> {
  const visible = new Set<string>();

  for (const serialNumber of serialNumbers) {
    try {
      const lookup = await lookupKnoxGuardDevice({ deviceUid: serialNumber });
      if (!lookup.success) {
        continue;
      }

      if (findExactPortalDeviceForSerial(serialNumber, lookup.data)) {
        visible.add(serialNumber);
      }
    } catch (error) {
      console.error(`Failed to verify Knox visibility for ${serialNumber}:`, error);
    }
  }

  return visible;
}

function serializePortalTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (/^\d+$/.test(trimmed)) {
      const date = new Date(Number(trimmed));
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

function derivePortalSyncState(localStatus: string | null, portalVisible: boolean, lookupError: string | null): string {
  if (lookupError) {
    return 'LOOKUP_FAILED';
  }

  if (portalVisible) {
    return localStatus === 'UPLOADED' ? 'SYNCED' : 'VISIBLE_WITH_LOCAL_MISMATCH';
  }

  if (localStatus === 'UPLOADED') {
    return 'MISSING_IN_KNOX';
  }

  return 'NOT_VISIBLE';
}

async function syncManagedDevicesFromSamsung(serialNumbers: string[]): Promise<void> {
  const items = await prisma.inventoryItem.findMany({
    where: {
      serialNumber: { in: serialNumbers },
      managedDevice: { isNot: null },
    },
    select: {
      serialNumber: true,
      managedDevice: {
        select: {
          id: true,
        },
      },
    },
  });

  for (const item of items) {
    if (!item.managedDevice) {
      continue;
    }

    try {
      const lookup = await lookupKnoxGuardDevice({ deviceUid: item.serialNumber });
      if (!lookup.success) {
        continue;
      }

      const portalDevice = extractPortalDeviceForSerial(item.serialNumber, lookup.data);
      if (!portalDevice) {
        continue;
      }

      const portalStatus = normalizeKnoxPortalStatus(portalDevice.status);
      const derived = deriveManagedDeviceSyncFromPortalStatus(portalStatus);
      const updateData: Record<string, unknown> = {
        lastSyncedAt: new Date(),
        knoxStatus: portalStatus,
      };

      const objectId = normalizeDeviceIdentifier(portalDevice.objectId);
      if (objectId) {
        updateData.knoxObjectId = objectId;
      }

      if (derived.actualState) {
        updateData.actualState = derived.actualState;
      }

      if (derived.enrollmentStatus) {
        updateData.enrollmentStatus = derived.enrollmentStatus;
      }

      updateData.lastError = derived.lastError;

      await prisma.managedDevice.update({
        where: { id: item.managedDevice.id },
        data: updateData,
      });
    } catch (error) {
      console.error(`Failed to sync managed device from Samsung for ${item.serialNumber}:`, error);
    }
  }
}

async function syncManagedDevicesAfterDeletion(serialNumbers: string[], transactionId: string | null): Promise<void> {
  const items = await prisma.inventoryItem.findMany({
    where: {
      serialNumber: { in: serialNumbers },
      managedDevice: { isNot: null },
    },
    select: {
      managedDevice: {
        select: {
          id: true,
        },
      },
    },
  });

  for (const item of items) {
    if (!item.managedDevice) {
      continue;
    }

    await prisma.managedDevice.update({
      where: { id: item.managedDevice.id },
      data: {
        knoxObjectId: null,
        knoxStatus: 'DELETED',
        actualState: 'UNKNOWN',
        enrollmentStatus: 'PENDING',
        lastSyncedAt: new Date(),
        lastTransactionId: transactionId,
        lastError: 'Device removed from Knox tenant. Re-upload and re-approve before sending control commands.',
      },
    });
  }
}

// GET /api/knox-guard/upload/status
export async function getKnoxUploadStatuses(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { status, page = 1, limit = 50, includePortal, q, withoutContract } = req.query;
    const includePortalData = String(includePortal || '').toLowerCase() === 'true';
    const withoutContractOnly = String(withoutContract || '').toLowerCase() === 'true';
    const normalizedQuery = String(q || '').trim();
    const pageNumber = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNumber = Math.min(Math.max(1, parseInt(String(limit), 10) || 50), 100);

    const where: Record<string, unknown> = {
      knoxUploadStatus: { not: null },
    };
    if (status) where.knoxUploadStatus = status;
    if (withoutContractOnly) where.contractId = null;
    if (normalizedQuery) {
      where.OR = [
        { serialNumber: { contains: normalizedQuery, mode: 'insensitive' } },
        { product: { is: { name: { contains: normalizedQuery, mode: 'insensitive' } } } },
        { contract: { is: { contractNumber: { contains: normalizedQuery, mode: 'insensitive' } } } },
        { managedDevice: { is: { approveId: { contains: normalizedQuery, mode: 'insensitive' } } } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        select: {
          id: true,
          serialNumber: true,
          status: true,
          lockStatus: true,
          knoxUploadStatus: true,
          knoxUploadId: true,
          knoxUploadError: true,
          knoxUploadRetries: true,
          updatedAt: true,
          product: { select: { id: true, name: true } },
          contract: { select: { id: true, contractNumber: true, status: true } },
          managedDevice: {
            select: {
              id: true,
              approveId: true,
              knoxObjectId: true,
              knoxStatus: true,
              enrollmentStatus: true,
              actualState: true,
              desiredState: true,
              isActive: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (pageNumber - 1) * limitNumber,
        take: limitNumber,
      }),
      prisma.inventoryItem.count({ where }),
    ]);

    const portalItems = includePortalData
      ? await Promise.all(items.map(async (item) => {
        try {
          const lookup = await lookupKnoxGuardDevice({ deviceUid: item.serialNumber });
          const portalDevice = lookup.success ? findExactPortalDeviceForSerial(item.serialNumber, lookup.data) : null;
          const portalVisible = Boolean(portalDevice);

          return {
            ...item,
            portal: {
              visible: portalVisible,
              status: normalizeKnoxPortalStatus(portalDevice?.status) || null,
              objectId: normalizeDeviceIdentifier(portalDevice?.objectId) || null,
              model: normalizeDeviceIdentifier(portalDevice?.model) || null,
              portalSerial: normalizeDeviceIdentifier(portalDevice?.serial) || null,
              createDate: serializePortalTimestamp(portalDevice?.createDate),
              modifiedDate: serializePortalTimestamp(portalDevice?.modifiedDate),
              syncState: derivePortalSyncState(item.knoxUploadStatus || null, portalVisible, lookup.success ? null : (lookup.error || 'Lookup failed')),
              lookupStatusCode: lookup.statusCode ?? null,
              lookupError: lookup.success ? null : (lookup.error || 'Lookup failed'),
            },
          };
        } catch (error: any) {
          return {
            ...item,
            portal: {
              visible: false,
              status: null,
              objectId: null,
              model: null,
              portalSerial: null,
              createDate: null,
              modifiedDate: null,
              syncState: 'LOOKUP_FAILED',
              lookupStatusCode: null,
              lookupError: error?.message || 'Lookup failed',
            },
          };
        }
      }))
      : items;

    const portalSummary = includePortalData
      ? portalItems.reduce((summary, item: any) => {
        if (item.portal?.visible) {
          summary.visible += 1;
        } else {
          summary.notVisible += 1;
        }

        if (item.portal?.syncState === 'MISSING_IN_KNOX') {
          summary.missingInKnox += 1;
        }

        if (item.portal?.syncState === 'LOOKUP_FAILED') {
          summary.lookupFailed += 1;
        }

        return summary;
      }, {
        visible: 0,
        notVisible: 0,
        missingInKnox: 0,
        lookupFailed: 0,
      })
      : null;

    res.json({
      items: portalItems,
      portalSummary,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNumber)),
      },
    });
  } catch (error) {
    console.error('Knox upload status fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch Knox upload statuses' });
  }
}

// POST /api/knox-guard/upload/retry
// Body: { inventoryItemIds?: string[] }  — omit to retry ALL failed items
export async function retryKnoxUpload(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { inventoryItemIds } = req.body as { inventoryItemIds?: string[] };

    const idFilter = inventoryItemIds?.length ? { id: { in: inventoryItemIds } } : {};
    const where = {
      ...idFilter,
      knoxUploadRetries: { lt: MAX_RETRIES },
      OR: [
        { knoxUploadStatus: null },
        { knoxUploadStatus: 'FAILED' },
        { knoxUploadStatus: 'DELETED' },
      ],
    };

    const items = await prisma.inventoryItem.findMany({
      where,
      select: { id: true, serialNumber: true, knoxUploadRetries: true },
    });

    if (items.length === 0) {
      res.json({ message: 'No items eligible for Knox upload', retried: 0 });
      return;
    }

    await prisma.inventoryItem.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { knoxUploadStatus: 'PENDING' },
    });

    const serialNumbers = items.map((i) => i.serialNumber);

    // Await the upload synchronously so the caller gets a real result, not just "queued"
    const result = await uploadKnoxGuardDevices(serialNumbers);
    const transactionId = (result.data as any)?.transaction_id ?? null;

    if (!result.success && !result.dryRun) {
      await prisma.inventoryItem.updateMany({
        where: { id: { in: items.map((i) => i.id) } },
        data: {
          knoxUploadStatus: 'FAILED',
          knoxUploadId: transactionId,
          knoxUploadError: result.error ?? 'Upload failed',
          knoxUploadRetries: { increment: 1 },
        },
      });
      res.status(500).json({ error: result.error ?? 'Upload failed', retried: 0 });
      return;
    }

    // Poll transaction status (up to 10s) to confirm completion
    let failedDevices: any[] = [];

    if (!result.dryRun && transactionId) {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await getKnoxGuardUploadStatus(transactionId);
        const data = poll.data as any;
        if (data?.status === 'Complete') {
          if (Array.isArray(data?.devices) && data.devices.length > 0) {
            failedDevices = data.devices;
          }
          break;
        }
      }
    }

    const failedDeviceIds = collectFailedDeviceIdentifiers(failedDevices);
    const serialsToVerify = result.dryRun
      ? []
      : serialNumbers.filter((serialNumber) => !failedDeviceIds.has(serialNumber));
    const visibleSerials = result.dryRun
      ? new Set<string>()
      : await verifyVisibleKnoxSerials(serialsToVerify);
    const missingSerials = result.dryRun
      ? []
      : serialNumbers.filter(
        (serialNumber) => !failedDeviceIds.has(serialNumber) && !visibleSerials.has(serialNumber)
      );

    for (const item of items) {
      const failedByTransaction = failedDeviceIds.has(item.serialNumber);
      const failedByVisibility = !result.dryRun && !failedByTransaction && !visibleSerials.has(item.serialNumber);
      const knoxUploadStatus = result.dryRun
        ? 'SKIPPED'
        : failedByTransaction || failedByVisibility
          ? 'FAILED'
          : 'UPLOADED';
      const knoxUploadError = failedByTransaction
        ? extractFailedDeviceError(failedDevices, item.serialNumber)
        : failedByVisibility
          ? 'Upload completed but device is still not visible in Knox Guard lookup.'
          : null;

      await prisma.inventoryItem.update({
        where: { id: item.id },
        data: {
          knoxUploadStatus,
          knoxUploadId: transactionId,
          knoxUploadError,
          knoxUploadRetries: { increment: 1 },
        },
      });
    }

    if (!result.dryRun && visibleSerials.size > 0) {
      await syncManagedDevicesFromSamsung(Array.from(visibleSerials));
    }

    res.json({
      message: result.dryRun
        ? `Dry-run: ${items.length} device(s) skipped`
        : failedDevices.length > 0 || missingSerials.length > 0
          ? `${items.length - failedDevices.length - missingSerials.length} uploaded, ${failedDevices.length + missingSerials.length} failed`
          : `${items.length} device(s) uploaded successfully`,
      uploaded: result.dryRun ? 0 : visibleSerials.size,
      failed: result.dryRun ? 0 : failedDevices.length + missingSerials.length,
      skipped: result.dryRun ? items.length : 0,
      transactionId,
      failedDevices: [
        ...failedDevices,
        ...missingSerials.map((serialNumber) => ({
          imei: serialNumber,
          error: 'Upload completed but device is still not visible in Knox Guard lookup.',
        })),
      ],
      dryRun: result.dryRun,
    });
  } catch (error) {
    console.error('Knox upload retry error:', error);
    res.status(500).json({ error: 'Failed to upload devices to Knox' });
  }
}

// GET /api/knox-guard/upload/:uploadId/samsung-status
// Polls the Devices API transaction-status endpoint for the result of an upload or delete
export async function getSamsungUploadStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { uploadId } = req.params;
    const result = await getKnoxGuardUploadStatus(uploadId);

    if (!result.success && !result.dryRun) {
      res.status(result.statusCode === 401 || result.statusCode === 403 ? 502 : (result.statusCode ?? 500)).json({ error: result.error, data: result.data });
      return;
    }

    const data = result.data as any;
    // Normalise response: expose completion status and any failed devices
    res.json({
      status: data?.status ?? 'Unknown',
      complete: data?.status === 'Complete',
      failedDevices: Array.isArray(data?.devices) ? data.devices : [],
      raw: data,
    });
  } catch (error) {
    console.error('Devices API transaction status error:', error);
    res.status(500).json({ error: 'Failed to fetch transaction status' });
  }
}

// POST /api/knox-guard/upload/sync
// Cross-checks devices visible on the Knox portal against the local DB.
// - Marks inventory items as UPLOADED if the IMEI is visible on portal but not marked uploaded locally
// - Marks managed devices as ACTIVE if the device is enrolled/approved on portal
export async function syncUploadStatusFromPortal(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const portalResult = await listDevicesFromApi();

    if (!portalResult.success && !portalResult.dryRun) {
      res.status(502).json({ error: portalResult.error || 'Failed to fetch devices from portal' });
      return;
    }

    const portalDevices: any[] = (portalResult.data as any) ?? [];
    if (!Array.isArray(portalDevices) || portalDevices.length === 0) {
      res.json({ message: 'No devices found on portal', marked: 0, managed: 0, dryRun: portalResult.dryRun });
      return;
    }

    const portalImeis = new Set(portalDevices.map((d: any) => String(d.imei || d.deviceUid || '').trim()).filter(Boolean));

    // Find inventory items whose IMEI is on the portal but not marked UPLOADED locally
    const itemsToMark = await prisma.inventoryItem.findMany({
      where: {
        serialNumber: { in: Array.from(portalImeis) },
        OR: [
          { knoxUploadStatus: null },
          { knoxUploadStatus: 'FAILED' },
        ],
      },
      select: { id: true, serialNumber: true },
    });

    let marked = 0;
    if (itemsToMark.length > 0) {
      await prisma.inventoryItem.updateMany({
        where: { id: { in: itemsToMark.map((i) => i.id) } },
        data: {
          knoxUploadStatus: 'UPLOADED',
          knoxUploadError: null,
        },
      });
      marked = itemsToMark.length;
    }

    // Auto-enroll devices on portal that have a contract but no ManagedDevice record
    let enrolled = 0;
    const inventoryWithContracts = await prisma.inventoryItem.findMany({
      where: {
        serialNumber: { in: Array.from(portalImeis) },
        contractId: { not: null },
        managedDevice: null,
      },
      select: { contractId: true, serialNumber: true },
    });

    for (const item of inventoryWithContracts) {
      if (!item.contractId) continue;
      try {
        const { enrollManagedDeviceForContract } = await import('../services/deviceControlPolicyService');
        await enrollManagedDeviceForContract(item.contractId, {});
        enrolled++;
      } catch (err: any) {
        console.error(`Auto-enroll failed for ${item.serialNumber}:`, err?.message);
      }
    }

    // Sync managed device states from Knox Guard portal
    const managed = await syncManagedDevicesFromKnoxPortal();

    res.json({
      message: `Sync complete — ${marked} item(s) marked UPLOADED, ${enrolled} device(s) enrolled, ${managed} device(s) activated`,
      marked,
      enrolled,
      managed,
      portalTotal: portalDevices.length,
      dryRun: portalResult.dryRun,
    });
  } catch (error) {
    console.error('Knox upload sync error:', error);
    res.status(500).json({ error: 'Failed to sync upload status from portal' });
  }
}

// GET /api/knox-guard/devices/list-api
// Lists all devices from the Devices API (not the local DB)
export async function listDevicesFromDevicesApi(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const result = await listDevicesFromApi();
    if (!result.success && !result.dryRun) {
      // Never forward upstream 401/403 as-is — the client interceptor treats 401 as session expired
      const statusCode = result.statusCode === 401 || result.statusCode === 403 ? 502 : (result.statusCode ?? 500);
      res.status(statusCode).json({ error: result.error, data: result.data });
      return;
    }
    res.json(result.data);
  } catch (error) {
    console.error('Devices API list error:', error);
    res.status(500).json({ error: 'Failed to list devices from Devices API' });
  }
}

// POST /api/knox-guard/devices/upload-direct
// Body: { imeis: string[] }
// Uploads IMEIs directly to the Devices API without requiring an inventory/contract record.
export async function uploadDevicesDirect(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { imeis } = req.body as { imeis?: string[] };

    if (!Array.isArray(imeis) || imeis.length === 0) {
      res.status(400).json({ error: 'imeis must be a non-empty array of IMEI strings' });
      return;
    }

    const invalid = imeis.filter((imei) => !/^\d{14,16}$/.test(imei));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid IMEIs: ${invalid.join(', ')}` });
      return;
    }

    const result = await uploadKnoxGuardDevices(imeis);
    const transactionId = (result.data as any)?.transaction_id ?? null;

    if (!result.success && !result.dryRun) {
      res.status(result.statusCode === 401 || result.statusCode === 403 ? 502 : (result.statusCode ?? 500))
        .json({ error: result.error ?? 'Upload failed' });
      return;
    }

    // Poll up to 10s for completion
    let failedDevices: any[] = [];
    if (!result.dryRun && transactionId) {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await getKnoxGuardUploadStatus(transactionId);
        const data = poll.data as any;
        if (data?.status === 'Complete') {
          if (Array.isArray(data?.devices) && data.devices.length > 0) {
            failedDevices = data.devices;
          }
          break;
        }
      }
    }

    res.json({
      message: result.dryRun
        ? `Dry-run: ${imeis.length} device(s) simulated`
        : failedDevices.length > 0
          ? `${imeis.length - failedDevices.length} uploaded, ${failedDevices.length} failed`
          : `${imeis.length} device(s) uploaded successfully`,
      transactionId,
      dryRun: result.dryRun,
      uploaded: result.dryRun ? 0 : imeis.length - failedDevices.length,
      failed: result.dryRun ? 0 : failedDevices.length,
      failedDevices,
    });
  } catch (error) {
    console.error('Direct upload error:', error);
    res.status(500).json({ error: 'Failed to upload devices' });
  }
}

// DELETE /api/knox-guard/devices/delete
// Body: { imeis: string[] }
// Asynchronously removes devices from the tenant; returns transactionId for polling
export async function deleteDevices(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { imeis } = req.body as { imeis?: string[] };

    if (!Array.isArray(imeis) || imeis.length === 0) {
      res.status(400).json({ error: 'imeis must be a non-empty array of IMEI strings' });
      return;
    }

    // Validate each IMEI is 14–16 digits (standard IMEI is 15 digits)
    const invalid = imeis.filter((imei) => !/^\d{14,16}$/.test(imei));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid IMEIs (must be 14 digits): ${invalid.join(', ')}` });
      return;
    }

    const matchingInventoryItems = await prisma.inventoryItem.findMany({
      where: { serialNumber: { in: imeis } },
      select: { id: true, serialNumber: true },
    });

    const result = await deleteDevicesFromApi(imeis);
    const data = result.data as any;
    const transactionId = data?.transactionId ?? data?.transaction_id ?? null;

    if (!result.success && !result.dryRun) {
      if (matchingInventoryItems.length > 0) {
        await prisma.inventoryItem.updateMany({
          where: { id: { in: matchingInventoryItems.map((item) => item.id) } },
          data: {
            knoxUploadId: transactionId,
            knoxUploadError: result.error ?? 'Delete failed',
          },
        });
      }

      res.status(result.statusCode === 401 || result.statusCode === 403 ? 502 : (result.statusCode ?? 500)).json({ error: result.error, data: result.data });
      return;
    }

    let finalStatus: 'DELETED' | 'DELETE_PENDING' | 'SKIPPED' = result.dryRun ? 'SKIPPED' : 'DELETE_PENDING';
    let failedDeviceIds = new Set<string>();

    if (!result.dryRun && transactionId) {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const poll = await getKnoxGuardUploadStatus(transactionId);
        const pollData = poll.data as any;

        if (pollData?.status === 'Complete') {
          failedDeviceIds = collectFailedDeviceIdentifiers(pollData?.devices);
          finalStatus = 'DELETED';
          break;
        }
      }
    }

    if (matchingInventoryItems.length > 0 && !result.dryRun) {
      const succeededItemIds = matchingInventoryItems
        .filter((item) => !failedDeviceIds.has(item.serialNumber))
        .map((item) => item.id);
      const failedItemIds = matchingInventoryItems
        .filter((item) => failedDeviceIds.has(item.serialNumber))
        .map((item) => item.id);

      if (succeededItemIds.length > 0) {
        await prisma.inventoryItem.updateMany({
          where: { id: { in: succeededItemIds } },
          data: {
            knoxUploadStatus: finalStatus === 'DELETED' ? 'DELETED' : 'DELETE_PENDING',
            knoxUploadId: transactionId,
            knoxUploadError: null,
          },
        });

        await syncManagedDevicesAfterDeletion(
          matchingInventoryItems
            .filter((item) => succeededItemIds.includes(item.id))
            .map((item) => item.serialNumber),
          transactionId
        );
      }

      if (failedItemIds.length > 0) {
        await prisma.inventoryItem.updateMany({
          where: { id: { in: failedItemIds } },
          data: {
            knoxUploadStatus: 'UPLOADED',
            knoxUploadId: transactionId,
            knoxUploadError: 'Delete failed for this device in Knox',
          },
        });
      }
    }

    res.json({
      message: result.dryRun
        ? `Dry-run: deletion of ${imeis.length} device(s) simulated`
        : finalStatus === 'DELETED' && failedDeviceIds.size > 0
          ? `${imeis.length - failedDeviceIds.size} deleted, ${failedDeviceIds.size} failed`
          : finalStatus === 'DELETED'
            ? `${imeis.length - failedDeviceIds.size} device(s) deleted from Knox`
        : finalStatus === 'DELETE_PENDING'
          ? `Deletion queued for ${imeis.length} device(s)`
          : `Deletion of ${imeis.length} device(s) queued`,
      transactionId,
      dryRun: result.dryRun,
      status: finalStatus,
      failed: failedDeviceIds.size,
    });
  } catch (error) {
    console.error('Devices API delete error:', error);
    res.status(500).json({ error: 'Failed to delete devices' });
  }
}

// POST /api/knox-guard/devices/reset
// Removes a device from Knox then clears all Knox upload state so it can be re-uploaded fresh.
// Body: { imei: string }
export async function resetKnoxDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { imei } = req.body as { imei?: string };

    if (!imei || !/^\d{14,16}$/.test(imei.trim())) {
      res.status(400).json({ error: 'imei must be a 14–16 digit string' });
      return;
    }

    const serialNumber = imei.trim();

    // Check current upload status — only call Knox API if the device was actually uploaded
    const inventoryItem = await prisma.inventoryItem.findFirst({
      where: { serialNumber },
      select: { knoxUploadStatus: true },
    });

    const isUploadedToKnox = inventoryItem?.knoxUploadStatus === 'UPLOADED';

    let transactionId: string | null = null;
    if (isUploadedToKnox) {
      try {
        const result = await deleteDevicesFromApi([serialNumber]);
        const data = result.data as any;
        transactionId = data?.transactionId ?? data?.transaction_id ?? null;
      } catch (err) {
        console.warn(`Knox API delete failed for ${serialNumber}, continuing with local reset:`, err);
      }
    }

    // Reset InventoryItem Knox fields to null
    await prisma.inventoryItem.updateMany({
      where: { serialNumber },
      data: {
        knoxUploadStatus: null,
        knoxUploadId: null,
        knoxUploadError: null,
      },
    });

    // Reset ManagedDevice back to PENDING so it can be re-enrolled
    await syncManagedDevicesAfterDeletion([serialNumber], transactionId);

    res.json({
      message: isUploadedToKnox
        ? `Device ${serialNumber} removed from Knox and reset for re-upload`
        : `Device ${serialNumber} reset for upload (was not previously uploaded to Knox)`,
      imei: serialNumber,
      transactionId,
    });
  } catch (error) {
    console.error('Knox device reset error:', error);
    res.status(500).json({ error: 'Failed to reset Knox device' });
  }
}

// DELETE /api/knox-guard/devices/managed/:imei
// Removes a ManagedDevice record (and its commands) from the system entirely.
// Also clears Knox upload state on the linked InventoryItem.
export async function removeManagedDevice(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { imei } = req.params;

    if (!imei || !/^\d{14,16}$/.test(imei.trim())) {
      res.status(400).json({ error: 'imei must be a 14–16 digit string' });
      return;
    }

    const serialNumber = imei.trim();

    const inventoryItem = await prisma.inventoryItem.findFirst({
      where: { serialNumber },
      select: { id: true, managedDevice: { select: { id: true } } },
    });

    if (!inventoryItem?.managedDevice) {
      res.status(404).json({ error: `No managed device found for IMEI ${serialNumber}` });
      return;
    }

    const managedDeviceId = inventoryItem.managedDevice.id;

    // Delete commands first (no cascade on the relation)
    await prisma.managedDeviceCommand.deleteMany({ where: { managedDeviceId } });

    // Delete the managed device record
    await prisma.managedDevice.delete({ where: { id: managedDeviceId } });

    // Clear Knox upload state on the inventory item
    await prisma.inventoryItem.update({
      where: { id: inventoryItem.id },
      data: {
        knoxUploadStatus: null,
        knoxUploadId: null,
        knoxUploadError: null,
      },
    });

    res.json({ message: `Managed device for IMEI ${serialNumber} removed from the system` });
  } catch (error) {
    console.error('Remove managed device error:', error);
    res.status(500).json({ error: 'Failed to remove managed device' });
  }
}

// POST /api/knox-guard/devices/delete-all
// Lists every device registered in the Knox tenant (via the Devices API) and removes them all.
// Intended for license migration: Knox requires all devices removed before swapping licenses.
// Also resets local Knox upload state so devices can be re-uploaded under the new license.
export async function deleteAllDevices(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    // Step 1 — fetch the full device list from the Knox tenant
    const listResult = await listDevicesFromApi();

    if (!listResult.success && !listResult.dryRun) {
      const statusCode = listResult.statusCode === 401 || listResult.statusCode === 403 ? 502 : (listResult.statusCode ?? 500);
      res.status(statusCode).json({ error: listResult.error || 'Failed to list devices from Knox tenant' });
      return;
    }

    if (listResult.dryRun) {
      res.json({
        message: 'Dry-run: delete-all simulated — no devices were removed',
        dryRun: true,
        total: 0,
        deleted: 0,
        failed: 0,
        batches: [],
      });
      return;
    }

    const portalDevices: any[] = Array.isArray(listResult.data) ? listResult.data : [];
    if (portalDevices.length === 0) {
      res.json({
        message: 'Knox tenant has no devices — nothing to delete',
        dryRun: false,
        total: 0,
        deleted: 0,
        failed: 0,
        batches: [],
      });
      return;
    }

    // Step 2 — collect IMEIs; Knox Devices API requires 14–16 digit strings
    const allImeis: string[] = portalDevices
      .map((d: any) => String(d.imei || d.deviceUid || '').trim())
      .filter((imei) => /^\d{14,16}$/.test(imei));

    if (allImeis.length === 0) {
      res.json({
        message: 'Knox returned devices but none had a valid IMEI — nothing deleted',
        dryRun: false,
        total: portalDevices.length,
        deleted: 0,
        failed: 0,
        batches: [],
      });
      return;
    }

    // Step 3 — delete in batches of 100 (Devices API limit)
    const BATCH_SIZE = 100;
    const batches: Array<{ imeis: string[]; transactionId: string | null; status: string; failed: number }> = [];
    let totalDeleted = 0;
    let totalFailed = 0;

    for (let i = 0; i < allImeis.length; i += BATCH_SIZE) {
      const batch = allImeis.slice(i, i + BATCH_SIZE);
      const deleteResult = await deleteDevicesFromApi(batch);
      const data = deleteResult.data as any;
      const transactionId: string | null = data?.transactionId ?? data?.transaction_id ?? null;

      let batchStatus = 'DELETE_PENDING';
      let failedCount = 0;
      let failedIds = new Set<string>();

      if (deleteResult.success && transactionId) {
        // Poll up to 10s for completion
        for (let poll = 0; poll < 5; poll++) {
          await new Promise((r) => setTimeout(r, 2000));
          const pollResult = await getKnoxGuardUploadStatus(transactionId);
          const pollData = pollResult.data as any;
          if (pollData?.status === 'Complete') {
            failedIds = collectFailedDeviceIdentifiers(pollData?.devices);
            failedCount = failedIds.size;
            batchStatus = 'DELETED';
            break;
          }
        }
      } else if (!deleteResult.success) {
        batchStatus = 'FAILED';
        failedCount = batch.length;
      }

      totalDeleted += batch.length - failedCount;
      totalFailed += failedCount;
      batches.push({ imeis: batch, transactionId, status: batchStatus, failed: failedCount });

      // Step 4 — update local DB for this batch
      const succeeded = batchStatus === 'DELETED'
        ? batch.filter((imei) => !failedIds.has(imei))
        : batchStatus === 'DELETE_PENDING'
          ? batch
          : [];

      if (succeeded.length > 0) {
        await prisma.inventoryItem.updateMany({
          where: { serialNumber: { in: succeeded } },
          data: { knoxUploadStatus: batchStatus === 'DELETED' ? 'DELETED' : 'DELETE_PENDING', knoxUploadError: null, knoxUploadId: transactionId },
        });
        await syncManagedDevicesAfterDeletion(succeeded, transactionId);
      }

      if (failedIds.size > 0) {
        await prisma.inventoryItem.updateMany({
          where: { serialNumber: { in: Array.from(failedIds) } },
          data: { knoxUploadStatus: 'UPLOADED', knoxUploadError: 'Delete failed for this device in Knox', knoxUploadId: transactionId },
        });
      }
    }

    res.json({
      message: totalFailed > 0
        ? `Removed ${totalDeleted} of ${allImeis.length} device(s) from Knox; ${totalFailed} failed`
        : `All ${totalDeleted} device(s) removed from Knox tenant`,
      dryRun: false,
      total: allImeis.length,
      deleted: totalDeleted,
      failed: totalFailed,
      batches: batches.map((b) => ({ transactionId: b.transactionId, count: b.imeis.length, status: b.status, failed: b.failed })),
    });
  } catch (error) {
    console.error('Delete-all Knox devices error:', error);
    res.status(500).json({ error: 'Failed to delete all devices from Knox tenant' });
  }
}

// PATCH /api/knox-guard/upload/status/:serialNumber
// Manually set knoxUploadStatus on an inventory item — useful when a device was uploaded
// outside the system or the local state is out of sync with the actual tenant.
export async function patchKnoxUploadStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { serialNumber } = req.params;
    const { knoxUploadStatus, knoxUploadId, knoxUploadError } = req.body as {
      knoxUploadStatus?: string;
      knoxUploadId?: string | null;
      knoxUploadError?: string | null;
    };

    const validStatuses = ['PENDING', 'UPLOADED', 'FAILED', 'SKIPPED', 'DELETE_PENDING', 'DELETED'];
    if (!knoxUploadStatus || !validStatuses.includes(knoxUploadStatus)) {
      res.status(400).json({ error: `knoxUploadStatus must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    const item = await prisma.inventoryItem.findFirst({ where: { serialNumber } });
    if (!item) {
      res.status(404).json({ error: `No inventory item found with serial number ${serialNumber}` });
      return;
    }

    const updated = await prisma.inventoryItem.update({
      where: { id: item.id },
      data: {
        knoxUploadStatus,
        ...(knoxUploadId !== undefined && { knoxUploadId }),
        ...(knoxUploadError !== undefined && { knoxUploadError }),
      },
      select: { id: true, serialNumber: true, knoxUploadStatus: true, knoxUploadId: true, knoxUploadError: true },
    });

    res.json({ message: `Knox upload status updated for ${serialNumber}`, item: updated });
  } catch (error) {
    console.error('Patch Knox upload status error:', error);
    res.status(500).json({ error: 'Failed to update Knox upload status' });
  }
}
