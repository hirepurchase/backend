import { Router } from 'express';
import {
  createCustomer,
  getAllCustomers,
  getCustomerById,
  getCustomerByMembershipId,
  updateCustomer,
  deleteCustomer,
  updateOwnProfile,
  changeCustomerPassword,
  getOwnProfile,
  getCustomerPayments,
  getCustomerUpcomingInstallments,
  getCustomerStatement,
  resetCustomerAccount,
} from '../controllers/customerController';
import { getCustomerContracts, getContractById } from '../controllers/contractController';
import { downloadContractStatement } from '../controllers/statementController';
import { authenticateAdmin, authenticateCustomer, requireAnyPermission } from '../middleware/auth';
import { customerUpload } from '../config/upload';
import {
  CUSTOMER_ACCESS_PERMISSIONS,
  PERMISSIONS,
} from '../constants/permissions';

const router = Router();

// Customer self-service routes (must come before /:id to avoid conflicts)
router.get('/me', authenticateCustomer, getOwnProfile);
router.put('/me', authenticateCustomer, updateOwnProfile);
router.put('/me/password', authenticateCustomer, changeCustomerPassword);
router.get('/me/contracts', authenticateCustomer, getCustomerContracts);
router.get('/me/contracts/:id', authenticateCustomer, getContractById);
router.get('/me/contracts/:contractId/statement', authenticateCustomer, downloadContractStatement);
router.get('/me/payments', authenticateCustomer, getCustomerPayments);
router.get('/me/installments/upcoming', authenticateCustomer, getCustomerUpcomingInstallments);
router.put('/profile/me', authenticateCustomer, updateOwnProfile);
router.post('/profile/change-password', authenticateCustomer, changeCustomerPassword);

// Admin routes for customer management
router.post('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.CREATE_CUSTOMER), customerUpload, createCustomer);
router.get('/', authenticateAdmin, requireAnyPermission(...CUSTOMER_ACCESS_PERMISSIONS), getAllCustomers);
router.get('/membership/:membershipId', authenticateAdmin, requireAnyPermission(...CUSTOMER_ACCESS_PERMISSIONS), getCustomerByMembershipId);
router.get('/:id/statement', authenticateAdmin, requireAnyPermission(...CUSTOMER_ACCESS_PERMISSIONS), getCustomerStatement);
router.get('/:id', authenticateAdmin, requireAnyPermission(...CUSTOMER_ACCESS_PERMISSIONS), getCustomerById);
router.put('/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CUSTOMER), customerUpload, updateCustomer);
router.delete('/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.DELETE_CUSTOMER), deleteCustomer);
router.post('/:id/reset-account', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CUSTOMER), resetCustomerAccount);

export default router;
