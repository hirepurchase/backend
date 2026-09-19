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
  getAgentOverdueInstallments,
  getAgentUpcomingInstallments,
  getAgentCompletedContracts,
  getAgentCompletionsReport,
} from '../controllers/reportController';
import { getPortfolioAtRiskReport, getAgentAtRiskContracts } from '../controllers/portfolioRiskController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { DASHBOARD_ACCESS_PERMISSIONS, DAILY_PAYMENTS_ACCESS_PERMISSIONS, PERMISSIONS } from '../constants/permissions';

const router = Router();

// Dashboard statistics. The grouped access rule keeps dashboard behavior aligned
// across the main dashboard and the agent-scoped dashboard.
router.get('/dashboard', authenticateAdmin, requireAnyPermission(...DASHBOARD_ACCESS_PERMISSIONS), getDashboardStats);

// Agent personal dashboard (scoped to the logged-in agent)
router.get('/agent-dashboard', authenticateAdmin, requireAnyPermission(...DASHBOARD_ACCESS_PERMISSIONS), getAgentDashboard);
router.get('/agent-dashboard/overdue-installments', authenticateAdmin, requireAnyPermission(...DASHBOARD_ACCESS_PERMISSIONS), getAgentOverdueInstallments);
router.get('/agent-dashboard/upcoming-installments', authenticateAdmin, requireAnyPermission(...DASHBOARD_ACCESS_PERMISSIONS), getAgentUpcomingInstallments);
router.get('/agent-dashboard/completed-contracts', authenticateAdmin, requireAnyPermission(...DASHBOARD_ACCESS_PERMISSIONS), getAgentCompletedContracts);

// Standard reports (require VIEW_REPORTS permission)
router.get('/sales', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getSalesReport);
router.get('/payments', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getPaymentReport);
router.get('/defaults', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getDefaultReport);
router.get('/inventory', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getInventoryReport);
router.get('/preapprovals', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getPreapprovalsReport);
router.get('/income', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getIncomeReport);
router.get('/agents', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getAgentReport);
// Per-agent completions for a month — the basis for completion bonuses
// Portfolio at risk. Scoped inside the controller: an admin sees the whole
// book, a cluster leader only their own team.
router.get('/portfolio-at-risk', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_ASSIGNED_CONTRACTS), getPortfolioAtRiskReport);
router.get('/portfolio-at-risk/:agentId', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS, PERMISSIONS.VIEW_ASSIGNED_CONTRACTS), getAgentAtRiskContracts);

router.get('/agent-completions', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_REPORTS), getAgentCompletionsReport);
router.get('/daily-payments', authenticateAdmin, requireAnyPermission(...DAILY_PAYMENTS_ACCESS_PERMISSIONS), getDailyPayments);

export default router;
