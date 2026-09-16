import { Router } from 'express';
import { getMyClusterAgents } from '../controllers/clusterAssignmentController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

// The signed-in cluster agent's own team. Scoped to the caller, so the
// assigned-contracts permission the role already carries is the right gate.
router.get('/my-agents', requireAnyPermission(PERMISSIONS.VIEW_ASSIGNED_CONTRACTS), getMyClusterAgents);

export default router;
