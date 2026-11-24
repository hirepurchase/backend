import { Router } from 'express';
import { authenticateAdmin, requireAnyPermission, requireSuperAdmin } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';
import { getPayable, getPayoutSettings, hubtelPayoutCallback, postSend, putPayoutSettings } from '../controllers/commissionPayoutController';

const router = Router();

// Hubtel reports payout results here; no login (token-checked, then re-checked with Hubtel).
router.post('/hubtel/callback', hubtelPayoutCallback as any);

router.use(authenticateAdmin);
router.get('/settings', requireSuperAdmin, getPayoutSettings);
router.put('/settings', requireSuperAdmin, putPayoutSettings);
// Seeing who would be paid is open to those who run the months; sending is super admins only.
router.get('/:kind/:month', requireAnyPermission(PERMISSIONS.MANAGE_AGENT_LEDGER, PERMISSIONS.MANAGE_COMMISSION_SETTINGS), getPayable);
router.post('/:kind/:month/send', requireSuperAdmin, postSend);

export default router;
