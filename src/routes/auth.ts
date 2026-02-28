import { Router } from 'express';
import {
  adminLogin,
  customerLogin,
  requestCustomerPasswordReset,
  resetCustomerPasswordWithOtp,
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
router.post('/customer/password-reset/request', requestCustomerPasswordReset);
router.post('/customer/password-reset/reset', resetCustomerPasswordWithOtp);
router.get('/customer/me', authenticateCustomer, getCurrentCustomer);
router.put('/customer/me', authenticateCustomer, updateOwnProfile);
router.put('/customer/me/password', authenticateCustomer, changeCustomerPassword);

export default router;
