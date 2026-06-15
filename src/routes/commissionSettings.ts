import { Router } from 'express';
import { getCommissionSettings, updateCommissionSettings } from '../controllers/commissionSettingsController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

router.get('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_COMMISSION_SETTINGS), getCommissionSettings);
router.put('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_COMMISSION_SETTINGS), updateCommissionSettings);

export default router;
