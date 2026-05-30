import { Router } from 'express';
import {
  createCategory,
  getAllCategories,
  updateCategory,
  deleteCategory,
  createProduct,
  getAllProducts,
  getProductById,
  updateProduct,
  addInventoryItem,
  addBulkInventoryItems,
  updateInventoryItem,
  updateInventoryLockStatus,
  deleteInventoryItem,
  getAvailableInventory,
  getAllInventoryItems,
} from '../controllers/productController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

// All routes require admin authentication
router.use(authenticateAdmin);

// Categories
router.post('/categories', requireAnyPermission(PERMISSIONS.MANAGE_PRODUCTS), createCategory);
router.get('/categories', getAllCategories);
router.put('/categories/:id', requireAnyPermission(PERMISSIONS.MANAGE_PRODUCTS), updateCategory);
router.delete('/categories/:id', requireAnyPermission(PERMISSIONS.MANAGE_PRODUCTS), deleteCategory);

// Products
router.post('/', requireAnyPermission(PERMISSIONS.MANAGE_PRODUCTS), createProduct);
router.get('/', getAllProducts);

// Inventory - MUST be before /:id route to avoid matching issues
router.post('/inventory', requireAnyPermission(PERMISSIONS.MANAGE_INVENTORY), addInventoryItem);
router.post('/inventory/bulk', requireAnyPermission(PERMISSIONS.MANAGE_INVENTORY), addBulkInventoryItems);
router.put('/inventory/:id', requireAnyPermission(PERMISSIONS.EDIT_INVENTORY), updateInventoryItem);
router.patch('/inventory/:id/lock-status', requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL), updateInventoryLockStatus);
router.delete('/inventory/:id', requireAnyPermission(PERMISSIONS.DELETE_INVENTORY), deleteInventoryItem);
router.get('/inventory', getAllInventoryItems); // General inventory endpoint
router.get('/inventory/all', getAllInventoryItems);
router.get('/:productId/inventory', getAvailableInventory);

// Product by ID - MUST be after inventory routes
router.get('/:id', getProductById);
router.put('/:id', requireAnyPermission(PERMISSIONS.EDIT_PRODUCT), updateProduct);

export default router;
