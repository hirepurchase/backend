import { Router } from 'express';
import { sendCustomSMS, getSMSCustomers } from '../controllers/smsController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

// SEND_SMS is the dedicated permission; MANAGE_SETTINGS is kept so existing
// admins do not lose access, but it should not be what a messaging-only role
// is granted — it also unlocks data import and system settings.
router.get('/customers', authenticateAdmin, requireAnyPermission(PERMISSIONS.SEND_SMS, PERMISSIONS.MANAGE_SETTINGS), getSMSCustomers);
router.post('/send', authenticateAdmin, requireAnyPermission(PERMISSIONS.SEND_SMS, PERMISSIONS.MANAGE_SETTINGS), sendCustomSMS);

export default router;
