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
import { authenticateAdmin, authenticateCustomer, requireAnyPermission } from '../middleware/auth';
import { contractUpload } from '../config/upload';
import {
  CONTRACT_ACCESS_PERMISSIONS,
  CONTRACT_APPROVAL_ACCESS_PERMISSIONS,
  PERMISSIONS,
} from '../constants/permissions';

const router = Router();

// Agent portal routes (must be before /:id routes)
router.get('/agent/mine', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_OWN_CONTRACTS), getAgentContracts);
router.patch('/agent/mine/:id/revision-edit', authenticateAdmin, requireAnyPermission(PERMISSIONS.CREATE_CONTRACT, PERMISSIONS.VIEW_OWN_CONTRACTS), editRevisionRequestedContract);
router.post('/agent/mine/:id/resubmit', authenticateAdmin, requireAnyPermission(PERMISSIONS.CREATE_CONTRACT, PERMISSIONS.VIEW_OWN_CONTRACTS), resubmitAgentContract);
router.get('/agent/mine/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_OWN_CONTRACTS), getAgentContractById);

// Contract approval routes (must be before /:id routes)
router.get('/approvals', authenticateAdmin, requireAnyPermission(...CONTRACT_APPROVAL_ACCESS_PERMISSIONS), getPendingApprovals);
router.get('/approvals/count', authenticateAdmin, requireAnyPermission(...CONTRACT_APPROVAL_ACCESS_PERMISSIONS), getPendingApprovalsCount);
router.get('/:id/approval-history', authenticateAdmin, requireAnyPermission(...CONTRACT_APPROVAL_ACCESS_PERMISSIONS, PERMISSIONS.VIEW_CONTRACTS), getContractApprovalHistory);
router.post('/:id/assign-approver', authenticateAdmin, requireAnyPermission(...CONTRACT_APPROVAL_ACCESS_PERMISSIONS), assignContractApprover);
router.post('/:id/approve', authenticateAdmin, requireAnyPermission(PERMISSIONS.APPROVE_CONTRACT), approveContract);
router.post('/:id/request-revision', authenticateAdmin, requireAnyPermission(PERMISSIONS.APPROVE_CONTRACT), requestContractRevision);
router.post('/:id/reject', authenticateAdmin, requireAnyPermission(PERMISSIONS.APPROVE_CONTRACT), requestContractRevision);
router.patch('/:id/pending-edit', authenticateAdmin, requireAnyPermission(PERMISSIONS.APPROVE_CONTRACT), editPendingContract);

// Admin routes
router.post('/preflight', authenticateAdmin, requireAnyPermission(PERMISSIONS.CREATE_CONTRACT), createContractPreflight);
router.post('/', authenticateAdmin, requireAnyPermission(PERMISSIONS.CREATE_CONTRACT), contractUpload, createContract);
router.get('/', authenticateAdmin, requireAnyPermission(...CONTRACT_ACCESS_PERMISSIONS), getAllContracts);
router.get('/installments/pending', authenticateAdmin, requireAnyPermission(...CONTRACT_ACCESS_PERMISSIONS), getAllPendingInstallments);
router.get('/admin/:id', authenticateAdmin, requireAnyPermission(...CONTRACT_ACCESS_PERMISSIONS), getContractById);
router.put('/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CONTRACT), updateContract);
router.post('/:id/amend', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CONTRACT), amendContract);
router.post('/update-overdue', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CONTRACT), updateOverdueInstallments);
router.post('/:id/reschedule', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CONTRACT), rescheduleInstallments);
router.put('/:contractId/installments/:installmentId', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CONTRACT), editInstallment);
router.post('/:contractId/installments/:installmentId/pay', authenticateAdmin, requireAnyPermission(PERMISSIONS.RECORD_PAYMENT), payInstallment);
router.post('/:id/cancel', authenticateAdmin, requireAnyPermission(PERMISSIONS.CANCEL_CONTRACT), cancelContract);
router.post('/:id/transfer-ownership', authenticateAdmin, requireAnyPermission(PERMISSIONS.UPDATE_CONTRACT), transferOwnership);
router.delete('/:id', authenticateAdmin, requireAnyPermission(PERMISSIONS.DELETE_CONTRACT), deleteContract);
router.get('/:contractId/statement', authenticateAdmin, requireAnyPermission(...CONTRACT_ACCESS_PERMISSIONS), downloadContractStatement);

// Customer routes
router.get('/my-contracts', authenticateCustomer, getCustomerContracts);
router.get('/customer/:id', authenticateCustomer, getContractById);
router.get('/customer/:contractId/statement', authenticateCustomer, downloadContractStatement);

export default router;
