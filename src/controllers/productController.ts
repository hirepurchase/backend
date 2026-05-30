import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { getKnoxGuardUploadStatus, lookupKnoxGuardDevice, uploadKnoxGuardDevices } from '../services/knoxGuardService';
import { requestManagedDeviceLock, requestManagedDeviceUnlock } from '../services/deviceControlPolicyService';
import { runDeviceControlSchedulerManually } from '../services/deviceControlScheduler';
import { AuthenticatedRequest } from '../types';

const KNOX_UPLOAD_POLL_ATTEMPTS = 5;
const KNOX_UPLOAD_POLL_DELAY_MS = 2000;

function normalizeKnoxUploadIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function collectFailedKnoxUploadIdentifiers(devices: unknown): Set<string> {
  if (!Array.isArray(devices)) {
    return new Set<string>();
  }

  const ids = new Set<string>();

  for (const device of devices) {
    if (!device || typeof device !== 'object') {
      continue;
    }

    const record = device as Record<string, unknown>;
    for (const candidate of [
      record.imei,
      record.deviceUid,
      record.serialNumber,
      record.serial,
      record.device,
      record.id,
    ]) {
      const normalized = normalizeKnoxUploadIdentifier(candidate);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }

  return ids;
}

function extractKnoxUploadFailure(devices: unknown, serialNumber: string): string {
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
    ].some((value) => normalizeKnoxUploadIdentifier(value) === serialNumber);

    if (!matches) {
      continue;
    }

    return normalizeKnoxUploadIdentifier(record.message)
      || normalizeKnoxUploadIdentifier(record.error)
      || normalizeKnoxUploadIdentifier(record.reason)
      || 'Upload failed';
  }

  return 'Upload failed';
}

function didKnoxLookupFindSerial(serialNumber: string, payload: unknown): boolean {
  const deviceList = (payload as any)?.deviceList;
  if (!Array.isArray(deviceList)) {
    return false;
  }

  return deviceList.some((candidate) => {
    if (!candidate || typeof candidate !== 'object') {
      return false;
    }

    const record = candidate as Record<string, unknown>;
    return [
      record.deviceUid,
      record.imei,
      record.serialNumber,
      record.serial,
    ].some((value) => normalizeKnoxUploadIdentifier(value) === serialNumber);
  });
}

async function verifyKnoxVisibility(serialNumbers: string[]): Promise<Set<string>> {
  const visible = new Set<string>();

  for (const serialNumber of serialNumbers) {
    try {
      const lookup = await lookupKnoxGuardDevice({ deviceUid: serialNumber });
      if (lookup.success && didKnoxLookupFindSerial(serialNumber, lookup.data)) {
        visible.add(serialNumber);
      }
    } catch (error) {
      console.error(`[KnoxGuard] Visibility check failed for ${serialNumber}:`, error);
    }
  }

  return visible;
}

async function pollKnoxUploadFailures(transactionId: string): Promise<any[]> {
  for (let attempt = 0; attempt < KNOX_UPLOAD_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, KNOX_UPLOAD_POLL_DELAY_MS));
    const poll = await getKnoxGuardUploadStatus(transactionId);
    const data = poll.data as any;

    if (data?.status === 'Complete') {
      return Array.isArray(data?.devices) ? data.devices : [];
    }
  }

  return [];
}

// ==================== CATEGORIES ====================

// Create category
export async function createCategory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { name, description } = req.body;

    if (!name) {
      res.status(400).json({ error: 'Category name is required' });
      return;
    }

    const existingCategory = await prisma.productCategory.findUnique({
      where: { name },
    });

    if (existingCategory) {
      res.status(400).json({ error: 'Category already exists' });
      return;
    }

    const category = await prisma.productCategory.create({
      data: { name, description },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CREATE_CATEGORY',
      entity: 'ProductCategory',
      entityId: category.id,
      newValues: { name, description },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json(category);
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
}

// Get all categories
export async function getAllCategories(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const categories = await prisma.productCategory.findMany({
      include: {
        _count: {
          select: { products: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    res.json(categories.map(c => ({
      ...c,
      productsCount: c._count.products,
    })));
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
}

// Update category
export async function updateCategory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const existingCategory = await prisma.productCategory.findUnique({ where: { id } });

    if (!existingCategory) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    // Check for duplicate name
    if (name && name !== existingCategory.name) {
      const duplicate = await prisma.productCategory.findUnique({ where: { name } });
      if (duplicate) {
        res.status(400).json({ error: 'Category name already exists' });
        return;
      }
    }

    const updatedCategory = await prisma.productCategory.update({
      where: { id },
      data: { name, description },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_CATEGORY',
      entity: 'ProductCategory',
      entityId: id,
      oldValues: { name: existingCategory.name, description: existingCategory.description },
      newValues: { name, description },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(updatedCategory);
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
}

// Delete category
export async function deleteCategory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const category = await prisma.productCategory.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });

    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    if (category._count.products > 0) {
      res.status(400).json({ error: 'Cannot delete category with products' });
      return;
    }

    await prisma.productCategory.delete({ where: { id } });

    await createAuditLog({
      userId: req.user!.id,
      action: 'DELETE_CATEGORY',
      entity: 'ProductCategory',
      entityId: id,
      oldValues: { name: category.name },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
}

// ==================== PRODUCTS ====================

// Create product
export async function createProduct(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { name, description, basePrice, categoryId } = req.body;

    if (!name || !basePrice || !categoryId) {
      res.status(400).json({ error: 'Name, base price, and category are required' });
      return;
    }

    const category = await prisma.productCategory.findUnique({ where: { id: categoryId } });
    if (!category) {
      res.status(400).json({ error: 'Invalid category' });
      return;
    }

    const product = await prisma.product.create({
      data: {
        name,
        description,
        basePrice: Number(basePrice),
        categoryId,
      },
      include: {
        category: true,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CREATE_PRODUCT',
      entity: 'Product',
      entityId: product.id,
      newValues: { name, basePrice, categoryId },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json(product);
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
}

// Get all products
export async function getAllProducts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { page = 1, limit = 20, search, categoryId, isActive } = req.query;

    const where: Record<string, unknown> = {};

    if (search) {
      where.OR = [
        { name: { contains: search as string } },
        { description: { contains: search as string } },
      ];
    }

    if (categoryId) where.categoryId = categoryId;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          category: true,
          _count: {
            select: { inventoryItems: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.product.count({ where }),
    ]);

    // Get available inventory count for each product
    const productsWithInventory = await Promise.all(
      products.map(async (product) => {
        const availableCount = await prisma.inventoryItem.count({
          where: {
            productId: product.id,
            status: 'AVAILABLE',
          },
        });

        return {
          ...product,
          totalInventory: product._count.inventoryItems,
          availableInventory: availableCount,
        };
      })
    );

    res.json({
      products: productsWithInventory,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
}

// Get product by ID
export async function getProductById(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        category: true,
        inventoryItems: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const availableCount = product.inventoryItems.filter(i => i.status === 'AVAILABLE').length;
    const soldCount = product.inventoryItems.filter(i => i.status === 'SOLD').length;

    res.json({
      ...product,
      inventoryStats: {
        total: product.inventoryItems.length,
        available: availableCount,
        sold: soldCount,
        reserved: product.inventoryItems.length - availableCount - soldCount,
      },
    });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
}

// Update product
export async function updateProduct(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, basePrice, categoryId, isActive } = req.body;

    const existingProduct = await prisma.product.findUnique({ where: { id } });

    if (!existingProduct) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (basePrice !== undefined) updateData.basePrice = Number(basePrice);
    if (categoryId) updateData.categoryId = categoryId;
    if (isActive !== undefined) updateData.isActive = isActive;

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData,
      include: { category: true },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_PRODUCT',
      entity: 'Product',
      entityId: id,
      oldValues: {
        name: existingProduct.name,
        basePrice: existingProduct.basePrice,
        isActive: existingProduct.isActive,
      },
      newValues: updateData,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(updatedProduct);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
}

// ==================== INVENTORY ====================

// Add inventory item
export async function addInventoryItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { productId, serialNumber, lockStatus, registeredUnder } = req.body;

    if (!productId || !serialNumber) {
      res.status(400).json({ error: 'Product ID and serial number are required' });
      return;
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.status(400).json({ error: 'Invalid product' });
      return;
    }

    // Check for duplicate serial number
    const existingItem = await prisma.inventoryItem.findUnique({
      where: { serialNumber },
    });

    if (existingItem) {
      res.status(400).json({ error: 'Serial number already exists' });
      return;
    }

    const inventoryItem = await prisma.inventoryItem.create({
      data: {
        productId,
        serialNumber,
        status: 'AVAILABLE',
        lockStatus: lockStatus || 'UNLOCKED',
        registeredUnder: registeredUnder || null,
      },
      include: {
        product: true,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'ADD_INVENTORY_ITEM',
      entity: 'InventoryItem',
      entityId: inventoryItem.id,
      newValues: { productId, serialNumber, lockStatus, registeredUnder },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Mark PENDING then upload — failure is recorded, not thrown
    await prisma.inventoryItem.update({
      where: { id: inventoryItem.id },
      data: { knoxUploadStatus: 'PENDING' },
    });
    uploadKnoxGuardDevices([serialNumber])
      .then(async (result) => {
        const transactionId = (result.data as any)?.transaction_id ?? (result.data as any)?.uploadID ?? null;
        let failedDevices: any[] = [];

        if (!result.dryRun && result.success && transactionId) {
          failedDevices = await pollKnoxUploadFailures(transactionId);
        }

        const failedByTransaction = collectFailedKnoxUploadIdentifiers(failedDevices).has(serialNumber);
        const visibleInKnox = result.dryRun
          ? false
          : !failedByTransaction && (await verifyKnoxVisibility([serialNumber])).has(serialNumber);
        const knoxUploadStatus = result.dryRun
          ? 'SKIPPED'
          : result.success && !failedByTransaction && visibleInKnox
            ? 'UPLOADED'
            : 'FAILED';
        const knoxUploadError = !result.success
          ? (result.error ?? 'Unknown error')
          : failedByTransaction
            ? extractKnoxUploadFailure(failedDevices, serialNumber)
            : result.dryRun
              ? null
              : visibleInKnox
                ? null
                : 'Upload completed but device is still not visible in Knox Guard lookup.';

        await prisma.inventoryItem.update({
          where: { id: inventoryItem.id },
          data: {
            knoxUploadStatus,
            knoxUploadId: transactionId,
            knoxUploadError,
            knoxUploadRetries: { increment: 1 },
          },
        });
      })
      .catch(async (err) => {
        console.error(`[KnoxGuard] Upload failed for device ${serialNumber}:`, err?.message ?? err);
        await prisma.inventoryItem.update({
          where: { id: inventoryItem.id },
          data: {
            knoxUploadStatus: 'FAILED',
            knoxUploadError: err?.message ?? String(err),
            knoxUploadRetries: { increment: 1 },
          },
        });
      });

    res.status(201).json(inventoryItem);
  } catch (error) {
    console.error('Add inventory item error:', error);
    res.status(500).json({ error: 'Failed to add inventory item' });
  }
}

// Add multiple inventory items (bulk)
export async function addBulkInventoryItems(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { productId, serialNumbers } = req.body;

    if (!productId || !serialNumbers || !Array.isArray(serialNumbers)) {
      res.status(400).json({ error: 'Product ID and serial numbers array are required' });
      return;
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.status(400).json({ error: 'Invalid product' });
      return;
    }

    // Check for duplicates
    const existingItems = await prisma.inventoryItem.findMany({
      where: { serialNumber: { in: serialNumbers } },
    });

    if (existingItems.length > 0) {
      res.status(400).json({
        error: 'Some serial numbers already exist',
        duplicates: existingItems.map(i => i.serialNumber),
      });
      return;
    }

    const items = await prisma.inventoryItem.createMany({
      data: serialNumbers.map((serialNumber: string) => ({
        productId,
        serialNumber,
        status: 'AVAILABLE',
      })),
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'BULK_ADD_INVENTORY',
      entity: 'InventoryItem',
      newValues: { productId, count: serialNumbers.length },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Mark all PENDING then upload in one batch
    await prisma.inventoryItem.updateMany({
      where: { serialNumber: { in: serialNumbers } },
      data: { knoxUploadStatus: 'PENDING' },
    });
    uploadKnoxGuardDevices(serialNumbers)
      .then(async (result) => {
        const transactionId = (result.data as any)?.transaction_id ?? (result.data as any)?.uploadID ?? null;
        let failedDevices: any[] = [];

        if (!result.dryRun && result.success && transactionId) {
          failedDevices = await pollKnoxUploadFailures(transactionId);
        }

        const failedIds = collectFailedKnoxUploadIdentifiers(failedDevices);
        const serialsToVerify = result.dryRun
          ? []
          : serialNumbers.filter((serialNumber: string) => !failedIds.has(serialNumber));
        const visibleSerials = result.dryRun
          ? new Set<string>()
          : await verifyKnoxVisibility(serialsToVerify);

        await Promise.all(serialNumbers.map((serialNumber: string) => {
          const failedByTransaction = failedIds.has(serialNumber);
          const visibleInKnox = result.dryRun
            ? false
            : !failedByTransaction && visibleSerials.has(serialNumber);
          const knoxUploadStatus = result.dryRun
            ? 'SKIPPED'
            : result.success && !failedByTransaction && visibleInKnox
              ? 'UPLOADED'
              : 'FAILED';
          const knoxUploadError = !result.success
            ? (result.error ?? 'Unknown error')
            : failedByTransaction
              ? extractKnoxUploadFailure(failedDevices, serialNumber)
              : result.dryRun
                ? null
                : visibleInKnox
                  ? null
                  : 'Upload completed but device is still not visible in Knox Guard lookup.';

          return prisma.inventoryItem.update({
            where: { serialNumber },
            data: {
              knoxUploadStatus,
              knoxUploadId: transactionId,
              knoxUploadError,
              knoxUploadRetries: { increment: 1 },
            },
          });
        }));
      })
      .catch(async (err) => {
        console.error(`[KnoxGuard] Bulk upload failed for ${serialNumbers.length} devices:`, err?.message ?? err);
        await prisma.inventoryItem.updateMany({
          where: { serialNumber: { in: serialNumbers } },
          data: {
            knoxUploadStatus: 'FAILED',
            knoxUploadError: err?.message ?? String(err),
            knoxUploadRetries: { increment: 1 },
          },
        });
      });

    res.status(201).json({ message: `${items.count} items added successfully` });
  } catch (error) {
    console.error('Add bulk inventory items error:', error);
    res.status(500).json({ error: 'Failed to add inventory items' });
  }
}

// Update inventory item (additional info)
export async function updateInventoryItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { productId, lockStatus, registeredUnder } = req.body;

    const existingItem = await prisma.inventoryItem.findUnique({
      where: { id },
      include: {
        product: true,
      },
    });

    if (!existingItem) {
      res.status(404).json({ error: 'Inventory item not found' });
      return;
    }

    // If productId is being changed, validate the new product exists
    if (productId && productId !== existingItem.productId) {
      const newProduct = await prisma.product.findUnique({
        where: { id: productId },
      });

      if (!newProduct) {
        res.status(404).json({ error: 'New product not found' });
        return;
      }
    }

    const updatedItem = await prisma.inventoryItem.update({
      where: { id },
      data: {
        productId: productId !== undefined ? productId : existingItem.productId,
        lockStatus: lockStatus !== undefined ? lockStatus : existingItem.lockStatus,
        registeredUnder: registeredUnder !== undefined ? registeredUnder : existingItem.registeredUnder,
      },
      include: {
        product: {
          include: {
            category: true,
          },
        },
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_INVENTORY_ITEM',
      entity: 'InventoryItem',
      entityId: updatedItem.id,
      oldValues: {
        productId: existingItem.productId,
        lockStatus: existingItem.lockStatus,
        registeredUnder: existingItem.registeredUnder
      },
      newValues: { productId, lockStatus, registeredUnder },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json(updatedItem);
  } catch (error) {
    console.error('Update inventory item error:', error);
    res.status(500).json({ error: 'Failed to update inventory item' });
  }
}

// Lock / unlock inventory item — MANAGE_DEVICE_CONTROL only
export async function updateInventoryLockStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { lockStatus } = req.body as { lockStatus?: string };

    if (lockStatus !== 'LOCKED' && lockStatus !== 'UNLOCKED') {
      res.status(400).json({ error: 'lockStatus must be LOCKED or UNLOCKED' });
      return;
    }

    const item = await prisma.inventoryItem.findUnique({
      where: { id },
      include: { managedDevice: { select: { id: true, contractId: true, enrollmentStatus: true, isActive: true } } },
    });

    if (!item) {
      res.status(404).json({ error: 'Inventory item not found' });
      return;
    }

    const enrolledDevice = item.managedDevice;
    const isKnoxEnrolled = enrolledDevice?.isActive &&
      ['ACTIVE', 'APPROVED', 'APPROVAL_QUEUED'].includes(enrolledDevice.enrollmentStatus ?? '');

    if (isKnoxEnrolled && enrolledDevice) {
      // Route through Knox Guard — this sends a real command to the device
      if (lockStatus === 'LOCKED') {
        await requestManagedDeviceLock(enrolledDevice.contractId);
      } else {
        await requestManagedDeviceUnlock(enrolledDevice.contractId);
      }
      // Fire the command processor immediately
      runDeviceControlSchedulerManually().catch(() => {});

      await createAuditLog({
        userId: req.user!.id,
        action: lockStatus === 'LOCKED' ? 'KNOX_LOCK_FROM_INVENTORY' : 'KNOX_UNLOCK_FROM_INVENTORY',
        entity: 'InventoryItem',
        entityId: id,
        oldValues: { lockStatus: item.lockStatus },
        newValues: { lockStatus, via: 'knox_guard' },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json({
        id: item.id,
        serialNumber: item.serialNumber,
        lockStatus: item.lockStatus, // DB value unchanged until Knox webhook confirms
        knoxCommandQueued: true,
        message: `Knox Guard ${lockStatus === 'LOCKED' ? 'lock' : 'unlock'} command queued and processing.`,
      });
      return;
    }

    // No Knox device — just update the local DB flag
    const updated = await prisma.inventoryItem.update({
      where: { id },
      data: { lockStatus },
      include: { product: { select: { name: true } } },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: lockStatus === 'LOCKED' ? 'LOCK_INVENTORY_ITEM' : 'UNLOCK_INVENTORY_ITEM',
      entity: 'InventoryItem',
      entityId: id,
      oldValues: { lockStatus: item.lockStatus },
      newValues: { lockStatus },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ id: updated.id, serialNumber: updated.serialNumber, lockStatus: updated.lockStatus, knoxCommandQueued: false });
  } catch (error) {
    console.error('Update inventory lock status error:', error);
    res.status(500).json({ error: 'Failed to update lock status' });
  }
}

// Delete inventory item
export async function deleteInventoryItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const existingItem = await prisma.inventoryItem.findUnique({
      where: { id },
      include: { product: true },
    });

    if (!existingItem) {
      res.status(404).json({ error: 'Inventory item not found' });
      return;
    }

    // Check if item is associated with a contract
    if (existingItem.contractId) {
      res.status(400).json({ error: 'Cannot delete inventory item that is associated with a contract' });
      return;
    }

    // Check if item is sold or reserved
    if (existingItem.status === 'SOLD' || existingItem.status === 'RESERVED') {
      res.status(400).json({ error: `Cannot delete inventory item with status: ${existingItem.status}` });
      return;
    }

    await prisma.inventoryItem.delete({
      where: { id },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'DELETE_INVENTORY_ITEM',
      entity: 'InventoryItem',
      entityId: id,
      oldValues: {
        serialNumber: existingItem.serialNumber,
        productId: existingItem.productId,
        lockStatus: existingItem.lockStatus,
        registeredUnder: existingItem.registeredUnder,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({ message: 'Inventory item deleted successfully' });
  } catch (error) {
    console.error('Delete inventory item error:', error);
    res.status(500).json({ error: 'Failed to delete inventory item' });
  }
}

// Get available inventory for a product
export async function getAvailableInventory(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { productId } = req.params;

    const items = await prisma.inventoryItem.findMany({
      where: {
        productId,
        status: 'AVAILABLE',
      },
      include: {
        product: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(items);
  } catch (error) {
    console.error('Get available inventory error:', error);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
}

// Get all inventory items
export async function getAllInventoryItems(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { page = 1, limit = 50, productId, status, search } = req.query;

    const where: Record<string, unknown> = {};

    if (productId) where.productId = productId;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { serialNumber: { contains: search as string } },
        { product: { name: { contains: search as string } } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.inventoryItem.findMany({
        where,
        include: {
          product: {
            include: { category: true },
          },
          contract: {
            select: {
              id: true,
              contractNumber: true,
              createdBy: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.inventoryItem.count({ where }),
    ]);

    res.json({
      items,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error) {
    console.error('Get all inventory items error:', error);
    res.status(500).json({ error: 'Failed to fetch inventory items' });
  }
}
