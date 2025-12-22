import { Router } from 'express';
import {
  createContract,
  getAllContracts,
  getContractById,
  getCustomerContracts,
  updateOverdueInstallments,
  cancelContract,
  transferOwnership,
  deleteContract,
  rescheduleInstallments,
  editInstallment,
  getAllPendingInstallments,
  payInstallment,
} from '../controllers/contractController';
import { downloadContractStatement } from '../controllers/statementController';
import { authenticateAdmin, authenticateCustomer, requirePermission } from '../middleware/auth';
import { contractUpload } from '../config/upload';

const router = Router();

// Admin routes
router.post('/', authenticateAdmin, requirePermission('CREATE_CONTRACT'), contractUpload, createContract);
router.get('/', authenticateAdmin, getAllContracts);
router.get('/installments/pending', authenticateAdmin, getAllPendingInstallments);
router.get('/admin/:id', authenticateAdmin, getContractById);
router.post('/update-overdue', authenticateAdmin, updateOverdueInstallments);
router.post('/:id/reschedule', authenticateAdmin, requirePermission('UPDATE_CONTRACT'), rescheduleInstallments);
router.put('/:contractId/installments/:installmentId', authenticateAdmin, requirePermission('UPDATE_CONTRACT'), editInstallment);
router.post('/:contractId/installments/:installmentId/pay', authenticateAdmin, requirePermission('RECORD_PAYMENT'), payInstallment);
router.post('/:id/cancel', authenticateAdmin, requirePermission('CANCEL_CONTRACT'), cancelContract);
router.post('/:id/transfer-ownership', authenticateAdmin, transferOwnership);
router.delete('/:id', authenticateAdmin, requirePermission('CANCEL_CONTRACT'), deleteContract);
router.get('/:contractId/statement', authenticateAdmin, downloadContractStatement);

// Customer routes
router.get('/my-contracts', authenticateCustomer, getCustomerContracts);
router.get('/customer/:id', authenticateCustomer, getContractById);
router.get('/customer/:contractId/statement', authenticateCustomer, downloadContractStatement);

export default router;
