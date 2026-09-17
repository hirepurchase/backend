import { Router } from 'express';
import { getMyClusterAgents, getClusterCoverage } from '../controllers/clusterAssignmentController';
import {
  getClusterStock,
  transferClusterStock,
  getStockTransferHistory,
  getAgentStockItems,
} from '../controllers/clusterStockController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

// The signed-in cluster agent's own team. Scoped to the caller, so the
// assigned-contracts permission the role already carries is the right gate.
router.get('/my-agents', requireAnyPermission(PERMISSIONS.VIEW_ASSIGNED_CONTRACTS), getMyClusterAgents);

// Who supervises nobody. Gated like the assignment screens, since it is an
// administrative view of the whole hierarchy rather than one supervisor's team.
router.get('/coverage', requireAnyPermission(PERMISSIONS.MANAGE_CLUSTER_ASSIGNMENTS, PERMISSIONS.MANAGE_USERS), getClusterCoverage);

// Stock held by the caller's own agents. Scoped inside the controller rather
// than by permission, since a cluster agent and an admin hit the same route and
// should see different books.
router.get('/stock', requireAnyPermission(PERMISSIONS.VIEW_ASSIGNED_CONTRACTS, PERMISSIONS.MANAGE_INVENTORY), getClusterStock);
router.get('/stock/items', requireAnyPermission(PERMISSIONS.VIEW_ASSIGNED_CONTRACTS, PERMISSIONS.MANAGE_INVENTORY), getAgentStockItems);
router.get('/stock/history', requireAnyPermission(PERMISSIONS.VIEW_ASSIGNED_CONTRACTS, PERMISSIONS.MANAGE_INVENTORY), getStockTransferHistory);
router.post('/stock/transfer', requireAnyPermission(PERMISSIONS.VIEW_ASSIGNED_CONTRACTS, PERMISSIONS.MANAGE_INVENTORY), transferClusterStock);

export default router;
