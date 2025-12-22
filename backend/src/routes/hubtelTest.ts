import { Router } from 'express';
import {
  getTestCustomers,
  getTestContracts,
  testReceiveMoney,
  testInitiatePreapproval,
  testVerifyPreapprovalOTP,
  testCheckPreapprovalStatus,
  testCancelPreapproval,
  testReactivatePreapproval,
  testDirectDebitCharge,
  testCheckPaymentStatus,
  getTestPreapprovals,
  getTestPayments,
} from '../controllers/hubtelTestController';
import { authenticateAdmin } from '../middleware/auth';

const router = Router();

// All test routes require admin authentication
router.use(authenticateAdmin);

// Get test data
router.get('/customers', getTestCustomers);
router.get('/contracts', getTestContracts);
router.get('/preapprovals', getTestPreapprovals);
router.get('/payments', getTestPayments);

// Test endpoints
router.post('/receive-money', testReceiveMoney);
router.post('/preapproval/initiate', testInitiatePreapproval);
router.post('/preapproval/verify-otp', testVerifyPreapprovalOTP);
router.get('/preapproval/:clientReferenceId', testCheckPreapprovalStatus);
router.post('/preapproval/cancel', testCancelPreapproval);
router.post('/preapproval/reactivate', testReactivatePreapproval);
router.post('/direct-debit/charge', testDirectDebitCharge);
router.get('/payment/:transactionRef', testCheckPaymentStatus);

export default router;
