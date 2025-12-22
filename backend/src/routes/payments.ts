import { Router } from 'express';
import {
  initiateCustomerPayment,
  getPaymentStatus,
  handlePaymentWebhook,
  getContractPayments,
  recordManualPayment,
  initiateHubtelPayment,
  checkHubtelStatus,
  handleHubtelCallback,
  initiateDirectDebitPreapproval,
  verifyDirectDebitOTP,
  getPreapprovalStatus,
  getCustomerPreapprovals,
  handlePreapprovalCallback,
  initiateHubtelRegularPayment,
  initiateDirectDebitPayment,
} from '../controllers/paymentController';
import { authenticateAdmin, authenticateCustomer, requirePermission, authenticateAny } from '../middleware/auth';

const router = Router();

// Webhook endpoints (no authentication - validated via signature)
router.post('/webhook', handlePaymentWebhook);
router.post('/hubtel/callback', handleHubtelCallback);
router.post('/hubtel/preapproval/callback', handlePreapprovalCallback);

// Customer payment routes
router.post('/initiate', authenticateCustomer, initiateCustomerPayment);
router.post('/hubtel/initiate', authenticateCustomer, initiateHubtelPayment);
router.post('/hubtel/regular', authenticateAny, initiateHubtelRegularPayment);
router.get('/status/:transactionRef', authenticateCustomer, getPaymentStatus);
router.get('/hubtel/status/:transactionRef', authenticateCustomer, checkHubtelStatus);

// Admin payment routes
router.get('/contract/:contractId', authenticateAdmin, getContractPayments);
router.post('/manual', authenticateAdmin, requirePermission('RECORD_PAYMENT'), recordManualPayment);
router.get('/admin/status/:transactionRef', authenticateAdmin, getPaymentStatus);
router.get('/admin/hubtel/status/:transactionRef', authenticateAdmin, checkHubtelStatus);

// Direct Debit - Preapproval routes (Admin only)
router.post('/hubtel/preapproval/initiate', authenticateAdmin, requirePermission('MANAGE_CONTRACTS'), initiateDirectDebitPreapproval);
router.post('/hubtel/preapproval/verify-otp', authenticateAdmin, requirePermission('MANAGE_CONTRACTS'), verifyDirectDebitOTP);
router.get('/hubtel/preapproval/:clientReferenceId', authenticateAdmin, getPreapprovalStatus);
router.get('/hubtel/preapproval/customer/:customerId', authenticateAdmin, getCustomerPreapprovals);

// Direct Debit - Payment route (Admin only - for recurring payments)
router.post('/hubtel/direct-debit', authenticateAdmin, requirePermission('MANAGE_CONTRACTS'), initiateDirectDebitPayment);

export default router;
