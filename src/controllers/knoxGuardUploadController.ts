import { Response } from 'express';
import prisma from '../config/database';
import {
  uploadKnoxGuardDevices,
  getKnoxGuardUploadStatus,
  listDevicesFromApi,
  deleteDevicesFromApi,
} from '../services/knoxGuardService';
import { AuthenticatedRequest } from '../types';

const MAX_RETRIES = 5;

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

    res.json({ message: `Retrying Knox upload for ${items.length} device(s)`, retried: items.length });

    uploadKnoxGuardDevices(serialNumbers)
      .then(async (result) => {
        // New Devices API returns transaction_id (not uploadID)
        const uploadId = (result.data as any)?.transaction_id ?? null;
        await prisma.inventoryItem.updateMany({
          where: { id: { in: items.map((i) => i.id) } },
          data: {
            knoxUploadStatus: result.dryRun ? 'SKIPPED' : result.success ? 'UPLOADED' : 'FAILED',
            knoxUploadId: uploadId,
            knoxUploadError: result.success ? null : (result.error ?? 'Unknown error'),
            knoxUploadRetries: { increment: 1 },
          },
        });
      })
      .catch(async (err) => {
        console.error('[KnoxGuard] Retry upload failed:', err?.message ?? err);
        await prisma.inventoryItem.updateMany({
          where: { id: { in: items.map((i) => i.id) } },
          data: {
            knoxUploadStatus: 'FAILED',
            knoxUploadError: err?.message ?? String(err),
            knoxUploadRetries: { increment: 1 },
          },
        });
      });
  } catch (error) {
    console.error('Knox upload retry error:', error);
    res.status(500).json({ error: 'Failed to retry Knox upload' });
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

    // Validate each IMEI is 14 digits
    const invalid = imeis.filter((imei) => !/^\d{14}$/.test(imei));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid IMEIs (must be 14 digits): ${invalid.join(', ')}` });
      return;
    }

    const result = await deleteDevicesFromApi(imeis);

    if (!result.success && !result.dryRun) {
      res.status(result.statusCode ?? 500).json({ error: result.error, data: result.data });
      return;
    }

    const data = result.data as any;
    res.json({
      message: result.dryRun
        ? `Dry-run: deletion of ${imeis.length} device(s) simulated`
        : `Deletion of ${imeis.length} device(s) queued`,
      transactionId: data?.transactionId ?? data?.transaction_id ?? null,
      dryRun: result.dryRun,
    });
  } catch (error) {
    console.error('Devices API delete error:', error);
    res.status(500).json({ error: 'Failed to delete devices' });
  }
}
