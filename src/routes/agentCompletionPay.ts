import { Router } from 'express';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';
import {
  approveCompletionPay,
  closeCompletionPay,
  getCompletionPayMonth,
  getCompletionPaySettings,
  getMyCompletionPay,
  markCompletionPayPaid,
  putCompletionPaySettings,
  recomputeCompletionPay,
  reopenCompletionPay,
  unmarkCompletionPayPaid,
} from '../controllers/agentCompletionPayController';

const router = Router();
router.use(authenticateAdmin);

const settings = requireAnyPermission(PERMISSIONS.MANAGE_COMMISSION_SETTINGS);
const run = requireAnyPermission(PERMISSIONS.MANAGE_AGENT_LEDGER);

router.get('/settings', requireAnyPermission(PERMISSIONS.MANAGE_COMMISSION_SETTINGS, PERMISSIONS.MANAGE_AGENT_LEDGER), getCompletionPaySettings);
router.put('/settings', settings, putCompletionPaySettings);
router.get('/mine', requireAnyPermission(PERMISSIONS.VIEW_AGENT_COMMISSIONS), getMyCompletionPay);
router.get('/:month', run, getCompletionPayMonth);
router.post('/:month/close', run, closeCompletionPay);
router.post('/:month/recompute', run, recomputeCompletionPay);
router.post('/:month/reopen', run, reopenCompletionPay);
router.post('/:month/approve', run, approveCompletionPay);
router.post('/:month/payouts/:agentId/paid', run, markCompletionPayPaid);
router.post('/:month/payouts/:agentId/unpaid', run, unmarkCompletionPayPaid);

export default router;
