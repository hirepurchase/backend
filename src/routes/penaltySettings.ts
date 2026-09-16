import { Router } from 'express';
import {
  getPenaltyConfig,
  updatePenaltyConfig,
  previewExpiryPenalties,
  runExpiryPenalties,
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

export default router;
