import { Router } from 'express';
import { sendCustomSMS, getSMSCustomers } from '../controllers/smsController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

router.get('/customers', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), getSMSCustomers);
router.post('/send', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS), sendCustomSMS);

export default router;
