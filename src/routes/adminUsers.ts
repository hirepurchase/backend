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
} from '../controllers/csoAssignmentController';
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

router.put('/:id', requireAnyPermission(PERMISSIONS.MANAGE_USERS), updateAdminUser);

// Roles and permissions
router.get('/roles', requireAnyPermission(...ROLE_DIRECTORY_ACCESS_PERMISSIONS), getRoles);
router.get('/permissions', requireAnyPermission(PERMISSIONS.MANAGE_ROLES), getPermissions);

export default router;
