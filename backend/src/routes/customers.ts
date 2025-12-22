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
} from '../controllers/customerController';
import { getCustomerContracts, getContractById } from '../controllers/contractController';
import { downloadContractStatement } from '../controllers/statementController';
import { authenticateAdmin, authenticateCustomer, requirePermission } from '../middleware/auth';
import { customerUpload } from '../config/upload';

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
router.post('/', authenticateAdmin, requirePermission('CREATE_CUSTOMER'), customerUpload, createCustomer);
router.get('/', authenticateAdmin, getAllCustomers);
router.get('/membership/:membershipId', authenticateAdmin, getCustomerByMembershipId);
router.get('/:id/statement', authenticateAdmin, requirePermission('VIEW_CUSTOMERS'), getCustomerStatement);
router.get('/:id', authenticateAdmin, getCustomerById);
router.put('/:id', authenticateAdmin, requirePermission('UPDATE_CUSTOMER'), customerUpload, updateCustomer);
router.delete('/:id', authenticateAdmin, requirePermission('CREATE_CUSTOMER'), deleteCustomer);

export default router;
