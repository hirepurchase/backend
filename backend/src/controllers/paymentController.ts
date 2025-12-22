import { Request, Response } from 'express';
import prisma from '../config/database';
import { createAuditLog } from '../services/auditService';
import { initiatePayment, checkPaymentStatus, validateProvider, getProviderFromPhone } from '../services/mobileMoneyService';
import {
  initiateHubtelReceiveMoney,
  initiateDirectDebitCharge,
  initiatePreapproval,
  verifyPreapprovalOTP,
  checkPreapprovalStatus,
  checkHubtelPaymentStatus,
  processHubtelCallback,
  processPreapprovalCallback,
  formatPhoneForHubtel,
} from '../services/hubtelService';
import { AuthenticatedRequest, CustomerPayload, WebhookPayload } from '../types';
import { generateTransactionRef, sanitizePhoneNumber, validatePhoneNumber } from '../utils/helpers';

// Initiate payment (Customer)
export async function initiateCustomerPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = req.user!.id;
    const { contractId, amount, phoneNumber, provider } = req.body;

    // Validate required fields
    if (!contractId || !amount || !phoneNumber) {
      res.status(400).json({ error: 'Contract ID, amount, and phone number are required' });
      return;
    }

    // Validate phone number
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
    if (!validatePhoneNumber(sanitizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number' });
      return;
    }

    // Determine provider from phone if not provided
    const paymentProvider = provider?.toUpperCase() || getProviderFromPhone(sanitizedPhone);
    if (!paymentProvider || !validateProvider(paymentProvider)) {
      res.status(400).json({ error: 'Unable to determine mobile money provider. Please specify provider.' });
      return;
    }

    // Validate contract belongs to customer and is active
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        customer: true,
        installments: {
          where: {
            status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
          },
          orderBy: { installmentNo: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.customerId !== customerId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Contract is not active' });
      return;
    }

    // Validate amount
    const paymentAmount = Number(amount);
    if (paymentAmount <= 0) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    if (paymentAmount > contract.outstandingBalance) {
      res.status(400).json({ error: 'Payment amount exceeds outstanding balance' });
      return;
    }

    // Generate transaction reference
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
        customerId,
        amount: paymentAmount,
        paymentMethod: 'MOBILE_MONEY',
        mobileMoneyProvider: paymentProvider,
        mobileMoneyNumber: sanitizedPhone,
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
        }),
      },
    });

    // Initiate mobile money payment
    const momoResponse = await initiatePayment({
      amount: paymentAmount,
      phoneNumber: sanitizedPhone,
      provider: paymentProvider as 'MTN' | 'VODAFONE' | 'AIRTELTIGO',
      contractId,
      customerId,
      reference: transactionRef,
    });

    if (!momoResponse.success) {
      // Update payment as failed
      await prisma.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          metadata: JSON.stringify({
            initiatedAt: new Date().toISOString(),
            error: momoResponse.message,
          }),
        },
      });

      res.status(400).json({ error: momoResponse.message });
      return;
    }

    // Update payment with external reference
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: momoResponse.externalRef,
      },
    });

    await createAuditLog({
      action: 'INITIATE_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        transactionRef,
        amount: paymentAmount,
        provider: paymentProvider,
        contractId,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({
      message: momoResponse.message,
      transactionRef,
      status: 'PENDING',
    });
  } catch (error) {
    console.error('Initiate payment error:', error);
    res.status(500).json({ error: 'Failed to initiate payment' });
  }
}

// Check payment status
export async function getPaymentStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { transactionRef } = req.params;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef },
      include: {
        contract: {
          select: {
            id: true,
            contractNumber: true,
            outstandingBalance: true,
          },
        },
      },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Check ownership for customers
    if (req.userType === 'customer' && payment.customerId !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // If still pending, check with provider
    if (payment.status === 'PENDING') {
      const statusCheck = await checkPaymentStatus(transactionRef);

      if (statusCheck.status !== 'PENDING') {
        // Update payment status
        await prisma.paymentTransaction.update({
          where: { id: payment.id },
          data: {
            status: statusCheck.status,
            paymentDate: statusCheck.status === 'SUCCESS' ? new Date() : null,
          },
        });

        // If successful, process the payment
        if (statusCheck.status === 'SUCCESS') {
          await processSuccessfulPayment(payment.id);
        }

        payment.status = statusCheck.status;
      }
    }

    res.json({
      transactionRef: payment.transactionRef,
      amount: payment.amount,
      status: payment.status,
      provider: payment.mobileMoneyProvider,
      paymentDate: payment.paymentDate,
      contract: payment.contract,
    });
  } catch (error) {
    console.error('Get payment status error:', error);
    res.status(500).json({ error: 'Failed to get payment status' });
  }
}

// Mobile Money webhook handler
export async function handlePaymentWebhook(req: Request, res: Response): Promise<void> {
  try {
    const payload: WebhookPayload = req.body;

    // Validate webhook signature (implementation depends on provider)
    // const isValid = validateWebhookSignature(req);
    // if (!isValid) {
    //   res.status(401).json({ error: 'Invalid signature' });
    //   return;
    // }

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef: payload.transactionRef },
    });

    if (!payment) {
      console.error('Payment not found for webhook:', payload.transactionRef);
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Update payment status
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        status: payload.status,
        externalRef: payload.externalRef,
        paymentDate: payload.status === 'SUCCESS' ? new Date() : null,
        metadata: JSON.stringify({
          ...JSON.parse(payment.metadata || '{}'),
          webhookReceived: new Date().toISOString(),
          webhookPayload: payload,
        }),
      },
    });

    // Process successful payment
    if (payload.status === 'SUCCESS') {
      await processSuccessfulPayment(payment.id);
    }

    await createAuditLog({
      action: 'PAYMENT_WEBHOOK',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        status: payload.status,
        externalRef: payload.externalRef,
      },
    });

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// Process successful payment
async function processSuccessfulPayment(paymentId: string): Promise<void> {
  const payment = await prisma.paymentTransaction.findUnique({
    where: { id: paymentId },
    include: {
      contract: {
        include: {
          installments: {
            where: {
              status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
            },
            orderBy: { installmentNo: 'asc' },
          },
          penalties: {
            where: { isPaid: false },
          },
        },
      },
    },
  });

  if (!payment || !payment.contract) return;

  let remainingAmount = payment.amount;
  const contract = payment.contract;

  await prisma.$transaction(async (tx) => {
    // First, apply to unpaid penalties
    for (const penalty of contract.penalties) {
      if (remainingAmount <= 0) break;

      if (remainingAmount >= penalty.amount) {
        await tx.penalty.update({
          where: { id: penalty.id },
          data: { isPaid: true, paidAt: new Date() },
        });
        remainingAmount -= penalty.amount;
      }
    }

    // Then, apply to installments
    for (const installment of contract.installments) {
      if (remainingAmount <= 0) break;

      const installmentRemaining = installment.amount - installment.paidAmount;

      if (remainingAmount >= installmentRemaining) {
        // Fully pay this installment
        await tx.installmentSchedule.update({
          where: { id: installment.id },
          data: {
            paidAmount: installment.amount,
            status: 'PAID',
            paidAt: new Date(),
          },
        });
        remainingAmount -= installmentRemaining;
      } else {
        // Partial payment
        await tx.installmentSchedule.update({
          where: { id: installment.id },
          data: {
            paidAmount: installment.paidAmount + remainingAmount,
            status: 'PARTIAL',
          },
        });
        remainingAmount = 0;
      }
    }

    // Update contract totals
    const newTotalPaid = contract.totalPaid + payment.amount;
    const newOutstandingBalance = contract.outstandingBalance - payment.amount;

    const contractUpdate: Record<string, unknown> = {
      totalPaid: newTotalPaid,
      outstandingBalance: Math.max(0, newOutstandingBalance),
    };

    // Check if fully paid
    if (newOutstandingBalance <= 0) {
      contractUpdate.status = 'COMPLETED';
    }

    await tx.hirePurchaseContract.update({
      where: { id: contract.id },
      data: contractUpdate,
    });
  });
}

// Get payment history for contract
export async function getContractPayments(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId } = req.params;

    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
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

    const payments = await prisma.paymentTransaction.findMany({
      where: { contractId },
      orderBy: { createdAt: 'desc' },
    });

    res.json(payments);
  } catch (error) {
    console.error('Get contract payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
}

// Admin: Record manual payment
export async function recordManualPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, amount, paymentMethod, reference, notes } = req.body;

    if (!contractId || !amount) {
      res.status(400).json({ error: 'Contract ID and amount are required' });
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

    const paymentAmount = Number(amount);
    if (paymentAmount > contract.outstandingBalance) {
      res.status(400).json({ error: 'Payment amount exceeds outstanding balance' });
      return;
    }

    // Generate transaction reference
    let transactionRef = generateTransactionRef();
    let exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    while (exists) {
      transactionRef = generateTransactionRef();
      exists = await prisma.paymentTransaction.findUnique({ where: { transactionRef } });
    }

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
        }),
      },
    });

    // Process the payment
    await processSuccessfulPayment(payment.id);

    await createAuditLog({
      userId: req.user!.id,
      action: 'RECORD_MANUAL_PAYMENT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        transactionRef,
        amount: paymentAmount,
        contractId,
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
    console.error('Record manual payment error:', error);
    res.status(500).json({ error: 'Failed to record payment' });
  }
}

// Initiate Hubtel payment (Customer)
export async function initiateHubtelPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const customerId = req.user!.id;
    const { contractId, amount, phoneNumber, network } = req.body;

    // Validate required fields
    if (!contractId || !amount || !phoneNumber || !network) {
      res.status(400).json({ error: 'Contract ID, amount, phone number, and network are required' });
      return;
    }

    // Validate network
    const validNetworks = ['MTN', 'VODAFONE', 'AIRTELTIGO'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network. Must be MTN, VODAFONE, or AIRTELTIGO' });
      return;
    }

    // Validate phone number
    const sanitizedPhone = sanitizePhoneNumber(phoneNumber);
    if (!validatePhoneNumber(sanitizedPhone)) {
      res.status(400).json({ error: 'Invalid phone number' });
      return;
    }

    // Validate contract belongs to customer and is active
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: {
        customer: true,
        installments: {
          where: {
            status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
          },
          orderBy: { installmentNo: 'asc' },
        },
      },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.customerId !== customerId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Contract is not active' });
      return;
    }

    // Validate amount
    const paymentAmount = Number(amount);
    if (paymentAmount <= 0) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    if (paymentAmount > contract.outstandingBalance) {
      res.status(400).json({ error: 'Payment amount exceeds outstanding balance' });
      return;
    }

    // Generate transaction reference
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
        customerId,
        amount: paymentAmount,
        paymentMethod: 'HUBTEL_MOMO',
        mobileMoneyProvider: network.toUpperCase(),
        mobileMoneyNumber: sanitizedPhone,
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL',
        }),
      },
    });

    // Initiate Hubtel receive money
    const hubtelResponse = await initiateHubtelReceiveMoney({
      amount: paymentAmount,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      customerPhone: sanitizedPhone,
      network: network.toUpperCase(),
      description: `Payment for contract ${contract.contractNumber}`,
      transactionRef,
    });

    // Update payment with Hubtel transaction ID
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: hubtelResponse.transactionId,
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL',
          hubtelTransactionId: hubtelResponse.transactionId,
          hubtelStatus: hubtelResponse.status,
        }),
      },
    });

    res.status(200).json({
      message: 'Payment initiated successfully. Please approve on your phone.',
      transactionRef,
      transactionId: hubtelResponse.transactionId,
      amount: paymentAmount,
      status: 'PENDING',
    });
  } catch (error: any) {
    console.error('Initiate Hubtel payment error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate payment',
      details: error.response?.data || null,
    });
  }
}

// Check Hubtel payment status
export async function checkHubtelStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { transactionRef } = req.params;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef },
      include: {
        contract: {
          select: {
            contractNumber: true,
            customerId: true,
          },
        },
      },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Check if user has access
    if (req.userType === 'customer' && payment.contract.customerId !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // If already successful or failed, return current status
    if (payment.status === 'SUCCESS' || payment.status === 'FAILED') {
      res.json({
        transactionRef: payment.transactionRef,
        status: payment.status,
        amount: payment.amount,
        paymentDate: payment.paymentDate,
      });
      return;
    }

    // Check status with Hubtel if pending
    if (payment.externalRef) {
      const hubtelStatus = await checkHubtelPaymentStatus(payment.externalRef);

      // Update payment status based on Hubtel response
      let newStatus = payment.status;
      if (hubtelStatus.data?.status === 'Success' || hubtelStatus.data?.status === 'successful') {
        newStatus = 'SUCCESS';
      } else if (hubtelStatus.data?.status === 'Failed' || hubtelStatus.data?.status === 'failed') {
        newStatus = 'FAILED';
      }

      if (newStatus !== payment.status) {
        await prisma.paymentTransaction.update({
          where: { id: payment.id },
          data: {
            status: newStatus,
            paymentDate: newStatus === 'SUCCESS' ? new Date() : null,
          },
        });
      }

      res.json({
        transactionRef: payment.transactionRef,
        status: newStatus,
        amount: payment.amount,
        hubtelStatus: hubtelStatus.data?.status,
      });
    } else {
      res.json({
        transactionRef: payment.transactionRef,
        status: payment.status,
        amount: payment.amount,
      });
    }
  } catch (error: any) {
    console.error('Check Hubtel status error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
}

// Hubtel webhook callback handler
export async function handleHubtelCallback(req: Request, res: Response): Promise<void> {
  try {
    console.log('Hubtel callback received:', req.body);

    // Process the callback
    await processHubtelCallback(req.body);

    // Respond to Hubtel
    res.status(200).json({ message: 'Callback processed successfully' });
  } catch (error) {
    console.error('Hubtel callback error:', error);
    res.status(500).json({ error: 'Failed to process callback' });
  }
}

// ==================== HUBTEL DIRECT DEBIT - PREAPPROVAL ====================

// Initiate preapproval for Direct Debit (Admin)
export async function initiateDirectDebitPreapproval(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { customerId, phoneNumber, network } = req.body;

    if (!customerId || !phoneNumber || !network) {
      res.status(400).json({ error: 'Customer ID, phone number, and network are required' });
      return;
    }

    // Validate network
    const validNetworks = ['MTN', 'VODAFONE', 'TELECEL'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network. Direct Debit only supports MTN, VODAFONE, and TELECEL' });
      return;
    }

    // Check if customer exists
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Check if already has an active preapproval for this network
    const existingPreapproval = await prisma.hubtelPreapproval.findFirst({
      where: {
        customerId,
        customerMsisdn: formatPhoneForHubtel(phoneNumber),
        status: 'APPROVED',
      },
    });

    if (existingPreapproval) {
      res.status(400).json({
        error: 'Customer already has an active preapproval for this phone number',
        preapprovalId: existingPreapproval.id,
      });
      return;
    }

    // Generate unique client reference
    const clientReferenceId = `PREAPPR-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    // Initiate preapproval
    const preapprovalResponse = await initiatePreapproval({
      customerId,
      customerPhone: phoneNumber,
      network: network.toUpperCase(),
      clientReferenceId,
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'INITIATE_PREAPPROVAL',
      entity: 'HubtelPreapproval',
      entityId: clientReferenceId,
      newValues: {
        customerId,
        network: network.toUpperCase(),
        clientReferenceId,
        verificationType: preapprovalResponse.verificationType,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({
      message: preapprovalResponse.verificationType === 'USSD'
        ? 'Customer will receive USSD prompt on their phone'
        : 'Customer will receive OTP via SMS',
      clientReferenceId: preapprovalResponse.clientReferenceId,
      hubtelPreapprovalId: preapprovalResponse.hubtelPreapprovalId,
      verificationType: preapprovalResponse.verificationType,
      otpPrefix: preapprovalResponse.otpPrefix,
      status: preapprovalResponse.status,
    });
  } catch (error: any) {
    console.error('Initiate preapproval error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate preapproval',
    });
  }
}

// Verify OTP for preapproval (Admin)
export async function verifyDirectDebitOTP(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { clientReferenceId, otpCode, phoneNumber } = req.body;

    if (!clientReferenceId || !otpCode || !phoneNumber) {
      res.status(400).json({ error: 'Client reference ID, OTP code, and phone number are required' });
      return;
    }

    // Find the preapproval
    const preapproval = await prisma.hubtelPreapproval.findUnique({
      where: { clientReferenceId },
    });

    if (!preapproval) {
      res.status(404).json({ error: 'Preapproval not found' });
      return;
    }

    if (preapproval.status !== 'PENDING') {
      res.status(400).json({ error: `Preapproval is already ${preapproval.status.toLowerCase()}` });
      return;
    }

    if (!preapproval.hubtelPreapprovalId) {
      res.status(400).json({ error: 'Invalid preapproval state' });
      return;
    }

    // Verify OTP
    const verifyResponse = await verifyPreapprovalOTP({
      customerPhone: phoneNumber,
      hubtelPreapprovalId: preapproval.hubtelPreapprovalId,
      clientReferenceId,
      otpCode,
    });

    res.json({
      message: verifyResponse.message,
      status: verifyResponse.status,
    });
  } catch (error: any) {
    console.error('Verify OTP error:', error);
    res.status(500).json({
      error: error.message || 'Failed to verify OTP',
    });
  }
}

// Check preapproval status (Admin)
export async function getPreapprovalStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { clientReferenceId } = req.params;

    const preapproval = await prisma.hubtelPreapproval.findUnique({
      where: { clientReferenceId },
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
          },
        },
      },
    });

    if (!preapproval) {
      res.status(404).json({ error: 'Preapproval not found' });
      return;
    }

    // If still pending, check with Hubtel
    if (preapproval.status === 'PENDING') {
      try {
        const hubtelStatus = await checkPreapprovalStatus(clientReferenceId);

        if (hubtelStatus.data?.preapprovalStatus && hubtelStatus.data.preapprovalStatus !== preapproval.status) {
          await prisma.hubtelPreapproval.update({
            where: { id: preapproval.id },
            data: {
              status: hubtelStatus.data.preapprovalStatus.toUpperCase(),
              approvedAt: hubtelStatus.data.preapprovalStatus.toUpperCase() === 'APPROVED' ? new Date() : null,
            },
          });

          preapproval.status = hubtelStatus.data.preapprovalStatus.toUpperCase();
        }
      } catch (error) {
        console.error('Failed to check Hubtel status:', error);
      }
    }

    res.json({
      clientReferenceId: preapproval.clientReferenceId,
      hubtelPreapprovalId: preapproval.hubtelPreapprovalId,
      status: preapproval.status,
      verificationType: preapproval.verificationType,
      customerMsisdn: preapproval.customerMsisdn,
      channel: preapproval.channel,
      approvedAt: preapproval.approvedAt,
      customer: preapproval.customer,
      createdAt: preapproval.createdAt,
    });
  } catch (error: any) {
    console.error('Get preapproval status error:', error);
    res.status(500).json({ error: 'Failed to get preapproval status' });
  }
}

// Get all preapprovals for a customer (Admin)
export async function getCustomerPreapprovals(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { customerId } = req.params;

    const preapprovals = await prisma.hubtelPreapproval.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ preapprovals });
  } catch (error) {
    console.error('Get customer preapprovals error:', error);
    res.status(500).json({ error: 'Failed to get preapprovals' });
  }
}

// Hubtel preapproval callback handler
export async function handlePreapprovalCallback(req: Request, res: Response): Promise<void> {
  try {
    console.log('Hubtel preapproval callback received:', req.body);

    // Process the preapproval callback
    await processPreapprovalCallback(req.body);

    // Respond to Hubtel
    res.status(200).json({ message: 'Preapproval callback processed successfully' });
  } catch (error) {
    console.error('Preapproval callback error:', error);
    res.status(500).json({ error: 'Failed to process preapproval callback' });
  }
}

// Initiate Hubtel Regular Receive Money payment (Customer & Admin)
export async function initiateHubtelRegularPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, amount, phoneNumber, network } = req.body;
    const customerId = req.userType === 'customer' ? req.user!.id : undefined;

    if (!contractId || !amount || !phoneNumber || !network) {
      res.status(400).json({ error: 'Contract ID, amount, phone number, and network are required' });
      return;
    }

    // Validate network
    const validNetworks = ['MTN', 'VODAFONE', 'TELECEL', 'AIRTELTIGO'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network' });
      return;
    }

    // Validate contract
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: { customer: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    // Check ownership for customers
    if (customerId && contract.customerId !== customerId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Contract is not active' });
      return;
    }

    // Validate amount
    const paymentAmount = Number(amount);
    if (paymentAmount <= 0 || paymentAmount > contract.outstandingBalance) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    // Generate transaction reference
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
        paymentMethod: 'HUBTEL_REGULAR',
        mobileMoneyProvider: network.toUpperCase(),
        mobileMoneyNumber: formatPhoneForHubtel(phoneNumber),
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_REGULAR',
        }),
      },
    });

    // Initiate Hubtel Receive Money
    const hubtelResponse = await initiateHubtelReceiveMoney({
      amount: paymentAmount,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      customerPhone: phoneNumber,
      customerEmail: contract.customer.email || undefined,
      network: network.toUpperCase(),
      description: `Payment for contract ${contract.contractNumber}`,
      transactionRef,
    });

    // Update payment with transaction ID
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: hubtelResponse.transactionId,
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_REGULAR',
          hubtelTransactionId: hubtelResponse.transactionId,
        }),
      },
    });

    res.status(200).json({
      message: 'Payment initiated. Customer will receive prompt on their phone.',
      transactionRef,
      transactionId: hubtelResponse.transactionId,
      amount: paymentAmount,
      status: 'PENDING',
    });
  } catch (error: any) {
    console.error('Initiate Hubtel Regular payment error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate payment',
    });
  }
}

// Initiate Hubtel Direct Debit payment (Admin only - for recurring payments)
export async function initiateDirectDebitPayment(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { contractId, amount } = req.body;

    if (!contractId) {
      res.status(400).json({ error: 'Contract ID is required' });
      return;
    }

    // Get contract with payment method details
    const contract = await prisma.hirePurchaseContract.findUnique({
      where: { id: contractId },
      include: { customer: true },
    });

    if (!contract) {
      res.status(404).json({ error: 'Contract not found' });
      return;
    }

    if (contract.status !== 'ACTIVE') {
      res.status(400).json({ error: 'Contract is not active' });
      return;
    }

    if (contract.paymentMethod !== 'HUBTEL_DIRECT_DEBIT') {
      res.status(400).json({ error: 'Contract is not set up for Direct Debit payments' });
      return;
    }

    if (!contract.mobileMoneyNetwork || !contract.mobileMoneyNumber) {
      res.status(400).json({ error: 'Contract missing mobile money details' });
      return;
    }

    // Check if customer has approved preapproval
    const preapproval = await prisma.hubtelPreapproval.findFirst({
      where: {
        customerId: contract.customerId,
        customerMsisdn: formatPhoneForHubtel(contract.mobileMoneyNumber),
        status: 'APPROVED',
      },
    });

    if (!preapproval) {
      res.status(400).json({
        error: 'Customer has not approved Direct Debit for this phone number. Please initiate preapproval first.',
      });
      return;
    }

    // Validate amount
    const paymentAmount = amount ? Number(amount) : contract.installmentAmount;
    if (paymentAmount <= 0 || paymentAmount > contract.outstandingBalance) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    // Generate transaction reference
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
        paymentMethod: 'HUBTEL_DIRECT_DEBIT',
        mobileMoneyProvider: contract.mobileMoneyNetwork,
        mobileMoneyNumber: contract.mobileMoneyNumber,
        status: 'PENDING',
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_DIRECT_DEBIT',
          preapprovalId: preapproval.id,
        }),
      },
    });

    // Initiate Direct Debit Charge
    const hubtelResponse = await initiateDirectDebitCharge({
      amount: paymentAmount,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      customerPhone: contract.mobileMoneyNumber,
      customerEmail: contract.customer.email || undefined,
      network: contract.mobileMoneyNetwork,
      description: `Auto-debit for contract ${contract.contractNumber}`,
      transactionRef,
    });

    // Update payment with transaction ID
    await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        externalRef: hubtelResponse.transactionId,
        metadata: JSON.stringify({
          initiatedAt: new Date().toISOString(),
          gateway: 'HUBTEL_DIRECT_DEBIT',
          preapprovalId: preapproval.id,
          hubtelTransactionId: hubtelResponse.transactionId,
        }),
      },
    });

    await createAuditLog({
      userId: req.user!.id,
      action: 'INITIATE_DIRECT_DEBIT',
      entity: 'PaymentTransaction',
      entityId: payment.id,
      newValues: {
        transactionRef,
        amount: paymentAmount,
        contractId,
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(200).json({
      message: 'Direct Debit charge initiated. No customer action required.',
      transactionRef,
      transactionId: hubtelResponse.transactionId,
      amount: paymentAmount,
      status: 'PENDING',
    });
  } catch (error: any) {
    console.error('Initiate Direct Debit payment error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate Direct Debit payment',
    });
  }
}
