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

// Role management routes
router.get('/', authenticateAdmin, getAllRoles);
router.get('/:id', authenticateAdmin, getRoleById);
router.post('/', authenticateAdmin, requirePermission('MANAGE_ROLES'), createRole);
router.put('/:id', authenticateAdmin, requirePermission('MANAGE_ROLES'), updateRole);
router.delete('/:id', authenticateAdmin, requirePermission('MANAGE_ROLES'), deleteRole);

// Permission routes
router.get('/permissions/all', authenticateAdmin, getAllPermissions);

export default router;
