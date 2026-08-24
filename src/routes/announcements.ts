import { Router } from 'express';
import {
  createAnnouncement,
  listAnnouncements,
  deactivateAnnouncement,
  getMyActiveAnnouncements,
} from '../controllers/announcementController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

// Any signed-in staff member checks their own active announcements.
router.get('/mine', authenticateAdmin, getMyActiveAnnouncements);

// Admin-only management.
router.get('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_ANNOUNCEMENTS), listAnnouncements);
router.post('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_ANNOUNCEMENTS), createAnnouncement);
router.post('/:id/deactivate', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_ANNOUNCEMENTS), deactivateAnnouncement);

export default router;
