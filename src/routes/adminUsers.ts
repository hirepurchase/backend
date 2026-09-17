import { Router } from 'express';
import {
  getAllAdminUsers,
  createAdminUser,
  updateAdminUser,
  changePassword,
  getRoles,
  getPermissions,
} from '../controllers/adminUserController';
import {
  getAssignedAgents,
  setAssignedAgents,
  getMyCustomerServiceOfficers,
  getCustomerServiceChart,
} from '../controllers/csoAssignmentController';
import {
  getAgentSupervision,
  setAgentSupervision,
  updateSupervisionSettings,
  bulkSetAgentSupervision,
} from '../controllers/agentSupervisionController';
import {
  getClusterAgents,
  setClusterAgents,
} from '../controllers/clusterAssignmentController';
import { authenticateAdmin, requireAnyPermission, requireSuperAdmin } from '../middleware/auth';
import {
  PERMISSIONS,
  ROLE_DIRECTORY_ACCESS_PERMISSIONS,
} from '../constants/permissions';

const router = Router();

// All routes require admin authentication
router.use(authenticateAdmin);

// Admin user management (Super Admin only)
router.get('/', requireSuperAdmin, getAllAdminUsers);
router.post('/', requireSuperAdmin, createAdminUser);
router.post('/change-password', changePassword);

// An agent's own customer service officers. Authentication only — it returns
// nothing but the caller's own supervisors, so no extra permission is needed.
router.get('/me/customer-service', getMyCustomerServiceOfficers);

// Directory of officers and the agents they cover. Contact details only, no
// customer data, so any signed-in staff member may read it.
router.get('/customer-service-chart', getCustomerServiceChart);

// Registered above '/:id' so the literal path is not swallowed by the
// parameterised route below.
router.get(
  '/agent-supervision',
  requireAnyPermission(PERMISSIONS.MANAGE_USERS, PERMISSIONS.MANAGE_CSO_ASSIGNMENTS, PERMISSIONS.MANAGE_CLUSTER_ASSIGNMENTS),
  getAgentSupervision
);
router.put(
  '/agent-supervision/settings',
  requireAnyPermission(PERMISSIONS.MANAGE_SETTINGS),
  updateSupervisionSettings
);
router.put(
  '/agent-supervision/bulk',
  requireAnyPermission(PERMISSIONS.MANAGE_CSO_ASSIGNMENTS, PERMISSIONS.MANAGE_CLUSTER_ASSIGNMENTS),
  bulkSetAgentSupervision
);
router.put(
  '/agent-supervision',
  requireAnyPermission(PERMISSIONS.MANAGE_CSO_ASSIGNMENTS, PERMISSIONS.MANAGE_CLUSTER_ASSIGNMENTS),
  setAgentSupervision
);

// Customer service officer -> agent assignments (before /:id so it isn't shadowed)
router.get(
  '/:id/assigned-agents',
  requireAnyPermission(PERMISSIONS.MANAGE_CSO_ASSIGNMENTS, PERMISSIONS.MANAGE_USERS),
  getAssignedAgents
);
router.put(
  '/:id/assigned-agents',
  requireAnyPermission(PERMISSIONS.MANAGE_CSO_ASSIGNMENTS),
  setAssignedAgents
);

// Cluster agent -> agent assignments (also before /:id)
router.get(
  '/:id/cluster-agents',
  requireAnyPermission(PERMISSIONS.MANAGE_CLUSTER_ASSIGNMENTS, PERMISSIONS.MANAGE_USERS),
  getClusterAgents
);
router.put(
  '/:id/cluster-agents',
  requireAnyPermission(PERMISSIONS.MANAGE_CLUSTER_ASSIGNMENTS),
  setClusterAgents
);

router.put('/:id', requireAnyPermission(PERMISSIONS.MANAGE_USERS), updateAdminUser);

// Roles and permissions
router.get('/roles', requireAnyPermission(...ROLE_DIRECTORY_ACCESS_PERMISSIONS), getRoles);
router.get('/permissions', requireAnyPermission(PERMISSIONS.MANAGE_ROLES), getPermissions);

export default router;
