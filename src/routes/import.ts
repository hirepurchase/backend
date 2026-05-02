import express from 'express';
import multer from 'multer';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import {
  importCustomersFromExcel,
  importProductsFromExcel,
  importInventoryFromExcel,
  importContractsFromExcel,
  downloadCustomerTemplate,
  downloadProductTemplate,
  downloadInventoryTemplate,
  downloadContractTemplate,
} from '../controllers/importController';
import { PERMISSIONS } from '../constants/permissions';

const router = express.Router();

// Configure multer for Excel file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xls, .xlsx) are allowed'));
    }
  },
});

// Download templates
router.get('/templates/customers', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), downloadCustomerTemplate);
router.get('/templates/products', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), downloadProductTemplate);
router.get('/templates/inventory', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), downloadInventoryTemplate);
router.get('/templates/contracts', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), downloadContractTemplate);

// Import endpoints
router.post('/customers', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), upload.single('file'), importCustomersFromExcel);
router.post('/products', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), upload.single('file'), importProductsFromExcel);
router.post('/inventory', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), upload.single('file'), importInventoryFromExcel);
router.post('/contracts', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), upload.single('file'), importContractsFromExcel);

export default router;
