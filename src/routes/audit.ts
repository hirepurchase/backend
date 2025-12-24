import { Router } from 'express';
import {
  getAuditLogs,
  getAuditLogStats,
  getAuditActions,
  getAuditEntities,
} from '../controllers/auditController';
import { authenticateAdmin, requirePermission } from '../middleware/auth';

const router = Router();

// Audit log routes
router.get('/', authenticateAdmin, requirePermission('VIEW_AUDIT_LOGS'), getAuditLogs);
router.get('/stats', authenticateAdmin, requirePermission('VIEW_AUDIT_LOGS'), getAuditLogStats);
router.get('/actions', authenticateAdmin, requirePermission('VIEW_AUDIT_LOGS'), getAuditActions);
router.get('/entities', authenticateAdmin, requirePermission('VIEW_AUDIT_LOGS'), getAuditEntities);

export default router;
