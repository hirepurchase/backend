import { Router } from 'express';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';
import { getMyEarnings } from '../controllers/earningsController';

const router = Router();
router.get('/mine', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_AGENT_COMMISSIONS), getMyEarnings);
export default router;
