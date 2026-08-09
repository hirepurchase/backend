import { Router } from 'express';
import {
  getCsoDashboard,
  getVerificationQueue,
  getCsoCallQueue,
  getDueFollowUps,
} from '../controllers/customerServiceController';
import { getMyAssignedAgents } from '../controllers/csoAssignmentController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

router.get('/dashboard', requireAnyPermission(PERMISSIONS.VIEW_DASHBOARD), getCsoDashboard);
router.get('/verification-queue', requireAnyPermission(PERMISSIONS.VERIFY_CUSTOMER), getVerificationQueue);
router.get('/call-queue', requireAnyPermission(PERMISSIONS.MANAGE_CONTACT_ATTEMPTS), getCsoCallQueue);
router.get('/follow-ups', requireAnyPermission(PERMISSIONS.MANAGE_CONTACT_ATTEMPTS), getDueFollowUps);
router.get('/my-agents', requireAnyPermission(PERMISSIONS.VIEW_ASSIGNED_CONTRACTS), getMyAssignedAgents);

export default router;
