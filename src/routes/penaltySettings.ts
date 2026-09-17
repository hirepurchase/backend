import { Router } from 'express';
import {
  getPenaltyConfig,
  updatePenaltyConfig,
  previewExpiryPenalties,
  runExpiryPenalties,
  waivePenaltyCharge,
} from '../controllers/penaltySettingsController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

router.get('/', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), getPenaltyConfig);
router.put('/', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), updatePenaltyConfig);
// Deliberately separate from the save: an admin should be able to see the bill
// before agreeing to it.
router.post('/preview', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), previewExpiryPenalties);
router.post('/run', requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), runExpiryPenalties);

// Cancelling a charge is a higher bar than changing the rate: it touches one
// named customer's account, so it is gated on contract-value editing rather
// than general settings access.
router.post('/:penaltyId/waive', requireAnyPermission(PERMISSIONS.EDIT_CONTRACT_VALUES, PERMISSIONS.MANAGE_SETTINGS), waivePenaltyCharge);

export default router;
