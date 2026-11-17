import { Router } from 'express';
import { authenticateAdmin } from '../middleware/auth';
import { checkPaymentGateway, getPaymentGatewaySettings, putPaymentGatewaySettings } from '../controllers/paymentGatewayController';
import { getTestCharge, listTestCharges, refundTestCharge, startTestCharge, submitTestOtp } from '../controllers/paystackTestController';

// Which gateway sends prompts for web and app payments. Super admin only,
// checked in the controller.
const router = Router();
router.use(authenticateAdmin);
router.get('/', getPaymentGatewaySettings);
router.put('/', putPaymentGatewaySettings);
router.post('/check', checkPaymentGateway);
// The Paystack test page: a small real charge tied to no contract.
router.get('/test', listTestCharges);
router.post('/test/charge', startTestCharge);
router.get('/test/:reference', getTestCharge);
router.post('/test/:reference/otp', submitTestOtp);
router.post('/test/:reference/refund', refundTestCharge);
export default router;
