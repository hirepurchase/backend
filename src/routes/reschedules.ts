import { Router } from 'express';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';
import {
  approveRescheduleRequest,
  createContractReschedule,
  getReschedule,
  getRescheduleConfig,
  listContractReschedules,
  listReschedules,
  previewContractReschedule,
  rejectRescheduleRequest,
  runAutomaticReschedules,
  updateRescheduleConfig,
} from '../controllers/rescheduleController';

const router = Router();
router.use(authenticateAdmin);

// Asking is open to anyone who can change a contract; deciding changes what
// the customer owes, so it needs contract-value editing, and never by the asker.
const ASK = requireAnyPermission(PERMISSIONS.UPDATE_CONTRACT, PERMISSIONS.EDIT_CONTRACT_VALUES);
const DECIDE = requireAnyPermission(PERMISSIONS.EDIT_CONTRACT_VALUES);
const SEE = requireAnyPermission(PERMISSIONS.VIEW_CONTRACTS, PERMISSIONS.UPDATE_CONTRACT, PERMISSIONS.EDIT_CONTRACT_VALUES);

router.get('/settings', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), getRescheduleConfig);
router.put('/settings', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), updateRescheduleConfig);
router.post('/settings/run', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), runAutomaticReschedules);

router.get('/contract/:contractId/preview', ASK, previewContractReschedule);
router.post('/contract/:contractId', ASK, createContractReschedule);
router.get('/contract/:contractId', SEE, listContractReschedules);

router.get('/', DECIDE, listReschedules);
router.get('/:id', SEE, getReschedule);
router.post('/:id/approve', DECIDE, approveRescheduleRequest);
router.post('/:id/reject', DECIDE, rejectRescheduleRequest);

export default router;
