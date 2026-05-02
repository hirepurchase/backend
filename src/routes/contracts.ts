import { Router } from 'express';
import {
  createContractPreflight,
  createContract,
  getAllContracts,
  getContractById,
  getCustomerContracts,
  updateOverdueInstallments,
  updateContract,
  amendContract,
  cancelContract,
  transferOwnership,
  deleteContract,
  rescheduleInstallments,
  editInstallment,
  getAllPendingInstallments,
  payInstallment,
} from '../controllers/contractController';
import {
  getAgentContracts,
  getAgentContractById,
  getPendingApprovals,
  getPendingApprovalsCount,
  getContractApprovalHistory,
  assignContractApprover,
  approveContract,
  requestContractRevision,
  resubmitAgentContract,
  editRevisionRequestedContract,
  editPendingContract,
} from '../controllers/contractApprovalController';
import { downloadContractStatement } from '../controllers/statementController';
import { authenticateAdmin, authenticateCustomer, requirePermission } from '../middleware/auth';
import { contractUpload } from '../config/upload';

const router = Router();

// Agent portal routes (must be before /:id routes)
router.get('/agent/mine', authenticateAdmin, requirePermission('VIEW_CONTRACTS'), getAgentContracts);
router.patch('/agent/mine/:id/revision-edit', authenticateAdmin, requirePermission('CREATE_CONTRACT', 'VIEW_CONTRACTS'), editRevisionRequestedContract);
router.post('/agent/mine/:id/resubmit', authenticateAdmin, requirePermission('CREATE_CONTRACT', 'VIEW_CONTRACTS'), resubmitAgentContract);
router.get('/agent/mine/:id', authenticateAdmin, requirePermission('VIEW_CONTRACTS'), getAgentContractById);

// Contract approval routes (must be before /:id routes)
router.get('/approvals', authenticateAdmin, requirePermission('VIEW_CONTRACT_APPROVALS', 'APPROVE_CONTRACT'), getPendingApprovals);
router.get('/approvals/count', authenticateAdmin, requirePermission('VIEW_CONTRACT_APPROVALS', 'APPROVE_CONTRACT'), getPendingApprovalsCount);
router.get('/:id/approval-history', authenticateAdmin, requirePermission('VIEW_CONTRACT_APPROVALS', 'APPROVE_CONTRACT', 'VIEW_CONTRACTS'), getContractApprovalHistory);
router.post('/:id/assign-approver', authenticateAdmin, requirePermission('VIEW_CONTRACT_APPROVALS', 'APPROVE_CONTRACT'), assignContractApprover);
router.post('/:id/approve', authenticateAdmin, requirePermission('APPROVE_CONTRACT'), approveContract);
router.post('/:id/request-revision', authenticateAdmin, requirePermission('APPROVE_CONTRACT'), requestContractRevision);
router.post('/:id/reject', authenticateAdmin, requirePermission('APPROVE_CONTRACT'), requestContractRevision);
router.patch('/:id/pending-edit', authenticateAdmin, requirePermission('APPROVE_CONTRACT'), editPendingContract);

// Admin routes
router.post('/preflight', authenticateAdmin, requirePermission('CREATE_CONTRACT'), createContractPreflight);
router.post('/', authenticateAdmin, requirePermission('CREATE_CONTRACT'), contractUpload, createContract);
router.get('/', authenticateAdmin, getAllContracts);
router.get('/installments/pending', authenticateAdmin, getAllPendingInstallments);
router.get('/admin/:id', authenticateAdmin, getContractById);
router.put('/:id', authenticateAdmin, requirePermission('UPDATE_CONTRACT'), updateContract);
router.post('/:id/amend', authenticateAdmin, requirePermission('UPDATE_CONTRACT'), amendContract);
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
