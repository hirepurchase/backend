import { Router } from 'express';
import {
  approveScorecard,
  closeScorecard,
  getConfiguration,
  getScorecard,
  markPaid,
  putIndicators,
  putSettings,
  recomputeScorecard,
  unmarkPaid,
} from '../controllers/clusterScorecardController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();
const manage = [authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_COMMISSION_SETTINGS)];

// Who may see which leaders is decided in the controller (leaders see only themselves).
router.get('/', authenticateAdmin, getScorecard);

router.get('/configuration', ...manage, getConfiguration);
router.put('/indicators', ...manage, putIndicators);
router.put('/settings', ...manage, putSettings);

router.post('/:month/close', ...manage, closeScorecard);
router.post('/:month/recompute', ...manage, recomputeScorecard);
router.post('/:month/approve', ...manage, approveScorecard);
router.post('/:month/payouts/:leaderId/paid', ...manage, markPaid);
router.post('/:month/payouts/:leaderId/unpaid', ...manage, unmarkPaid);

export default router;
