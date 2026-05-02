import { Router } from 'express';
import {
  getAllAdminUsers,
  createAdminUser,
  updateAdminUser,
  changePassword,
  getRoles,
  getPermissions,
} from '../controllers/adminUserController';
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
router.put('/:id', requireAnyPermission(PERMISSIONS.MANAGE_USERS), updateAdminUser);
router.post('/change-password', changePassword);

// Roles and permissions
router.get('/roles', requireAnyPermission(...ROLE_DIRECTORY_ACCESS_PERMISSIONS), getRoles);
router.get('/permissions', requireAnyPermission(PERMISSIONS.MANAGE_ROLES), getPermissions);

export default router;
