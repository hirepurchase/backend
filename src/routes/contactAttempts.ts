import { Router } from 'express';
import {
  createContactAttempt,
  listContactAttempts,
  getCustomerContactHistory,
} from '../controllers/contactAttemptController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS, CUSTOMER_ACCESS_PERMISSIONS } from '../constants/permissions';

const router = Router();

router.use(authenticateAdmin);

router.post('/', requireAnyPermission(PERMISSIONS.MANAGE_CONTACT_ATTEMPTS), createContactAttempt);
router.get('/', requireAnyPermission(PERMISSIONS.MANAGE_CONTACT_ATTEMPTS), listContactAttempts);
router.get(
  '/customer/:customerId',
  requireAnyPermission(PERMISSIONS.MANAGE_CONTACT_ATTEMPTS, ...CUSTOMER_ACCESS_PERMISSIONS),
  getCustomerContactHistory
);

export default router;
