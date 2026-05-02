import { Router } from 'express';
import {
  getAllRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  getAllPermissions,
} from '../controllers/roleController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import {
  PERMISSIONS,
  ROLE_DIRECTORY_ACCESS_PERMISSIONS,
} from '../constants/permissions';

const router = Router();

// Specific routes MUST come before /:id to avoid being matched as a dynamic param
router.get('/permissions/all', authenticateAdmin, requireAnyPermission(...ROLE_DIRECTORY_ACCESS_PERMISSIONS), getAllPermissions);

// Role management routes
router.get('/', authenticateAdmin, requireAnyPermission(...ROLE_DIRECTORY_ACCESS_PERMISSIONS), getAllRoles);
router.get('/:id', authenticateAdmin, requireAnyPermission(...ROLE_DIRECTORY_ACCESS_PERMISSIONS), getRoleById);
router.post('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_ROLES), createRole);
router.put('/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_ROLES), updateRole);
router.delete('/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_ROLES), deleteRole);

export default router;
