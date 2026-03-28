import { Router } from 'express';
import {
  getAllRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
  getAllPermissions,
} from '../controllers/roleController';
import { authenticateAdmin, requirePermission } from '../middleware/auth';

const router = Router();

// Specific routes MUST come before /:id to avoid being matched as a dynamic param
router.get('/permissions/all', authenticateAdmin, getAllPermissions);

// Role management routes
router.get('/', authenticateAdmin, getAllRoles);
router.get('/:id', authenticateAdmin, getRoleById);
router.post('/', authenticateAdmin, requirePermission('MANAGE_ROLES'), createRole);
router.put('/:id', authenticateAdmin, requirePermission('MANAGE_ROLES'), updateRole);
router.delete('/:id', authenticateAdmin, requirePermission('MANAGE_ROLES'), deleteRole);

export default router;
