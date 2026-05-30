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
    const { status, page = 1, limit = 50 } = req.query;

    const where: Record<string, unknown> = {
      knoxUploadStatus: { not: null },
    };
    if (status) where.knoxUploadStatus = status;

    const [items, total] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        select: {
          id: true,
          serialNumber: true,
          knoxUploadStatus: true,
          knoxUploadId: true,
          knoxUploadError: true,
          knoxUploadRetries: true,
          updatedAt: true,
          product: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.inventoryItem.count({ where }),
    ]);

    res.json({
      items,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / Number(limit)) },
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
      res.status(result.statusCode ?? 500).json({ error: result.error, data: result.data });
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

// GET /api/knox-guard/devices/list-api
// Lists all devices from the Devices API (not the local DB)
export async function listDevicesFromDevicesApi(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const result = await listDevicesFromApi();
    if (!result.success && !result.dryRun) {
      res.status(result.statusCode ?? 500).json({ error: result.error, data: result.data });
      return;
    }
    res.json(result.data);
  } catch (error) {
    console.error('Devices API list error:', error);
    res.status(500).json({ error: 'Failed to list devices from Devices API' });
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

      res.status(result.statusCode ?? 500).json({ error: result.error, data: result.data });
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

    // 1. Remove from Knox API (best-effort — clear local state regardless)
    let transactionId: string | null = null;
    try {
      const result = await deleteDevicesFromApi([serialNumber]);
      const data = result.data as any;
      transactionId = data?.transactionId ?? data?.transaction_id ?? null;
    } catch (err) {
      console.warn(`Knox API delete failed for ${serialNumber}, continuing with local reset:`, err);
    }

    // 2. Reset InventoryItem Knox fields to null
    await prisma.inventoryItem.updateMany({
      where: { serialNumber },
      data: {
        knoxUploadStatus: null,
        knoxUploadId: null,
        knoxUploadError: null,
      },
    });

    // 3. Reset ManagedDevice back to PENDING so it can be re-enrolled
    await syncManagedDevicesAfterDeletion([serialNumber], transactionId);

    res.json({
      message: `Device ${serialNumber} removed from Knox and reset for re-upload`,
      imei: serialNumber,
      transactionId,
    });
  } catch (error) {
    console.error('Knox device reset error:', error);
    res.status(500).json({ error: 'Failed to reset Knox device' });
  }
}
