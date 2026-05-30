import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { sendContractConfirmation, sendContractSubmittedForApprovalNotification } from '../services/notificationService';
import { unenrollManagedDeviceForContract, safelyEvaluateManagedDeviceForContract } from '../services/deviceControlPolicyService';
import { evaluateContractSubmissionGuardrails } from '../services/contractReviewService';
import { AuthenticatedRequest, AdminUserPayload, PaymentFrequency } from '../types';
import bcrypt from 'bcryptjs';
import {
  generateContractNumber,
  calculateInstallmentSchedule,
  calculateEndDate,
  getNextDueDate,
  isOverdue,
  calculatePenalty,
  sanitizePhoneNumber,
} from '../utils/helpers';
import { uploadToSupabase, deleteFromSupabase } from '../services/storageService';
import { hasAnyPermission, hasPermission, PERMISSIONS } from '../constants/permissions';

function canViewAnyContract(adminUser: AdminUserPayload | undefined, contractCreatedById: string | null | undefined): boolean {
  const permissions = adminUser?.permissions ?? [];

  if (hasPermission(permissions, PERMISSIONS.VIEW_CONTRACTS)) {
    return true;
  }

  return hasPermission(permissions, PERMISSIONS.VIEW_OWN_CONTRACTS) && contractCreatedById === adminUser?.id;
}

export async function createContractPreflight(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      customerId,
      inventoryItemId,
      totalPrice,
      depositAmount,
      totalInstallments,
      startDate,
      paymentMethod,
      mobileMoneyNumber,
    } = req.body;

    if (!customerId || !inventoryItemId || totalPrice === undefined || depositAmount === undefined) {
      res.status(400).json({ error: 'customerId, inventoryItemId, totalPrice, and depositAmount are required' });
      return;
    }

    const assessment = await evaluateContractSubmissionGuardrails({
      customerId: String(customerId),
      inventoryItemId: String(inventoryItemId),
      totalPrice: Number(totalPrice),
      depositAmount: Number(depositAmount),
      totalInstallments: totalInstallments !== undefined ? Number(totalInstallments) : undefined,
      startDate: startDate ? new Date(startDate) : undefined,
      paymentMethod: paymentMethod ? String(paymentMethod) : null,
      mobileMoneyNumber: mobileMoneyNumber ? String(mobileMoneyNumber) : null,
    });

    res.json(assessment);
  } catch (error: any) {
    console.error('createContractPreflight error:', error);
    const detail = error?.message || String(error);
    res.status(500).json({ error: 'Failed to evaluate contract guardrails', detail });
  }
}

// Create hire purchase contract (Admin only)
export async function createContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      customerId,
      inventoryItemId,
      totalPrice,
      depositAmount,
      paymentFrequency,
      totalInstallments,
      gracePeriodDays = 0,
      penaltyPercentage = 0,
      startDate,
      paymentMethod,
      mobileMoneyNetwork,
      mobileMoneyNumber,
      lockStatus,
      registeredUnder,
    } = req.body;

    // Validate required fields
    if (!customerId || !inventoryItemId || !totalPrice || depositAmount === undefined || !paymentFrequency || !totalInstallments) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    // Validate payment method if provided
    if (paymentMethod) {
      const validPaymentMethods = ['HUBTEL_REGULAR', 'HUBTEL_DIRECT_DEBIT', 'MANUAL', 'CASH'];
      if (!validPaymentMethods.includes(paymentMethod)) {
        res.status(400).json({ error: 'Invalid payment method' });
        return;
      }

      // If Hubtel payment method, require network and phone number
      if ((paymentMethod === 'HUBTEL_REGULAR' || paymentMethod === 'HUBTEL_DIRECT_DEBIT') && (!mobileMoneyNetwork || !mobileMoneyNumber)) {
        res.status(400).json({ error: 'Mobile money network and phone number are required for Hubtel payment methods' });
        return;
      }

      // Validate network
      if (mobileMoneyNetwork) {
        const validNetworks = ['MTN', 'VODAFONE', 'TELECEL', 'AIRTELTIGO'];
        if (!validNetworks.includes(mobileMoneyNetwork.toUpperCase())) {
          res.status(400).json({ error: 'Invalid mobile money network' });
          return;
        }

        // AirtelTigo not supported for direct debit
        if (paymentMethod === 'HUBTEL_DIRECT_DEBIT' && mobileMoneyNetwork.toUpperCase() === 'AIRTELTIGO') {
          res.status(400).json({ error: 'AirtelTigo does not support Direct Debit' });
          return;
        }
      }
    }

    // Validate payment frequency
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(paymentFrequency)) {
      res.status(400).json({ error: 'Invalid payment frequency' });
      return;
    }

    // Validate customer exists
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      res.status(400).json({ error: 'Customer not found' });
      return;
    }
    if (!customer.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    // Validate inventory item is available
    const inventoryItem = await prisma.inventoryItem.findUnique({
      where: { id: inventoryItemId },
      include: { product: true },
    });

    if (!inventoryItem) {
      res.status(400).json({ error: 'Inventory item not found' });
      return;
    }

    if (inventoryItem.status !== 'AVAILABLE') {
      res.status(400).json({ error: 'Inventory item is not available' });
      return;
    }

    const guardrails = await evaluateContractSubmissionGuardrails({
      customerId,
      inventoryItemId,
      totalPrice: Number(totalPrice),
      depositAmount: Number(depositAmount),
      totalInstallments: Number(totalInstallments),
      startDate: startDate ? new Date(startDate) : undefined,
      paymentMethod: paymentMethod || null,
      mobileMoneyNumber: mobileMoneyNumber || null,
    });

    if (guardrails.blockers.length > 0) {
      res.status(400).json({
        error: 'Contract submission is blocked until the highlighted issues are resolved.',
        guardrails,
      });
      return;
    }

    // Calculate finance amount and installment amount
    const financeAmount = Number(totalPrice) - Number(depositAmount);
    const installmentAmount = Math.ceil((financeAmount / totalInstallments) * 100) / 100;

    // Generate contract number
    let contractNumber = generateContractNumber();
    let exists = await prisma.hirePurchaseContract.findUnique({ where: { contractNumber } });
    while (exists) {
      contractNumber = generateContractNumber();
      exists = await prisma.hirePurchaseContract.findUnique({ where: { contractNumber } });
    }

    const contractStartDate = startDate ? new Date(startDate) : new Date();
    const contractEndDate = calculateEndDate(
      contractStartDate,
      paymentFrequency as PaymentFrequency,
      totalInstallments
    );

    // Calculate installment schedule
    const installmentSchedule = calculateInstallmentSchedule(
      financeAmount,
      paymentFrequency as PaymentFrequency,
      totalInstallments,
      contractStartDate
    );

    // Handle signature upload
    let signatureUrl: string | null = null;
    if (req.file) {
      // Upload to Supabase Storage
      const uploadResult = await uploadToSupabase(
        req.file.buffer,
        'signatures',
        req.file.originalname
      );

      if (uploadResult.success && uploadResult.publicUrl) {
        signatureUrl = uploadResult.publicUrl;
      } else {
        console.error('Signature upload failed:', uploadResult.error);
        res.status(500).json({ error: 'Failed to upload signature' });
        return;
      }
    }

    const normalizedPhone = sanitizePhoneNumber(customer.phone);
    const shouldSetPassword = !customer.password;
    const hashedPhonePassword = shouldSetPassword ? await bcrypt.hash(normalizedPhone, 12) : null;

    // Agents create contracts that require approval before going ACTIVE
    const creatorRole = (req.user as any)?.role as string;
    const requiresApproval = creatorRole === 'AGENT';
    const initialStatus = requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE';

    // Create contract and update inventory in a transaction
    const contract = await prisma.$transaction(async (tx) => {
      // Create the contract
      const newContract = await tx.hirePurchaseContract.create({
        data: {
          contractNumber,
          customerId_uuid: customer.id_uuid,
          totalPrice: Number(totalPrice),
          depositAmount: Number(depositAmount),
          financeAmount,
          installmentAmount,
          paymentFrequency,
          totalInstallments: Number(totalInstallments),
          gracePeriodDays: Number(gracePeriodDays),
          penaltyPercentage: Number(penaltyPercentage),
          startDate: contractStartDate,
          endDate: contractEndDate,
          outstandingBalance: financeAmount,
          totalPaid: Number(depositAmount),
          signatureUrl,
          paymentMethod: paymentMethod || null,
          mobileMoneyNetwork: mobileMoneyNetwork ? mobileMoneyNetwork.toUpperCase() : null,
          mobileMoneyNumber: mobileMoneyNumber || null,
          createdById: req.user!.id,
          status: initialStatus,
        },
      });

      // Create installment schedule
      await tx.installmentSchedule.createMany({
        data: installmentSchedule.map(schedule => ({
          contractId: newContract.id,
          installmentNo: schedule.installmentNo,
          dueDate: schedule.dueDate,
          amount: schedule.amount,
        })),
      });

      // Agents reserve the inventory; it becomes SOLD only after approval
      await tx.inventoryItem.update({
        where: { id: inventoryItemId },
        data: {
          status: requiresApproval ? 'RESERVED' : 'SOLD',
          contractId: newContract.id,
          lockStatus: lockStatus || undefined,
          registeredUnder: registeredUnder || undefined,
        },
      });

      // Activate customer account on first contract creation
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          isActivated: true,
          activatedAt: customer.activatedAt || new Date(),
          ...(shouldSetPassword ? { password: hashedPhonePassword } : {}),
          phone: normalizedPhone,
        },
      });

      return newContract;
    });

    // Fetch complete contract with relations
    const completeContract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contract.id },
      include: {
        customer: {
          select: {
            id: true,
            membershipId: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
          },
        },
        inventoryItem: {
          include: {
            product: true,
          },
        },
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CREATE_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: contract.id,
      newValues: {
        contractNumber,
        customerId,
        totalPrice,
        depositAmount,
        financeAmount,
        paymentFrequency,
        totalInstallments,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    if (requiresApproval) {
      await createAuditLog({
        userId: req.user!.id,
        action: 'SUBMIT_CONTRACT_FOR_APPROVAL',
        entity: 'HirePurchaseContract',
        entityId: contract.id,
        oldValues: { status: 'DRAFT' },
        newValues: {
          status: 'PENDING_APPROVAL',
          priority: guardrails.priority,
          riskFlags: guardrails.riskFlags,
        },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });
    }

    // Send notifications (non-blocking)
    if (completeContract && requiresApproval) {
      sendContractSubmittedForApprovalNotification({
        recipient: {
          firstName: completeContract.createdBy.firstName,
          lastName: completeContract.createdBy.lastName,
          email: completeContract.createdBy.email,
          phone: completeContract.createdBy.phone,
        },
        contractNumber: completeContract.contractNumber,
        customerName: `${completeContract.customer.firstName} ${completeContract.customer.lastName}`,
        priority: guardrails.priority,
      }).catch((error) => {
        console.error('Failed to send contract submission notification:', error);
      });
    } else if (completeContract) {
      sendContractConfirmation({
        customerFirstName: completeContract.customer.firstName,
        customerLastName: completeContract.customer.lastName,
        customerEmail: completeContract.customer.email || undefined,
        customerPhone: completeContract.customer.phone,
        contractNumber: completeContract.contractNumber,
        contractId: completeContract.id,
        productName: completeContract.inventoryItem?.product?.name || 'Product',
        totalPrice: completeContract.totalPrice,
        depositAmount: completeContract.depositAmount,
        installmentAmount: completeContract.installmentAmount,
        totalInstallments: completeContract.totalInstallments,
        paymentFrequency: completeContract.paymentFrequency,
        startDate: completeContract.startDate,
        endDate: completeContract.endDate,
      }).catch(error => {
        console.error('Failed to send contract confirmation:', error);
      });
    }

    res.status(201).json({
      ...completeContract,
      guardrails: requiresApproval ? guardrails : undefined,
    });
  } catch (error: any) {
    console.error('Create contract error:', error);
    const detail = error?.message || String(error);
    res.status(500).json({ error: 'Failed to create contract', detail });
  }
}

// Get all contracts (Admin)
export async function getAllContracts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      customerId,
      search,
      includeDeviceControl,
    } = req.query;

    const adminUser = req.user as AdminUserPayload;
    const permissions = adminUser?.permissions ?? [];
    const hasViewAll = hasPermission(permissions, PERMISSIONS.VIEW_CONTRACTS);
    const hasViewOwn = hasPermission(permissions, PERMISSIONS.VIEW_OWN_CONTRACTS);
    const canViewDeviceControl = hasAnyPermission(permissions, [
      PERMISSIONS.VIEW_DEVICE_CONTROL,
      PERMISSIONS.MANAGE_DEVICE_CONTROL,
    ]);
    const shouldIncludeDeviceControl =
      String(includeDeviceControl).toLowerCase() === 'true' && canViewDeviceControl;

    // Agents with VIEW_OWN_CONTRACTS but not VIEW_CONTRACTS see only their own
    const where: Record<string, unknown> = {};
    if (!hasViewAll && hasViewOwn) {
      where.createdById = adminUser.id;
    }

    if (status) where.status = status;
    if (customerId) {
      const filterCustomer = await prisma.customer.findUnique({
        where: { id: customerId as string },
        select: { id_uuid: true },
      });
      if (filterCustomer) where.customerId_uuid = filterCustomer.id_uuid;
    }

    if (search) {
      where.OR = [
        { contractNumber: { contains: search as string, mode: 'insensitive' } },
        { customer: { membershipId: { contains: search as string, mode: 'insensitive' } } },
        { customer: { firstName: { contains: search as string, mode: 'insensitive' } } },
        { customer: { lastName: { contains: search as string, mode: 'insensitive' } } },
        { inventoryItem: { serialNumber: { contains: search as string, mode: 'insensitive' } } },
      ];
    }

    const contractInclude: any = {
      customer: {
        select: {
          id: true,
          id_uuid: true,
          membershipId: true,
          firstName: true,
          lastName: true,
          phone: true,
          photoUrl: true,
        },
      },
      inventoryItem: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
      createdBy: {
        select: { id: true, firstName: true, lastName: true, role: { select: { name: true } } },
      },
      _count: {
        select: {
          payments: true,
          installments: true,
        },
      },
    };

    if (shouldIncludeDeviceControl) {
      contractInclude.managedDevice = {
        select: {
          id: true,
          approveId: true,
          deviceUid: true,
          deviceUidType: true,
          enrollmentStatus: true,
          desiredState: true,
          actualState: true,
          isActive: true,
          lastError: true,
          lastEvaluatedAt: true,
          lastLockedAt: true,
          lastUnlockedAt: true,
          lastSyncedAt: true,
        },
      };
    }

    const [contracts, total] = await Promise.all([
      prisma.hirePurchaseContract.findMany({
        where,
        include: contractInclude,
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.hirePurchaseContract.count({ where }),
    ]);

    res.json({
      contracts,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (error: any) {
    console.error('Get contracts error:', error);
    const detail = error?.message || String(error);
    res.status(500).json({ error: 'Failed to fetch contracts', detail });
  }
}

// Get contract by ID
export async function getContractById(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        customer: true,
        inventoryItem: {
          include: {
            product: {
              include: { category: true },
            },
          },
        },
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
        },
        penalties: {
          orderBy: { createdAt: 'desc' },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        hubtelPreapproval: true,
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (req.userType === 'admin') {
      const adminUser = req.user as AdminUserPayload;
      if (!canViewAnyContract(adminUser, contract.createdById)) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }
    }

    // Check ownership for customers
    if (req.userType === 'customer' && contract.customerId_uuid !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    res.json(contract);
  } catch (error) {
    console.error('Get contract error:', error);
    res.status(500).json({ error: 'Failed to fetch contract' });
  }
}

// Get customer's contracts
export async function getCustomerContracts(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = req.user!.id;
    const customer = await prisma.customer.findFirst({
      where: { id_uuid: customerId },
      select: { id: true },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    const contracts = await prisma.hirePurchaseContract.findMany({
      where: { customerId_uuid: customerId },
      include: {
        inventoryItem: {
          include: {
            product: true,
          },
        },
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
        _count: {
          select: { payments: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate next payment for each contract
    const contractsWithNextPayment = contracts.map(contract => {
      const nextInstallment = contract.installments.find(
        i => i.status === 'PENDING' || i.status === 'PARTIAL' || i.status === 'OVERDUE'
      );

      return {
        ...contract,
        nextPayment: nextInstallment ? {
          installmentNo: nextInstallment.installmentNo,
          dueDate: nextInstallment.dueDate,
          amount: nextInstallment.amount - nextInstallment.paidAmount,
          isOverdue: isOverdue(nextInstallment.dueDate, contract.gracePeriodDays),
        } : null,
      };
    });

    res.json({ contracts: contractsWithNextPayment });
  } catch (error) {
    console.error('Get customer contracts error:', error);
    res.status(500).json({ error: 'Failed to fetch contracts' });
  }
}

// Update overdue installments (should be run as a scheduled job)
export async function updateOverdueInstallments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const activeContracts = await prisma.hirePurchaseContract.findMany({
      where: { status: 'ACTIVE' },
      include: {
        installments: {
          where: {
            status: { in: ['PENDING', 'PARTIAL'] },
          },
        },
      },
    });

    let updatedCount = 0;
    let penaltiesApplied = 0;

    for (const contract of activeContracts) {
      for (const installment of contract.installments) {
        if (isOverdue(installment.dueDate, contract.gracePeriodDays) && installment.status !== 'OVERDUE') {
          await prisma.installmentSchedule.update({
            where: { id: installment.id },
            data: { status: 'OVERDUE' },
          });
          updatedCount++;

          // Apply penalty if configured
          if (contract.penaltyPercentage > 0) {
            const remainingAmount = installment.amount - installment.paidAmount;
            const penaltyAmount = calculatePenalty(remainingAmount, contract.penaltyPercentage);
            const penaltyReason = `Late payment penalty for installment #${installment.installmentNo}`;

            const existingPenalty = await prisma.penalty.findFirst({
              where: {
                contractId: contract.id,
                isPaid: false,
                reason: penaltyReason,
              },
            });

            if (existingPenalty) {
              continue;
            }

            await prisma.penalty.create({
              data: {
                contractId: contract.id,
                amount: penaltyAmount,
                reason: penaltyReason,
              },
            });

            // Update contract outstanding balance
            await prisma.hirePurchaseContract.update({
              where: { id: contract.id },
              data: {
                outstandingBalance: {
                  increment: penaltyAmount,
                },
              },
            });

            penaltiesApplied++;
          }
        }
      }
    }

    res.json({
      message: 'Overdue check completed',
      updatedInstallments: updatedCount,
      penaltiesApplied,
    });
  } catch (error) {
    console.error('Update overdue installments error:', error);
    res.status(500).json({ error: 'Failed to update overdue installments' });
  }
}

// Update contract (Admin only)
export async function updateContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { gracePeriodDays, penaltyPercentage, paymentMethod, mobileMoneyNetwork, mobileMoneyNumber } = req.body;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        customer: true,
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    // Prepare update data
    const updateData: any = {};

    if (gracePeriodDays !== undefined) {
      updateData.gracePeriodDays = Number(gracePeriodDays);
    }

    if (penaltyPercentage !== undefined) {
      updateData.penaltyPercentage = Number(penaltyPercentage);
    }

    // Track if switching to Direct Debit
    let switchingToDirectDebit = false;
    let preapprovalDetails: null | Record<string, unknown> = null;

    if (paymentMethod !== undefined) {
      // Handle "NO_PREFERENCE" as null
      if (paymentMethod === 'NO_PREFERENCE') {
        updateData.paymentMethod = null;
        updateData.mobileMoneyNetwork = null;
        updateData.mobileMoneyNumber = null;
      } else {
        updateData.paymentMethod = paymentMethod;

        // If switching to Hubtel, require network and number
        if (paymentMethod === 'HUBTEL_MOMO' || paymentMethod === 'HUBTEL_DIRECT_DEBIT') {
          if (!mobileMoneyNetwork || !mobileMoneyNumber) {
            res.status(400).json({
              error: 'Mobile money network and number are required for Hubtel payment method'
            });
            return;
          }
          updateData.mobileMoneyNetwork = mobileMoneyNetwork.toUpperCase();
          updateData.mobileMoneyNumber = mobileMoneyNumber;

          // Check if switching to Direct Debit
          if (paymentMethod === 'HUBTEL_DIRECT_DEBIT' && contract.paymentMethod !== 'HUBTEL_DIRECT_DEBIT') {
            switchingToDirectDebit = true;

            // Validate network supports Direct Debit
            const validDirectDebitNetworks = ['MTN', 'VODAFONE', 'TELECEL'];
            if (!validDirectDebitNetworks.includes(mobileMoneyNetwork.toUpperCase())) {
              res.status(400).json({
                error: 'Direct Debit only supports MTN, VODAFONE, and TELECEL networks'
              });
              return;
            }

            // Check if customer already has an approved preapproval for this network
            const { formatPhoneForHubtel, initiatePreapproval } = require('../services/hubtelService');
            const formattedPhone = formatPhoneForHubtel(mobileMoneyNumber);

            const existingPreapproval = await prisma.hubtelPreapproval.findFirst({
              where: {
                customerId_uuid: contract.customerId_uuid,
                customerMsisdn: formattedPhone,
                status: 'APPROVED',
              },
            });

            if (existingPreapproval) {
              // Link the existing preapproval to the contract
              updateData.hubtelPreapprovalId = existingPreapproval.id;
              preapprovalDetails = {
                status: 'ALREADY_APPROVED',
                preapprovalId: existingPreapproval.id,
                message: 'Contract linked to existing approved preapproval',
              };
            } else {
              // Initiate new preapproval
              try {
                const clientReferenceId = `PREAPPR-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

                const preapprovalResponse = await initiatePreapproval({
                  customerId: contract.customerId_uuid,
                  customerPhone: mobileMoneyNumber,
                  network: mobileMoneyNetwork.toUpperCase(),
                  clientReferenceId,
                });

                preapprovalDetails = {
                  status: 'INITIATED',
                  clientReferenceId: preapprovalResponse.clientReferenceId,
                  hubtelPreapprovalId: preapprovalResponse.hubtelPreapprovalId,
                  verificationType: preapprovalResponse.verificationType,
                  otpPrefix: preapprovalResponse.otpPrefix,
                  message: preapprovalResponse.verificationType === 'USSD'
                    ? 'Customer will receive USSD prompt on their phone'
                    : 'Customer will receive OTP via SMS',
                };

                // Link the newly created preapproval to the contract
                const newPreapproval = await prisma.hubtelPreapproval.findUnique({
                  where: { clientReferenceId: preapprovalResponse.clientReferenceId },
                });
                if (newPreapproval) {
                  updateData.hubtelPreapprovalId = newPreapproval.id;
                }

                // Create audit log for preapproval
                await createAuditLog({
                  userId: req.user!.id,
                  action: 'INITIATE_PREAPPROVAL_ON_CONTRACT_AMENDMENT',
                  entity: 'HubtelPreapproval',
                  entityId: clientReferenceId,
                  newValues: {
                    contractId: id,
                    customerId: contract.customerId_uuid,
                    network: mobileMoneyNetwork.toUpperCase(),
                    clientReferenceId,
                    verificationType: preapprovalResponse.verificationType,
                  },
                  ipAddress: req.ip,
                  userAgent: req.headers['user-agent'],
                });
              } catch (preapprovalError: any) {
                console.error('Failed to initiate preapproval:', preapprovalError);
                // Don't fail the contract update, just warn about preapproval failure
                preapprovalDetails = {
                  status: 'FAILED',
                  message: `Contract updated but preapproval failed: ${preapprovalError.message}`,
                  error: preapprovalError.message,
                };
              }
            }
          }
        } else {
          // Clear mobile money details if switching away from Hubtel
          updateData.mobileMoneyNetwork = null;
          updateData.mobileMoneyNumber = null;
        }
      }
    } else if (mobileMoneyNetwork !== undefined || mobileMoneyNumber !== undefined) {
      // Allow updating mobile money details independently
      if (mobileMoneyNetwork) updateData.mobileMoneyNetwork = mobileMoneyNetwork.toUpperCase();
      if (mobileMoneyNumber) updateData.mobileMoneyNumber = mobileMoneyNumber;
    }

    const updatedContract = await prisma.hirePurchaseContract.update({
      where: { id },
      data: updateData,
    });

    // Create audit log
    await createAuditLog({
      userId: req.user!.id,
      action: 'UPDATE_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: {
        gracePeriodDays: contract.gracePeriodDays,
        penaltyPercentage: contract.penaltyPercentage,
        paymentMethod: contract.paymentMethod,
        mobileMoneyNetwork: contract.mobileMoneyNetwork,
        mobileMoneyNumber: contract.mobileMoneyNumber,
      },
      newValues: updateData,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const response: any = {
      message: 'Contract updated successfully',
      contract: updatedContract,
    };

    // Include preapproval details if Direct Debit was initiated
    if (switchingToDirectDebit && preapprovalDetails) {
      response.preapproval = preapprovalDetails;
    }

    res.json(response);
  } catch (error) {
    console.error('Update contract error:', error);
    res.status(500).json({ error: 'Failed to update contract' });
  }
}

// Cancel contract (Admin only)
export async function cancelContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: { inventoryItem: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Only active contracts can be cancelled' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      // Update contract status
      await tx.hirePurchaseContract.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      // Return inventory item to available if it exists
      if (contract.inventoryItem) {
        await tx.inventoryItem.update({
          where: { id: contract.inventoryItem.id },
          data: {
            status: 'AVAILABLE',
            contractId: null,
          },
        });
      }
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'CANCEL_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      newValues: { status: 'CANCELLED', reason },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Contract cancelled successfully' });
  } catch (error) {
    console.error('Cancel contract error:', error);
    res.status(500).json({ error: 'Failed to cancel contract' });
  }
}

// Write off contract — mark unrecoverable debt, release device, preserve payment history
export async function writeOffContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!reason?.trim()) {
      res.status(400).json({ error: 'A write-off reason is required.' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: { inventoryItem: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    const eligibleStatuses = ['ACTIVE', 'DEFAULTED'];
    if (!eligibleStatuses.includes(contract.status)) {
      res.status(400).json({
        error: `Only active or defaulted contracts can be written off. Current status: ${contract.status}`,
      });
      return;
    }

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      // Mark contract as written off
      await tx.hirePurchaseContract.update({
        where: { id },
        data: {
          status: 'WRITTEN_OFF',
          writeOffReason: reason.trim(),
          writtenOffAt: now,
          writtenOffById: req.user!.id,
        },
      });

      // Mark all remaining PENDING/OVERDUE/PARTIAL installments as written off
      await tx.installmentSchedule.updateMany({
        where: {
          contractId: id,
          status: { in: ['PENDING', 'OVERDUE', 'PARTIAL'] },
        },
        data: { status: 'WRITTEN_OFF' },
      });

      // Return inventory item to available so it can be re-used or repossessed
      if (contract.inventoryItem) {
        await tx.inventoryItem.update({
          where: { id: contract.inventoryItem.id },
          data: { status: 'AVAILABLE', contractId: null },
        });
      }
    });

    // Audit log
    await createAuditLog({
      userId: req.user!.id,
      action: 'WRITE_OFF_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: { status: contract.status, outstandingBalance: contract.outstandingBalance },
      newValues: { status: 'WRITTEN_OFF', reason: reason.trim(), writtenOffAt: now },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Release device from Knox Guard — customer no longer has a live contract
    try {
      await unenrollManagedDeviceForContract(id, `Contract written off: ${reason.trim()}`);
    } catch (knoxError) {
      console.error(`Knox Guard unenrollment failed for written-off contract ${id}:`, knoxError);
    }

    res.json({
      message: 'Contract written off successfully.',
      contractId: id,
      writtenOffAt: now,
    });
  } catch (error) {
    console.error('Write-off contract error:', error);
    res.status(500).json({ error: 'Failed to write off contract' });
  }
}

// Transfer ownership (when fully paid)
export async function transferOwnership(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.outstandingBalance > 0) {
      res.status(400).json({ error: 'Cannot transfer ownership until fully paid' });
      return;
    }

    if (contract.ownershipTransferred) {
      res.status(400).json({ error: 'Ownership already transferred' });
      return;
    }

    await prisma.hirePurchaseContract.update({
      where: { id },
      data: {
        ownershipTransferred: true,
        status: 'COMPLETED',
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'TRANSFER_OWNERSHIP',
      entity: 'HirePurchaseContract',
      entityId: id,
      newValues: { ownershipTransferred: true, status: 'COMPLETED' },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Release device from Knox Guard management now that contract is complete
    try {
      await unenrollManagedDeviceForContract(id, 'Contract completed — ownership transferred to customer.');
    } catch (knoxError) {
      console.error(`Knox Guard unenrollment failed for contract ${id}:`, knoxError);
    }

    res.json({ message: 'Ownership transferred successfully' });
  } catch (error) {
    console.error('Transfer ownership error:', error);
    res.status(500).json({ error: 'Failed to transfer ownership' });
  }
}

// Delete contract (Admin only - only if no payments received)
export async function deleteContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        payments: true,
        inventoryItem: true,
        _count: {
          select: { payments: true },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    // Check if contract has received any payments
    if (contract._count.payments > 0) {
      res.status(400).json({
        error: 'Cannot delete contract that has received payments',
        paymentsCount: contract._count.payments,
      });
      return;
    }

    // Delete signature from Supabase if it exists
    if (contract.signatureUrl) {
      await deleteFromSupabase(contract.signatureUrl);
    }

    await prisma.$transaction(async (tx) => {
      // Delete related installment schedules
      await tx.installmentSchedule.deleteMany({
        where: { contractId: id },
      });

      // Delete the contract
      await tx.hirePurchaseContract.delete({
        where: { id },
      });

      // Return inventory item to available if it exists
      if (contract.inventoryItem) {
        await tx.inventoryItem.update({
          where: { id: contract.inventoryItem.id },
          data: {
            status: 'AVAILABLE',
            contractId: null,
          },
        });
      }
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'DELETE_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: {
        contractNumber: contract.contractNumber,
        customerId: contract.customerId_uuid,
        totalPrice: contract.totalPrice,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ message: 'Contract deleted successfully' });
  } catch (error) {
    console.error('Delete contract error:', error);
    res.status(500).json({ error: 'Failed to delete contract' });
  }
}

// Reschedule installments
export async function rescheduleInstallments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { newStartDate } = req.body;

    if (!newStartDate) {
      res.status(400).json({ error: 'New start date is required' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Can only reschedule installments for active contracts' });
      return;
    }

    // Check if any installments have been paid
    const paidInstallments = contract.installments.filter(i => i.status === 'PAID' || i.paidAmount > 0);
    if (paidInstallments.length > 0) {
      res.status(400).json({
        error: 'Cannot reschedule installments when payments have already been made. Only unpaid installments can be rescheduled.'
      });
      return;
    }

    // Calculate new schedule
    const startDate = new Date(newStartDate);
    const newInstallmentSchedule = calculateInstallmentSchedule(
      contract.financeAmount,
      contract.paymentFrequency as PaymentFrequency,
      contract.totalInstallments,
      startDate
    );

    // Update all installments with new dates
    await Promise.all(
      contract.installments.map((installment, index) =>
        prisma.installmentSchedule.update({
          where: { id: installment.id },
          data: {
            dueDate: newInstallmentSchedule[index].dueDate,
          },
        })
      )
    );

    // Update contract dates
    const newEndDate = newInstallmentSchedule[newInstallmentSchedule.length - 1].dueDate;
    await prisma.hirePurchaseContract.update({
      where: { id },
      data: {
        startDate,
        endDate: newEndDate,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'RESCHEDULE_INSTALLMENTS',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues: {
        startDate: contract.startDate,
        endDate: contract.endDate,
      },
      newValues: {
        startDate,
        endDate: newEndDate,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: 'Installments rescheduled successfully',
      startDate,
      endDate: newEndDate,
    });
  } catch (error) {
    console.error('Reschedule installments error:', error);
    res.status(500).json({ error: 'Failed to reschedule installments' });
  }
}

// Edit individual installment
export async function editInstallment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, installmentId } = req.params;
    const { amount, dueDate } = req.body;

    if (!amount && !dueDate) {
      res.status(400).json({ error: 'Amount or due date is required' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        installments: {
          orderBy: { installmentNo: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Can only edit installments for active contracts' });
      return;
    }

    const installment = contract.installments.find(i => i.id === installmentId);
    if (!installment) {
      res.status(404).json({ error: 'Installment not found' });
      return;
    }

    // Check if installment has been paid
    if (installment.status === 'PAID' || installment.paidAmount > 0) {
      res.status(400).json({
        error: 'Cannot edit paid installments'
      });
      return;
    }

    const oldValues = {
      amount: installment.amount,
      dueDate: installment.dueDate,
    };

    // Update the specific installment
    const updatedInstallment = await prisma.installmentSchedule.update({
      where: { id: installmentId },
      data: {
        ...(amount && { amount: Number(amount) }),
        ...(dueDate && { dueDate: new Date(dueDate) }),
      },
    });

    // If amount changed, recalculate remaining installments
    if (amount && Number(amount) !== installment.amount) {
      const unpaidInstallments = contract.installments.filter(
        i => i.id !== installmentId && i.status !== 'PAID' && i.paidAmount === 0 && i.installmentNo > installment.installmentNo
      );

      if (unpaidInstallments.length > 0) {
        // Calculate the difference and distribute it across remaining installments
        const amountDifference = Number(amount) - installment.amount;
        const adjustmentPerInstallment = amountDifference / unpaidInstallments.length;

        // Update remaining installments
        await Promise.all(
          unpaidInstallments.map(i =>
            prisma.installmentSchedule.update({
              where: { id: i.id },
              data: {
                amount: i.amount - adjustmentPerInstallment,
              },
            })
          )
        );
      }
    }

    // Recalculate contract totals
    const allInstallments = await prisma.installmentSchedule.findMany({
      where: { contractId },
    });

    const totalFinanceAmount = allInstallments.reduce((sum, i) => sum + i.amount, 0);
    const totalPrice = totalFinanceAmount + contract.depositAmount;

    await prisma.hirePurchaseContract.update({
      where: { id: contractId },
      data: {
        financeAmount: totalFinanceAmount,
        totalPrice,
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'EDIT_INSTALLMENT',
      entity: 'InstallmentSchedule',
      entityId: installmentId,
      oldValues,
      newValues: {
        amount: updatedInstallment.amount,
        dueDate: updatedInstallment.dueDate,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: 'Installment updated successfully',
      installment: updatedInstallment,
    });
  } catch (error) {
    console.error('Edit installment error:', error);
    res.status(500).json({ error: 'Failed to edit installment' });
  }
}

// Amend contract (Admin only) — corrects mistakes after payments have begun
// Preserves all paid installments, recalculates remaining unpaid ones
export async function amendContract(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const {
      totalPrice,
      depositAmount,
      totalInstallments,
      paymentFrequency,
      penaltyPercentage,
      gracePeriodDays,
      reason,
    } = req.body;

    const hasValue = (value: unknown): boolean => value !== undefined && value !== null;
    const roundMoney = (value: number): number => Math.round(value * 100) / 100;

    if (!reason || !reason.trim()) {
      res.status(400).json({ error: 'A reason is required for contract amendments' });
      return;
    }

    if (hasValue(totalPrice)) {
      const parsedTotalPrice = Number(totalPrice);
      if (!Number.isFinite(parsedTotalPrice) || parsedTotalPrice <= 0) {
        res.status(400).json({ error: 'Total price must be greater than zero' });
        return;
      }
    }

    if (hasValue(depositAmount)) {
      const parsedDepositAmount = Number(depositAmount);
      if (!Number.isFinite(parsedDepositAmount) || parsedDepositAmount < 0) {
        res.status(400).json({ error: 'Deposit amount cannot be negative' });
        return;
      }
    }

    if (hasValue(totalInstallments)) {
      const parsedTotalInstallments = Number(totalInstallments);
      if (!Number.isInteger(parsedTotalInstallments) || parsedTotalInstallments < 1) {
        res.status(400).json({ error: 'Total installments must be a whole number greater than zero' });
        return;
      }
    }

    if (hasValue(paymentFrequency) && !['DAILY', 'WEEKLY', 'MONTHLY'].includes(String(paymentFrequency))) {
      res.status(400).json({ error: 'Invalid payment frequency' });
      return;
    }

    if (hasValue(penaltyPercentage)) {
      const parsedPenaltyPercentage = Number(penaltyPercentage);
      if (!Number.isFinite(parsedPenaltyPercentage) || parsedPenaltyPercentage < 0) {
        res.status(400).json({ error: 'Penalty percentage cannot be negative' });
        return;
      }
    }

    if (hasValue(gracePeriodDays)) {
      const parsedGracePeriodDays = Number(gracePeriodDays);
      if (!Number.isInteger(parsedGracePeriodDays) || parsedGracePeriodDays < 0) {
        res.status(400).json({ error: 'Grace period days must be a whole number that is zero or greater' });
        return;
      }
    }

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        installments: { orderBy: { installmentNo: 'asc' } },
        payments: true,
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Only active contracts can be amended' });
      return;
    }

    // Separate paid vs unpaid installments
    const paidInstallments = contract.installments.filter(
      i => i.status === 'PAID' || i.paidAmount >= i.amount
    );
    const unpaidInstallments = contract.installments.filter(
      i => i.status !== 'PAID' && i.paidAmount < i.amount
    );

    // Snapshot old values for audit
    const oldValues = {
      totalPrice: contract.totalPrice,
      depositAmount: contract.depositAmount,
      financeAmount: contract.financeAmount,
      totalInstallments: contract.totalInstallments,
      installmentAmount: contract.installmentAmount,
      paymentFrequency: contract.paymentFrequency,
      penaltyPercentage: contract.penaltyPercentage,
      gracePeriodDays: contract.gracePeriodDays,
      outstandingBalance: contract.outstandingBalance,
      endDate: contract.endDate,
    };

    // Resolve new values, falling back to existing
    const newTotalPrice = totalPrice !== undefined ? Number(totalPrice) : contract.totalPrice;
    const newDepositAmount = depositAmount !== undefined ? Number(depositAmount) : contract.depositAmount;
    const newPaymentFrequency = (paymentFrequency as PaymentFrequency) || (contract.paymentFrequency as PaymentFrequency);
    const newPenaltyPercentage = penaltyPercentage !== undefined ? Number(penaltyPercentage) : contract.penaltyPercentage;
    const newGracePeriodDays = gracePeriodDays !== undefined ? Number(gracePeriodDays) : contract.gracePeriodDays;

    // How much has actually been paid across all installments (partial credits count)
    const totalPaidOnInstallments = roundMoney(
      contract.installments.reduce((sum, i) => sum + i.paidAmount, 0)
    );

    // The corrected finance amount is everything above the deposit
    const newFinanceAmount = newTotalPrice - newDepositAmount;

    if (newFinanceAmount <= 0) {
      res.status(400).json({ error: 'Total price must be greater than deposit amount' });
      return;
    }

    // Remaining balance = new finance amount minus what has already been paid on installments
    const remainingBalance = Math.max(0, newFinanceAmount - totalPaidOnInstallments);

    const newTotalInstallments = totalInstallments !== undefined ? Number(totalInstallments) : contract.totalInstallments;
    const shouldRebucketPaidHistory =
      totalInstallments !== undefined && newTotalInstallments <= paidInstallments.length;
    const newOutstandingBalance = roundMoney(Math.max(0, newFinanceAmount - totalPaidOnInstallments));
    const totalPaidWithDeposit = roundMoney(totalPaidOnInstallments + newDepositAmount);
    const newContractStatus = newOutstandingBalance <= 0 ? 'COMPLETED' : 'ACTIVE';
    const newInstallmentAmount = Math.ceil((newFinanceAmount / newTotalInstallments) * 100) / 100;

    let summaryPaidInstallments = paidInstallments.length;
    let summaryRemainingInstallments = unpaidInstallments.length;
    let correctedEndDate = contract.endDate;

    if (shouldRebucketPaidHistory) {
      const correctedSchedule = calculateInstallmentSchedule(
        newFinanceAmount,
        newPaymentFrequency,
        newTotalInstallments,
        new Date(contract.startDate)
      );
      const paymentMilestones = contract.payments
        .filter((payment) => payment.status === 'SUCCESS')
        .sort((a, b) => {
          const left = a.paymentDate ?? a.createdAt;
          const right = b.paymentDate ?? b.createdAt;
          return left.getTime() - right.getTime();
        })
        .reduce<Array<{ cumulativePaid: number; paidAt: Date }>>((milestones, payment) => {
          const previousTotal = milestones.length > 0 ? milestones[milestones.length - 1].cumulativePaid : 0;
          milestones.push({
            cumulativePaid: roundMoney(previousTotal + payment.amount),
            paidAt: payment.paymentDate ?? payment.createdAt,
          });
          return milestones;
        }, []);
      const fallbackPaidDates = paidInstallments
        .map((installment) => installment.paidAt)
        .filter((paidAt): paidAt is Date => Boolean(paidAt));

      let cumulativeScheduledAmount = 0;
      let remainingPaidToAllocate = totalPaidOnInstallments;
      let completedInstallmentCount = 0;

      const rebucketedInstallments = correctedSchedule.map((scheduleInstallment) => {
        const paidAmount = roundMoney(Math.min(scheduleInstallment.amount, Math.max(0, remainingPaidToAllocate)));
        remainingPaidToAllocate = roundMoney(Math.max(0, remainingPaidToAllocate - paidAmount));
        cumulativeScheduledAmount = roundMoney(cumulativeScheduledAmount + scheduleInstallment.amount);

        const isFullyPaid = paidAmount >= scheduleInstallment.amount - 0.005;
        const hasPartialPayment = paidAmount > 0 && !isFullyPaid;
        const overdue = !isFullyPaid && isOverdue(scheduleInstallment.dueDate, newGracePeriodDays);
        const paidAt = isFullyPaid
          ? paymentMilestones.find((milestone) => milestone.cumulativePaid >= cumulativeScheduledAmount - 0.005)?.paidAt
            ?? fallbackPaidDates[completedInstallmentCount]
            ?? fallbackPaidDates[fallbackPaidDates.length - 1]
            ?? null
          : null;

        if (isFullyPaid) {
          completedInstallmentCount++;
        }

        return {
          installmentNo: scheduleInstallment.installmentNo,
          dueDate: scheduleInstallment.dueDate,
          amount: scheduleInstallment.amount,
          paidAmount,
          status: isFullyPaid
            ? 'PAID'
            : hasPartialPayment
              ? (overdue ? 'OVERDUE' : 'PARTIAL')
              : (overdue ? 'OVERDUE' : 'PENDING'),
          paidAt,
        };
      });

      correctedEndDate = calculateEndDate(
        new Date(contract.startDate),
        newPaymentFrequency,
        newTotalInstallments
      );
      summaryPaidInstallments = rebucketedInstallments.filter((installment) => installment.status === 'PAID').length;
      summaryRemainingInstallments = rebucketedInstallments.length - summaryPaidInstallments;

      await prisma.$transaction(async (tx) => {
        await tx.installmentSchedule.deleteMany({
          where: { contractId: id },
        });

        await tx.installmentSchedule.createMany({
          data: rebucketedInstallments.map((installment) => ({
            contractId: id,
            installmentNo: installment.installmentNo,
            dueDate: installment.dueDate,
            amount: installment.amount,
            paidAmount: installment.paidAmount,
            status: installment.status,
            paidAt: installment.paidAt,
          })),
        });

        await tx.hirePurchaseContract.update({
          where: { id },
          data: {
            totalPrice: newTotalPrice,
            depositAmount: newDepositAmount,
            financeAmount: newFinanceAmount,
            installmentAmount: newInstallmentAmount,
            totalInstallments: newTotalInstallments,
            paymentFrequency: newPaymentFrequency,
            penaltyPercentage: newPenaltyPercentage,
            gracePeriodDays: newGracePeriodDays,
            outstandingBalance: newOutstandingBalance,
            totalPaid: totalPaidWithDeposit,
            endDate: correctedEndDate,
            status: newContractStatus,
          },
        });
      });
    } else {
      const remainingInstallmentCount = totalInstallments !== undefined
        ? newTotalInstallments - paidInstallments.length
        : unpaidInstallments.length;

      if (remainingInstallmentCount === 0) {
        res.status(400).json({ error: 'No unpaid installments remain to amend' });
        return;
      }

      summaryRemainingInstallments = remainingInstallmentCount;

      // Rebuild unpaid installment amounts, preserving existing due dates where possible.
      // The last remaining installment absorbs any rounding difference.
      const keptUnpaidInstallments = unpaidInstallments.slice(0, remainingInstallmentCount);
      const redistributedAmounts = Array.from({ length: remainingInstallmentCount }, (_, idx) => {
        const isLast = idx === remainingInstallmentCount - 1;
        const amount = isLast
          ? Math.round((remainingBalance - newInstallmentAmount * (remainingInstallmentCount - 1)) * 100) / 100
          : newInstallmentAmount;
        return Math.max(0, amount);
      });
      const updatedUnpaidData = keptUnpaidInstallments.map((inst, idx) => ({
        id: inst.id,
        amount: redistributedAmounts[idx],
      }));

      // If the number of total installments changed, we may need to add or remove unpaid installments
      const installmentCountDelta = remainingInstallmentCount - unpaidInstallments.length;

      await prisma.$transaction(async (tx) => {
        // Update each unpaid installment amount
        for (const upd of updatedUnpaidData) {
          await tx.installmentSchedule.update({
            where: { id: upd.id },
            data: { amount: upd.amount },
          });
        }

        // If we need MORE installments (count increased), append new ones after the last existing
        if (installmentCountDelta > 0) {
          const lastInstallment = contract.installments[contract.installments.length - 1];
          if (!lastInstallment) {
            throw new Error('Contract has no installment schedule to amend');
          }

          let nextDueDate = getNextDueDate(new Date(lastInstallment.dueDate), newPaymentFrequency);
          // Use actual max installmentNo from loaded installments — not contract.totalInstallments,
          // which may lag behind after previous amendments
          const maxInstallmentNo = Math.max(...contract.installments.map((i) => i.installmentNo));
          const startNo = maxInstallmentNo + 1;
          const newInstallments: Array<{
            contractId: string;
            installmentNo: number;
            dueDate: Date;
            amount: number;
          }> = [];

          for (let i = 0; i < installmentCountDelta; i++) {
            newInstallments.push({
              contractId: id,
              installmentNo: startNo + i,
              dueDate: new Date(nextDueDate),
              amount: redistributedAmounts[keptUnpaidInstallments.length + i],
            });
            nextDueDate = getNextDueDate(nextDueDate, newPaymentFrequency);
          }

          await tx.installmentSchedule.createMany({
            data: newInstallments,
          });
        }

        // If we need FEWER installments (count decreased), delete excess unpaid ones from the end
        if (installmentCountDelta < 0) {
          const idsToRemove = unpaidInstallments.slice(remainingInstallmentCount).map((inst) => inst.id);
          if (idsToRemove.length > 0) {
            await tx.installmentSchedule.deleteMany({
              where: { id: { in: idsToRemove } },
            });
          }
        }

        await tx.hirePurchaseContract.update({
          where: { id },
          data: {
            totalPrice: newTotalPrice,
            depositAmount: newDepositAmount,
            financeAmount: newFinanceAmount,
            installmentAmount: newInstallmentAmount,
            totalInstallments: paidInstallments.length + remainingInstallmentCount,
            paymentFrequency: newPaymentFrequency,
            penaltyPercentage: newPenaltyPercentage,
            gracePeriodDays: newGracePeriodDays,
            outstandingBalance: newOutstandingBalance,
            totalPaid: totalPaidWithDeposit,
            status: newContractStatus,
          },
        });
      });
    }

    const newValues = {
      totalPrice: newTotalPrice,
      depositAmount: newDepositAmount,
      financeAmount: newFinanceAmount,
      totalInstallments: shouldRebucketPaidHistory ? newTotalInstallments : paidInstallments.length + summaryRemainingInstallments,
      installmentAmount: newInstallmentAmount,
      paymentFrequency: newPaymentFrequency,
      penaltyPercentage: newPenaltyPercentage,
      gracePeriodDays: newGracePeriodDays,
      outstandingBalance: newOutstandingBalance,
      endDate: correctedEndDate,
      amendmentReason: reason,
      historyRebucketed: shouldRebucketPaidHistory,
      paidInstallmentsAfterCorrection: summaryPaidInstallments,
      remainingInstallmentsAfterCorrection: summaryRemainingInstallments,
    };

    await createAuditLog({
      userId: req.user!.id,
      action: 'AMEND_CONTRACT',
      entity: 'HirePurchaseContract',
      entityId: id,
      oldValues,
      newValues,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    const updatedContract = await prisma.hirePurchaseContract.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, membershipId: true, firstName: true, lastName: true, phone: true } },
        inventoryItem: { include: { product: true } },
        installments: { orderBy: { installmentNo: 'asc' } },
      },
    });

    res.json({
      message: 'Contract amended successfully',
      summary: {
        historyRebucketed: shouldRebucketPaidHistory,
        paidInstallmentsPreserved: summaryPaidInstallments,
        unpaidInstallmentsRecalculated: summaryRemainingInstallments,
        paidInstallmentLabel: shouldRebucketPaidHistory ? 'Corrected paid installments' : 'Paid installments preserved',
        unpaidInstallmentLabel: shouldRebucketPaidHistory ? 'Corrected remaining installments' : 'Unpaid installments recalculated',
        newInstallmentAmount,
        newOutstandingBalance,
      },
      contract: updatedContract,
    });
  } catch (error) {
    console.error('Amend contract error:', error);
    res.status(500).json({ error: 'Failed to amend contract' });
  }
}

// Get all pending installments (Admin)
export async function getAllPendingInstallments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { status, search } = req.query;
    const adminUser = req.user as AdminUserPayload;

    const where: any = {
      contract: {
        status: 'ACTIVE',
      },
    };

    // Filter by status if provided
    if (status && status !== 'ALL') {
      where.status = status;
    } else {
      // Default to showing pending, overdue, and partial installments
      where.status = {
        in: ['PENDING', 'OVERDUE', 'PARTIAL'],
      };
    }

    // Search filter
    if (search && typeof search === 'string') {
      where.OR = [
        {
          contract: {
            contractNumber: {
              contains: search,
              mode: 'insensitive',
            },
          },
        },
        {
          contract: {
            customer: {
              OR: [
                {
                  firstName: {
                    contains: search,
                    mode: 'insensitive',
                  },
                },
                {
                  lastName: {
                    contains: search,
                    mode: 'insensitive',
                  },
                },
                {
                  phone: {
                    contains: search,
                    mode: 'insensitive',
                  },
                },
              ],
            },
          },
        },
      ];
    }

    const hasViewAll = hasPermission(adminUser.permissions, PERMISSIONS.VIEW_CONTRACTS);
    const hasViewOwn = hasPermission(adminUser.permissions, PERMISSIONS.VIEW_OWN_CONTRACTS);
    if (!hasViewAll && hasViewOwn) {
      where.contract.createdById = adminUser.id;
    }

    const installments = await prisma.installmentSchedule.findMany({
      where,
      include: {
        contract: {
          include: {
            customer: {
              select: {
                id: true,
                membershipId: true,
                firstName: true,
                lastName: true,
                phone: true,
                email: true,
              },
            },
            inventoryItem: {
              include: {
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [
        { status: 'desc' }, // OVERDUE first
        { dueDate: 'asc' },
      ],
    });

    res.json({ installments });
  } catch (error) {
    console.error('Get all pending installments error:', error);
    res.status(500).json({ error: 'Failed to get pending installments' });
  }
}

// Pay installment (Admin)
export async function payInstallment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, installmentId } = req.params;
    const { amount, paymentMethod, reference, notes } = req.body;

    if (!amount) {
      res.status(400).json({ error: 'Amount is required' });
      return;
    }

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Contract is not active' });
      return;
    }

    const customer = await prisma.customer.findUnique({
      where: { id_uuid: contract.customerId_uuid },
      select: { id_uuid: true },
    });
    if (!customer?.id_uuid) {
      res.status(500).json({ error: 'Customer UUID missing. Please contact support.' });
      return;
    }

    const installment = await prisma.installmentSchedule.findUnique({
      where: { id: installmentId },
    });

    if (!installment) {
      res.status(404).json({ error: 'Installment not found' });
      return;
    }

    if (installment.contractId !== contractId) {
      res.status(400).json({ error: 'Installment does not belong to this contract' });
      return;
    }

    const paymentAmount = Number(amount);
    const remainingAmount = installment.amount - installment.paidAmount;

    if (paymentAmount <= 0) {
      res.status(400).json({ error: 'Payment amount must be greater than zero' });
      return;
    }

    if (paymentAmount > remainingAmount) {
      res.status(400).json({ error: 'Payment amount exceeds remaining balance' });
      return;
    }

    // Generate transaction reference
    const generateTransactionRef = () => {
      const timestamp = Date.now().toString(36);
      const randomStr = Math.random().toString(36).substring(2, 8);
      return `TXN-${timestamp}-${randomStr}`.toUpperCase();
    };

    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

    // Create payment record
    const payment = await prisma.paymentTransaction.create({
      data: {
        transactionRef,
        contractId,
        customerId_uuid: customer.id_uuid,
        amount: paymentAmount,
        paymentMethod: paymentMethod || 'CASH',
        externalRef: reference,
        status: 'SUCCESS',
        paymentDate: new Date(),
        metadata: JSON.stringify({
          recordedBy: req.user!.id,
          notes,
          isManual: true,
          installmentId,
        }),
      },
    });

    // Update installment
    const newPaidAmount = installment.paidAmount + paymentAmount;
    const isFullyPaid = newPaidAmount >= installment.amount;

    await prisma.installmentSchedule.update({
      where: { id: installmentId },
      data: {
        paidAmount: newPaidAmount,
        status: isFullyPaid ? 'PAID' : 'PARTIAL',
        paidAt: isFullyPaid ? new Date() : installment.paidAt,
      },
    });

    // Update contract totals
    const updatedContract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        installments: true,
      },
    });

    if (updatedContract) {
      const totalPaid = updatedContract.installments.reduce((sum, i) => sum + i.paidAmount, 0);
      const outstandingBalance = updatedContract.financeAmount - totalPaid;

      await prisma.hirePurchaseContract.update({
        where: { id: contractId },
        data: {
          totalPaid,
          outstandingBalance,
          status: outstandingBalance <= 0 ? 'COMPLETED' : 'ACTIVE',
        },
      });
    }

    await createAuditLog({
      userId: req.user!.id,
      action: 'RECORD_INSTALLMENT_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        transactionRef,
        amount: paymentAmount,
        contractId,
        installmentId,
        paymentMethod,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Evaluate Knox Guard policy — unlocks device if all overdue amounts are now cleared
    await safelyEvaluateManagedDeviceForContract(contractId);

    res.status(201).json({
      message: 'Payment recorded successfully',
      transactionRef,
      amount: paymentAmount,
    });
  } catch (error) {
    console.error('Pay installment error:', error);
    res.status(500).json({ error: 'Failed to process payment' });
  }
}
