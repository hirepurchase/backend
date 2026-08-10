import { Router } from 'express';
import {
  createContactAttempt,
  listContactAttempts,
  getContactAttemptOfficers,
  getCustomerContactHistory,
} from '../controllers/contactAttemptController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS, CUSTOMER_ACCESS_PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

// Logging a call requires the officer permission; reviewing the log is also
// open to supervisors who hold audit or report access. Results stay scoped
// either way, so a reviewer only ever sees calls within their own portfolio.
const REVIEW_ACCESS = [
  PERMISSIONS.MANAGE_CONTACT_ATTEMPTS,
  PERMISSIONS.VIEW_AUDIT_LOGS,
  PERMISSIONS.VIEW_REPORTS,
] as const;

router.post('/', requireAnyPermission(PERMISSIONS.MANAGE_CONTACT_ATTEMPTS), createContactAttempt);
router.get('/', requireAnyPermission(...REVIEW_ACCESS), listContactAttempts);
router.get('/officers', requireAnyPermission(...REVIEW_ACCESS), getContactAttemptOfficers);
router.get(
  '/customer/:customerId',
  requireAnyPermission(...REVIEW_ACCESS, ...CUSTOMER_ACCESS_PERMISSIONS),
  getCustomerContactHistory
);

export default router;
