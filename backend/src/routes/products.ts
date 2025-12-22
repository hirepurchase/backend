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
  deleteInventoryItem,
  getAvailableInventory,
  getAllInventoryItems,
} from '../controllers/productController';
import { authenticateAdmin, requirePermission } from '../middleware/auth';

const router = Router();

// All routes require admin authentication
router.use(authenticateAdmin);

// Categories
router.post('/categories', requirePermission('MANAGE_PRODUCTS'), createCategory);
router.get('/categories', getAllCategories);
router.put('/categories/:id', requirePermission('MANAGE_PRODUCTS'), updateCategory);
router.delete('/categories/:id', requirePermission('MANAGE_PRODUCTS'), deleteCategory);

// Products
router.post('/', requirePermission('MANAGE_PRODUCTS'), createProduct);
router.get('/', getAllProducts);

// Inventory - MUST be before /:id route to avoid matching issues
router.post('/inventory', requirePermission('MANAGE_INVENTORY'), addInventoryItem);
router.post('/inventory/bulk', requirePermission('MANAGE_INVENTORY'), addBulkInventoryItems);
router.put('/inventory/:id', requirePermission('EDIT_INVENTORY'), updateInventoryItem);
router.delete('/inventory/:id', requirePermission('DELETE_INVENTORY'), deleteInventoryItem);
router.get('/inventory', getAllInventoryItems); // General inventory endpoint
router.get('/inventory/all', getAllInventoryItems);
router.get('/:productId/inventory', getAvailableInventory);

// Product by ID - MUST be after inventory routes
router.get('/:id', getProductById);
router.put('/:id', requirePermission('EDIT_PRODUCT'), updateProduct);

export default router;
