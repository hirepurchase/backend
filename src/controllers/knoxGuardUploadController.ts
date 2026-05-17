import { Response } from 'express';
import prisma from '../config/database';
import { uploadKnoxGuardDevices, getKnoxGuardUploadStatus } from '../services/knoxGuardService';
import { AuthenticatedRequest } from '../types';

const MAX_RETRIES = 5;

// GET /api/knox-guard/upload/status
// Returns all inventory items with a Knox upload status, filterable by status
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

    const where: Record<string, unknown> = {
      knoxUploadStatus: 'FAILED',
      knoxUploadRetries: { lt: MAX_RETRIES },
    };
    if (inventoryItemIds?.length) where.id = { in: inventoryItemIds };

    const items = await prisma.inventoryItem.findMany({
      where,
      select: { id: true, serialNumber: true, knoxUploadRetries: true },
    });

    if (items.length === 0) {
      res.json({ message: 'No failed items eligible for retry', retried: 0 });
      return;
    }

    // Mark all as PENDING before firing
    await prisma.inventoryItem.updateMany({
      where: { id: { in: items.map((i) => i.id) } },
      data: { knoxUploadStatus: 'PENDING' },
    });

    const serialNumbers = items.map((i) => i.serialNumber);

    // Fire upload and update results — non-blocking response
    res.json({ message: `Retrying Knox upload for ${items.length} device(s)`, retried: items.length });

    uploadKnoxGuardDevices(serialNumbers)
      .then(async (result) => {
        const uploadId = (result.data as any)?.uploadID ?? null;
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
// Polls Samsung's servers for the upload batch result
export async function getSamsungUploadStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { uploadId } = req.params;
    const result = await getKnoxGuardUploadStatus(uploadId);
    if (!result.success) {
      res.status(result.statusCode ?? 500).json({ error: result.error, data: result.data });
      return;
    }
    res.json(result.data);
  } catch (error) {
    console.error('Samsung Knox upload status error:', error);
    res.status(500).json({ error: 'Failed to fetch Samsung upload status' });
  }
}
