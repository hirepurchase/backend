import { Router } from 'express';
import { getOfficerAgents, getOfficers, getTransferHistory, transferWelcomeCalls } from '../controllers/welcomeCallController';
import { getTodaysAllocations, reshareTodaysCalls } from '../controllers/callAllocationController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();
const manage = [authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_CSO_ASSIGNMENTS)];

// Who makes welcome calls for which agents, and moving agents between them.
router.get('/officers', ...manage, getOfficers);
router.get('/officers/:id/agents', ...manage, getOfficerAgents);
router.post('/transfer', ...manage, transferWelcomeCalls);
router.get('/history', ...manage, getTransferHistory);

// Today's shared recovery and reminder calls for customer service.
router.get('/allocations/today', ...manage, getTodaysAllocations);
router.post('/allocations/reshare', ...manage, reshareTodaysCalls);

export default router;
