import { Router } from 'express';
import {
  getSalesReport,
  getPaymentReport,
  getDefaultReport,
  getInventoryReport,
  getDashboardStats,
} from '../controllers/reportController';
import { authenticateAdmin, requirePermission } from '../middleware/auth';

const router = Router();

// Dashboard statistics (no special permission required - all admins can see)
router.get('/dashboard', authenticateAdmin, getDashboardStats);

// Standard reports (require VIEW_REPORTS permission)
router.get('/sales', authenticateAdmin, requirePermission('VIEW_REPORTS'), getSalesReport);
router.get('/payments', authenticateAdmin, requirePermission('VIEW_REPORTS'), getPaymentReport);
router.get('/defaults', authenticateAdmin, requirePermission('VIEW_REPORTS'), getDefaultReport);
router.get('/inventory', authenticateAdmin, requirePermission('VIEW_REPORTS'), getInventoryReport);

export default router;
