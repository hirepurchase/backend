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
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { DASHBOARD_ACCESS_PERMISSIONS, PERMISSIONS } from '../constants/permissions';

const router = Router();

// Dashboard statistics. The grouped access rule keeps dashboard behavior aligned
// across the main dashboard and the agent-scoped dashboard.
router.get('/dashboard', authenticateAdmin, requireAnyPermission(...DASHBOARD_ACCESS_PERMISSIONS), getDashboardStats);

// Agent personal dashboard (scoped to the logged-in agent)
router.get('/agent-dashboard', authenticateAdmin, requireAnyPermission(...DASHBOARD_ACCESS_PERMISSIONS), getAgentDashboard);

// Standard reports (require VIEW_REPORTS permission)
router.get('/sales', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getSalesReport);
router.get('/payments', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getPaymentReport);
router.get('/defaults', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getDefaultReport);
router.get('/inventory', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getInventoryReport);
router.get('/preapprovals', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getPreapprovalsReport);
router.get('/income', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getIncomeReport);
router.get('/agents', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getAgentReport);
router.get('/daily-payments', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_DAILY_PAYMENTS), getDailyPayments);

export default router;
