import express from 'express';
import multer from 'multer';
import { authenticateAdmin } from '../middleware/auth';
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
router.get('/templates/customers', authenticateAdmin, downloadCustomerTemplate);
router.get('/templates/products', authenticateAdmin, downloadProductTemplate);
router.get('/templates/inventory', authenticateAdmin, downloadInventoryTemplate);
router.get('/templates/contracts', authenticateAdmin, downloadContractTemplate);

// Import endpoints
router.post('/customers', authenticateAdmin, upload.single('file'), importCustomersFromExcel);
router.post('/products', authenticateAdmin, upload.single('file'), importProductsFromExcel);
router.post('/inventory', authenticateAdmin, upload.single('file'), importInventoryFromExcel);
router.post('/contracts', authenticateAdmin, upload.single('file'), importContractsFromExcel);

export default router;
