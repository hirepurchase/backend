import { Router } from 'express';
import {
  getMyLedger,
  getMySummary,
  payDeposit,
  handleAgentPaymentCallback,
  getAllAgentLedgers,
  getAdminSummary,
  adminManualPay,
} from '../controllers/agentDepositController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

// Webhook — no auth, called by Hubtel
router.post('/hubtel/callback', handleAgentPaymentCallback);

// Agent routes
router.get('/my-ledger', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_AGENT_COMMISSIONS), getMyLedger);
router.get('/my-summary', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_AGENT_COMMISSIONS), getMySummary);
router.post('/:id/pay', authenticateAdmin, requireAnyPermission(PERMISSIONS.PAY_AGENT_DEPOSIT), payDeposit);

// Admin routes
router.post('/:id/admin-pay', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_AGENT_LEDGER), adminManualPay);
router.get('/admin/all-ledgers', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_AGENT_LEDGER), getAllAgentLedgers);
router.get('/admin/summary', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_AGENT_LEDGER), getAdminSummary);

export default router;
