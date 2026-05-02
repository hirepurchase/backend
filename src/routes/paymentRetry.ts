import express from 'express';
import {
  getSettings,
  updateSettings,
  getFailedPaymentsList,
  retrySinglePayment,
  retryMultiplePayments,
  retryAllPayments,
  getRetryHistory,
} from '../controllers/paymentRetryController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = express.Router();

// All routes require admin authentication
router.use(authenticateAdmin);

// Retry settings routes
router.get('/settings', requireAnyPermission(PERMISSIONS.MANAGE_HUBTEL_PAYMENTS), getSettings);
router.put('/settings', requireAnyPermission(PERMISSIONS.MANAGE_HUBTEL_PAYMENTS), updateSettings);

// Failed payments routes
router.get('/failed', requireAnyPermission(PERMISSIONS.VIEW_FAILED_PAYMENTS), getFailedPaymentsList);

// Retry routes
router.post('/retry/:paymentId', requireAnyPermission(PERMISSIONS.RETRY_PAYMENTS), retrySinglePayment);
router.post('/retry-multiple', requireAnyPermission(PERMISSIONS.RETRY_PAYMENTS), retryMultiplePayments);
router.post('/retry-all', requireAnyPermission(PERMISSIONS.RETRY_PAYMENTS), retryAllPayments);

// Retry history
router.get('/history/:paymentId', requireAnyPermission(PERMISSIONS.VIEW_FAILED_PAYMENTS), getRetryHistory);

export default router;
