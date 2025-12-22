import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { AuthenticatedRequest } from '../types';

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
    const { lockStatus, registeredUnder } = req.body;

    const existingItem = await prisma.inventoryItem.findUnique({
      where: { id },
    });

    if (!existingItem) {
      res.status(404).json({ error: 'Inventory item not found' });
      return;
    }

    const updatedItem = await prisma.inventoryItem.update({
      where: { id },
      data: {
        lockStatus: lockStatus !== undefined ? lockStatus : existingItem.lockStatus,
        registeredUnder: registeredUnder !== undefined ? registeredUnder : existingItem.registeredUnder,
      },
      include: {
        product: true,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_INVENTORY_ITEM',
      entity: 'InventoryItem',
      entityId: updatedItem.id,
      oldValues: { lockStatus: existingItem.lockStatus, registeredUnder: existingItem.registeredUnder },
      newValues: { lockStatus, registeredUnder },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json(updatedItem);
  } catch (error) {
    console.error('Update inventory item error:', error);
    res.status(500).json({ error: 'Failed to update inventory item' });
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
              customer: {
                select: {
                  id: true,
                  membershipId: true,
                  firstName: true,
                  lastName: true,
                },
              },
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
