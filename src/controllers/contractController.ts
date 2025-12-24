import { Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { sendContractConfirmation } from '../services/notificationService';
import { AuthenticatedRequest, PaymentFrequency } from '../types';
import {
  generateContractNumber,
  calculateInstallmentSchedule,
  calculateEndDate,
  isOverdue,
  calculatePenalty,
} from '../utils/helpers';
import { uploadToSupabase, deleteFromSupabase } from '../services/storageService';

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
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      res.status(400).json({ error: 'Customer not found' });
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

    // Create contract and update inventory in a transaction
    const contract = await prisma.$transaction(async (tx) => {
      // Create the contract
      const newContract = await tx.hirePurchaseContract.create({
        data: {
          contractNumber,
          customerId,
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

      // Update inventory item status and additional info
      await tx.inventoryItem.update({
        where: { id: inventoryItemId },
        data: {
          status: 'SOLD',
          contractId: newContract.id,
          lockStatus: lockStatus || undefined,
          registeredUnder: registeredUnder || undefined,
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

    // Send contract confirmation notification (non-blocking)
    if (completeContract) {
      sendContractConfirmation({
        customerFirstName: completeContract.customer.firstName,
        customerLastName: completeContract.customer.lastName,
        customerEmail: (completeContract.customer as any).email || undefined,
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

    res.status(201).json(completeContract);
  } catch (error) {
    console.error('Create contract error:', error);
    res.status(500).json({ error: 'Failed to create contract' });
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
    } = req.query;

    const where: Record<string, unknown> = {};

    if (status) where.status = status;
    if (customerId) where.customerId = customerId;

    if (search) {
      where.OR = [
        { contractNumber: { contains: search as string } },
        { customer: { membershipId: { contains: search as string } } },
        { customer: { firstName: { contains: search as string } } },
        { customer: { lastName: { contains: search as string } } },
        { inventoryItem: { serialNumber: { contains: search as string } } },
      ];
    }

    const [contracts, total] = await Promise.all([
      prisma.hirePurchaseContract.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              membershipId: true,
              firstName: true,
              lastName: true,
              phone: true,
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
          _count: {
            select: {
              payments: true,
              installments: true,
            },
          },
        },
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
  } catch (error) {
    console.error('Get contracts error:', error);
    res.status(500).json({ error: 'Failed to fetch contracts' });
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

    // Check ownership for customers
    if (req.userType === 'customer' && contract.customerId !== req.user!.id) {
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

    const contracts = await prisma.hirePurchaseContract.findMany({
      where: { customerId },
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

            await prisma.penalty.create({
              data: {
                contractId: contract.id,
                amount: penaltyAmount,
                reason: `Late payment penalty for installment #${installment.installmentNo}`,
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
    let preapprovalDetails = null;

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
                customerId: contract.customerId,
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
                  customerId: contract.customerId,
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
                    customerId: contract.customerId,
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
        customerId: contract.customerId,
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

// Get all pending installments (Admin)
export async function getAllPendingInstallments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { status, search } = req.query;

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
        customerId: contract.customerId,
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
