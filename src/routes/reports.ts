import { Router } from 'express';
import {
  getSalesReport,
  getPaymentReport,
  getDefaultReport,
  getInventoryReport,
  getDashboardStats,
  getPreapprovalsReport,
  getIncomeReport,
  getDailyPayments,
  getAgentReport,
  getAgentDashboard,
} from '../controllers/reportController';
import { authenticateAdmin, requirePermission } from '../middleware/auth';

const router = Router();

// Dashboard statistics
router.get('/dashboard', authenticateAdmin, requirePermission('VIEW_DASHBOARD'), getDashboardStats);

// Agent personal dashboard (scoped to the logged-in agent)
router.get('/agent-dashboard', authenticateAdmin, requirePermission('VIEW_DASHBOARD'), getAgentDashboard);

// Standard reports (require VIEW_REPORTS permission)
router.get('/sales', authenticateAdmin, requirePermission('VIEW_REPORTS'), getSalesReport);
router.get('/payments', authenticateAdmin, requirePermission('VIEW_REPORTS'), getPaymentReport);
router.get('/defaults', authenticateAdmin, requirePermission('VIEW_REPORTS'), getDefaultReport);
router.get('/inventory', authenticateAdmin, requirePermission('VIEW_REPORTS'), getInventoryReport);
router.get('/preapprovals', authenticateAdmin, requirePermission('VIEW_REPORTS'), getPreapprovalsReport);
router.get('/income', authenticateAdmin, requirePermission('VIEW_REPORTS'), getIncomeReport);
router.get('/agents', authenticateAdmin, requirePermission('VIEW_REPORTS'), getAgentReport);
router.get('/daily-payments', authenticateAdmin, requirePermission('VIEW_DAILY_PAYMENTS'), getDailyPayments);

export default router;
