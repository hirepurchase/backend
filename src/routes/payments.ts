import { Router } from 'express';
import {
  initiateCustomerPayment,
  getPaymentStatus,
  handlePaymentWebhook,
  getContractPayments,
  recordManualPayment,
  updateManualPayment,
  deleteManualPayment,
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
  getUssdBalance,
  initiateUssdPayment,
  getUssdPaymentStatus,
  handleUssdSession,
  handleUssdFulfillment,
  reconcileHubtelPayments,
  submitCustomerPaymentOtp,
  cancelCustomerMomoPayment,
  reverseGatewayPayment,
} from '../controllers/paymentController';
import { handlePaystackWebhook } from '../controllers/paymentGatewayController';
import { authenticateAdmin, authenticateCustomer, requireAnyPermission, authenticateAny } from '../middleware/auth';
import {
  CONTRACT_ACCESS_PERMISSIONS,
  PERMISSIONS,
} from '../constants/permissions';

const router = Router();

// Webhook endpoints (no authentication - validated via signature)
router.post('/webhook', handlePaymentWebhook);
router.post('/hubtel/callback', handleHubtelCallback);
router.post('/paystack/webhook', handlePaystackWebhook);
router.post('/hubtel/preapproval/callback', handlePreapprovalCallback);

// Customer payment routes
router.post('/initiate', authenticateCustomer, initiateCustomerPayment);
router.post('/hubtel/initiate', authenticateCustomer, initiateHubtelPayment);
router.post('/hubtel/regular', authenticateAny, initiateHubtelRegularPayment);
router.get('/status/:transactionRef', authenticateCustomer, getPaymentStatus);
router.get('/hubtel/status/:transactionRef', authenticateCustomer, checkHubtelStatus);
// Gateway-neutral names for the same two calls (Hubtel or Paystack, chosen on
// the server), plus the SMS code step Paystack needs for Telecel.
router.post('/momo/initiate', authenticateCustomer, initiateHubtelPayment);
router.get('/momo/status/:transactionRef', authenticateCustomer, checkHubtelStatus);
router.post('/momo/:transactionRef/otp', authenticateCustomer, submitCustomerPaymentOtp);
router.post('/momo/:transactionRef/cancel', authenticateCustomer, cancelCustomerMomoPayment);

// Admin payment routes
router.get('/contract/:contractId', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_PAYMENTS, ...CONTRACT_ACCESS_PERMISSIONS), getContractPayments);
router.post('/manual', authenticateAdmin, requireAnyPermission(PERMISSIONS.RECORD_PAYMENT), recordManualPayment);
router.put('/manual/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.RECORD_PAYMENT), updateManualPayment);
router.delete('/manual/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.RECORD_PAYMENT), deleteManualPayment);
// Super admins only, checked in the controller.
router.post('/:id/reverse', authenticateAdmin, reverseGatewayPayment);
router.get('/admin/status/:transactionRef', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_PAYMENTS), getPaymentStatus);
router.get('/admin/hubtel/status/:transactionRef', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_PAYMENTS), checkHubtelStatus);

// Direct Debit - Preapproval routes (Admin only)
router.post('/hubtel/preapproval/initiate', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_CONTRACTS), initiateDirectDebitPreapproval);
router.post('/hubtel/preapproval/verify-otp', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_CONTRACTS), verifyDirectDebitOTP);
router.get('/hubtel/preapproval/:clientReferenceId', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_CONTRACTS), getPreapprovalStatus);
router.get('/hubtel/preapproval/customer/:customerId', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_CONTRACTS), getCustomerPreapprovals);

// Direct Debit - Payment route (Admin only - for recurring payments)
router.post('/hubtel/direct-debit', authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_CONTRACTS), initiateDirectDebitPayment);

// Reconciliation — check PENDING Hubtel payments against Hubtel's API and fix any that resolved without a callback
router.post('/admin/reconcile', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_PAYMENTS), reconcileHubtelPayments);

// USSD payment routes (no auth - phone number identifies the customer)
router.get('/ussd/balance', getUssdBalance);
router.post('/ussd/initiate', initiateUssdPayment);
router.get('/ussd/status/:transactionRef', getUssdPaymentStatus);

// Hubtel Programmable Services (no auth - called by Hubtel)
router.post('/ussd/session', handleUssdSession);
router.post('/ussd/fulfillment', handleUssdFulfillment);

export default router;
