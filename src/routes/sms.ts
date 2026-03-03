import { Router } from 'express';
import { sendCustomSMS, getSMSCustomers } from '../controllers/smsController';
import { authenticateAdmin, requirePermission } from '../middleware/auth';

const router = Router();

router.get('/customers', authenticateAdmin, getSMSCustomers);
router.post('/send', authenticateAdmin, requirePermission('MANAGE_SETTINGS'), sendCustomSMS);

export default router;
