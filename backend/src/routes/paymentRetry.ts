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
import { authenticateAdmin, requirePermission } from '../middleware/auth';

const router = express.Router();

// All routes require admin authentication
router.use(authenticateAdmin);

// Retry settings routes
router.get('/settings', requirePermission('MANAGE_HUBTEL_PAYMENTS'), getSettings);
router.put('/settings', requirePermission('MANAGE_HUBTEL_PAYMENTS'), updateSettings);

// Failed payments routes
router.get('/failed', requirePermission('VIEW_FAILED_PAYMENTS'), getFailedPaymentsList);

// Retry routes
router.post('/retry/:paymentId', requirePermission('RETRY_PAYMENTS'), retrySinglePayment);
router.post('/retry-multiple', requirePermission('RETRY_PAYMENTS'), retryMultiplePayments);
router.post('/retry-all', requirePermission('RETRY_PAYMENTS'), retryAllPayments);

// Retry history
router.get('/history/:paymentId', requirePermission('VIEW_FAILED_PAYMENTS'), getRetryHistory);

export default router;
