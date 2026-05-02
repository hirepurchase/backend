import { Router } from 'express';
import {
  getAuditLogs,
  getAuditLogStats,
  getAuditActions,
  getAuditEntities,
} from '../controllers/auditController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

// Audit log routes
router.get('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_AUDIT_LOGS), getAuditLogs);
router.get('/stats', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_AUDIT_LOGS), getAuditLogStats);
router.get('/actions', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_AUDIT_LOGS), getAuditActions);
router.get('/entities', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_AUDIT_LOGS), getAuditEntities);

export default router;
