import { Router } from 'express';
import {
  getAllAdminUsers,
  createAdminUser,
  updateAdminUser,
  changePassword,
  getRoles,
  getPermissions,
} from '../controllers/adminUserController';
import { authenticateAdmin, requireSuperAdmin } from '../middleware/auth';

const router = Router();

// All routes require admin authentication
router.use(authenticateAdmin);

// Admin user management (Super Admin only)
router.get('/', requireSuperAdmin, getAllAdminUsers);
router.post('/', requireSuperAdmin, createAdminUser);
router.put('/:id', updateAdminUser);
router.post('/change-password', changePassword);

// Roles and permissions
router.get('/roles', getRoles);
router.get('/permissions', requireSuperAdmin, getPermissions);

export default router;
