import { Router } from 'express';
import {
  createTemporaryUnlockRequest,
  approveTemporaryUnlockRequest,
  rejectTemporaryUnlockRequest,
  cancelTemporaryUnlockRequest,
  listTemporaryUnlockRequests,
  getPendingTemporaryUnlockCount,
  getEligibleContracts,
} from '../controllers/temporaryUnlockController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';
import { TEMPORARY_UNLOCK_ACCESS_PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

// Static paths first — an /:id route would otherwise swallow them.
router.get('/pending-count', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), getPendingTemporaryUnlockCount);
router.get('/eligible-contracts', requireAnyPermission(PERMISSIONS.REQUEST_TEMPORARY_UNLOCK), getEligibleContracts);

router.get('/', requireAnyPermission(...TEMPORARY_UNLOCK_ACCESS_PERMISSIONS), listTemporaryUnlockRequests);
router.post('/', requireAnyPermission(PERMISSIONS.REQUEST_TEMPORARY_UNLOCK), createTemporaryUnlockRequest);
router.post('/:id/approve', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), approveTemporaryUnlockRequest);
router.post('/:id/reject', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), rejectTemporaryUnlockRequest);
router.post('/:id/cancel', requireAnyPermission(PERMISSIONS.REQUEST_TEMPORARY_UNLOCK), cancelTemporaryUnlockRequest);

export default router;
