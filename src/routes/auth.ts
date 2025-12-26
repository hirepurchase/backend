import { Router } from 'express';
import {
  adminLogin,
  customerLogin,
  verifyMembershipId,
  activateCustomerAccount,
  getCurrentAdmin,
  getCurrentCustomer,
} from '../controllers/authController';
import { updateOwnProfile, changeCustomerPassword } from '../controllers/customerController';
import { authenticateAdmin, authenticateCustomer } from '../middleware/auth';

const router = Router();

// Admin authentication
router.post('/admin/login', adminLogin);
router.get('/admin/me', authenticateAdmin, getCurrentAdmin);

// Customer authentication
router.post('/customer/login', customerLogin);
router.post('/customer/verify-membership', verifyMembershipId);
router.post('/customer/activate', activateCustomerAccount);
router.get('/customer/me', authenticateCustomer, getCurrentCustomer);
router.put('/customer/me', authenticateCustomer, updateOwnProfile);
router.put('/customer/me/password', authenticateCustomer, changeCustomerPassword);

export default router;
