import { Router } from 'express';
import {
  createTemporaryUnlockRequest,
  approveTemporaryUnlockRequest,
  rejectTemporaryUnlockRequest,
  cancelTemporaryUnlockRequest,
  revokeTemporaryUnlockRequest,
  listTemporaryUnlockRequests,
  getPendingTemporaryUnlockCount,
  getEligibleContracts,
  getTemporaryUnlockSettings,
  updateTemporaryUnlockSettings,
  extendTemporaryUnlockRequest,
  getOwingAfterUnlock,
} from '../controllers/temporaryUnlockController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';
import { TEMPORARY_UNLOCK_ACCESS_PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

// Static paths first — an /:id route would otherwise swallow them.
router.get('/pending-count', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), getPendingTemporaryUnlockCount);
router.get('/settings', requireAnyPermission(...TEMPORARY_UNLOCK_ACCESS_PERMISSIONS), getTemporaryUnlockSettings);
router.put('/settings', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), updateTemporaryUnlockSettings);
// Each caller sees their own scope: agents, leaders and approvers alike.
router.get('/owing', getOwingAfterUnlock);
router.get('/eligible-contracts', requireAnyPermission(PERMISSIONS.REQUEST_TEMPORARY_UNLOCK), getEligibleContracts);

router.get('/', requireAnyPermission(...TEMPORARY_UNLOCK_ACCESS_PERMISSIONS), listTemporaryUnlockRequests);
router.post('/', requireAnyPermission(PERMISSIONS.REQUEST_TEMPORARY_UNLOCK), createTemporaryUnlockRequest);
router.post('/:id/approve', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), approveTemporaryUnlockRequest);
router.post('/:id/reject', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), rejectTemporaryUnlockRequest);
router.post('/:id/cancel', requireAnyPermission(PERMISSIONS.REQUEST_TEMPORARY_UNLOCK), cancelTemporaryUnlockRequest);

// Ending a live window is an approver's decision, not the requester's.
router.post('/:id/extend', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), extendTemporaryUnlockRequest);
router.post('/:id/revoke', requireAnyPermission(PERMISSIONS.APPROVE_TEMPORARY_UNLOCK), revokeTemporaryUnlockRequest);

export default router;
