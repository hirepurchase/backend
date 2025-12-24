import { Request, Response } from 'express';
import prisma from '../config/database';
import {
  initiateHubtelReceiveMoney,
  initiatePreapproval,
  verifyPreapprovalOTP,
  checkPreapprovalStatus,
  cancelPreapproval,
  reactivatePreapproval,
  initiateDirectDebitCharge,
  checkHubtelPaymentStatus,
  formatPhoneForHubtel,
} from '../services/hubtelService';
import { generateTransactionRef } from '../utils/helpers';

// Get all customers for testing
export async function getTestCustomers(req: Request, res: Response): Promise<void> {
  try {
    const customers = await prisma.customer.findMany({
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
      },
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ customers });
  } catch (error) {
    console.error('Get test customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
}

// Get active contracts for testing
export async function getTestContracts(req: Request, res: Response): Promise<void> {
  try {
    const contracts = await prisma.hirePurchaseContract.findMany({
      where: {
        status: { in: ['ACTIVE', 'PENDING'] },
      },
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phone: true,
            email: true,
          },
        },
      },
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ contracts });
  } catch (error) {
    console.error('Get test contracts error:', error);
    res.status(500).json({ error: 'Failed to fetch contracts' });
  }
}

// Test 1: Initiate Regular Receive Money Payment
export async function testReceiveMoney(req: Request, res: Response): Promise<void> {
  try {
    console.log('=== TEST RECEIVE MONEY START ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));

    const { amount, customerPhone, network, customerName, description } = req.body;

    if (!amount || !customerPhone || !network) {
      console.log('ERROR: Missing required fields');
      res.status(400).json({ error: 'Amount, phone, and network are required' });
      return;
    }

    const transactionRef = generateTransactionRef();
    console.log('Generated transaction ref:', transactionRef);

    const params = {
      amount: parseFloat(amount),
      customerName: customerName || 'Test Customer',
      customerPhone,
      network: network.toUpperCase(),
      description: description || `Test payment ${transactionRef}`,
      transactionRef,
    };

    console.log('Calling initiateHubtelReceiveMoney with params:', JSON.stringify(params, null, 2));

    const result = await initiateHubtelReceiveMoney(params);

    console.log('Hubtel API Response:', JSON.stringify(result, null, 2));
    console.log('=== TEST RECEIVE MONEY SUCCESS ===');

    res.json({
      success: true,
      transactionRef,
      ...result,
    });
  } catch (error: any) {
    console.error('=== TEST RECEIVE MONEY ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Hubtel response data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Hubtel response status:', error.response?.status);
    console.error('Hubtel response headers:', JSON.stringify(error.response?.headers, null, 2));
    console.error('=== END ERROR ===');

    res.status(500).json({
      error: error.message || 'Failed to initiate receive money',
      details: error.response?.data || null,
      hubtelStatus: error.response?.status,
    });
  }
}

// Test 2: Initiate Preapproval (Direct Debit Setup)
export async function testInitiatePreapproval(req: Request, res: Response): Promise<void> {
  try {
    const { customerId, customerPhone, network } = req.body;

    if (!customerId || !customerPhone || !network) {
      res.status(400).json({ error: 'Customer ID, phone, and network are required' });
      return;
    }

    // Validate network supports direct debit
    const validNetworks = ['MTN', 'VODAFONE', 'TELECEL'];
    if (!validNetworks.includes(network.toUpperCase())) {
      res.status(400).json({ error: 'Invalid network. Direct Debit supports MTN, VODAFONE, and TELECEL only' });
      return;
    }

    const clientReferenceId = `TEST-PREAPPR-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

    const result = await initiatePreapproval({
      customerId,
      customerPhone,
      network: network.toUpperCase(),
      clientReferenceId,
    });

    res.json({
      success: true,
      message: result.verificationType === 'USSD'
        ? 'Customer will receive USSD prompt on their phone'
        : 'Customer will receive OTP via SMS',
      ...result,
    });
  } catch (error: any) {
    console.error('Test Initiate Preapproval error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate preapproval',
      details: error.response?.data || null,
    });
  }
}

// Test 3: Verify Preapproval OTP
export async function testVerifyPreapprovalOTP(req: Request, res: Response): Promise<void> {
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

    if (!preapproval.hubtelPreapprovalId) {
      res.status(400).json({ error: 'Invalid preapproval state' });
      return;
    }

    const result = await verifyPreapprovalOTP({
      customerPhone: phoneNumber,
      hubtelPreapprovalId: preapproval.hubtelPreapprovalId,
      clientReferenceId,
      otpCode,
    });

    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error('Test Verify OTP error:', error);
    res.status(500).json({
      error: error.message || 'Failed to verify OTP',
      details: error.response?.data || null,
    });
  }
}

// Test 4: Check Preapproval Status
export async function testCheckPreapprovalStatus(req: Request, res: Response): Promise<void> {
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

    // Check with Hubtel if still pending
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
      success: true,
      preapproval,
    });
  } catch (error: any) {
    console.error('Test Check Preapproval Status error:', error);
    res.status(500).json({ error: 'Failed to check preapproval status' });
  }
}

// Test 5: Cancel Preapproval
export async function testCancelPreapproval(req: Request, res: Response): Promise<void> {
  try {
    const { customerPhone } = req.body;

    if (!customerPhone) {
      res.status(400).json({ error: 'Customer phone is required' });
      return;
    }

    const result = await cancelPreapproval(customerPhone);

    res.json({
      success: result,
      message: result ? 'Preapproval cancelled successfully' : 'Failed to cancel preapproval',
    });
  } catch (error: any) {
    console.error('Test Cancel Preapproval error:', error);
    res.status(500).json({
      error: error.message || 'Failed to cancel preapproval',
    });
  }
}

// Test 6: Reactivate Preapproval
export async function testReactivatePreapproval(req: Request, res: Response): Promise<void> {
  try {
    const { customerPhone } = req.body;

    if (!customerPhone) {
      res.status(400).json({ error: 'Customer phone is required' });
      return;
    }

    const result = await reactivatePreapproval({ customerPhone });

    res.json({
      success: result.success,
      message: result.message,
    });
  } catch (error: any) {
    console.error('Test Reactivate Preapproval error:', error);
    res.status(500).json({
      error: error.message || 'Failed to reactivate preapproval',
    });
  }
}

// Test 7: Initiate Direct Debit Charge
export async function testDirectDebitCharge(req: Request, res: Response): Promise<void> {
  try {
    const { amount, customerPhone, network, customerName, description } = req.body;

    if (!amount || !customerPhone || !network) {
      res.status(400).json({ error: 'Amount, phone, and network are required' });
      return;
    }

    // Check if customer has approved preapproval
    const preapproval = await prisma.hubtelPreapproval.findFirst({
      where: {
        customerMsisdn: formatPhoneForHubtel(customerPhone),
        status: 'APPROVED',
      },
    });

    if (!preapproval) {
      res.status(400).json({
        error: 'Customer has not approved Direct Debit. Please initiate and approve preapproval first.',
      });
      return;
    }

    const transactionRef = generateTransactionRef();

    const result = await initiateDirectDebitCharge({
      amount: parseFloat(amount),
      customerName: customerName || 'Test Customer',
      customerPhone,
      network: network.toUpperCase(),
      description: description || `Test direct debit ${transactionRef}`,
      transactionRef,
    });

    res.json({
      success: true,
      transactionRef,
      ...result,
    });
  } catch (error: any) {
    console.error('Test Direct Debit Charge error:', error);
    res.status(500).json({
      error: error.message || 'Failed to initiate direct debit charge',
      details: error.response?.data || null,
    });
  }
}

// Test 8: Check Payment Status
export async function testCheckPaymentStatus(req: Request, res: Response): Promise<void> {
  try {
    const { transactionRef } = req.params;

    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef },
      include: {
        contract: {
          select: {
            contractNumber: true,
            customer: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      res.status(404).json({ error: 'Payment not found in local database' });
      return;
    }

    // Check with Hubtel if we have external ref
    let hubtelStatus = null;
    if (payment.externalRef) {
      try {
        hubtelStatus = await checkHubtelPaymentStatus(transactionRef);
      } catch (error) {
        console.error('Failed to check Hubtel status:', error);
      }
    }

    res.json({
      success: true,
      localStatus: {
        transactionRef: payment.transactionRef,
        status: payment.status,
        amount: payment.amount,
        paymentMethod: payment.paymentMethod,
        externalRef: payment.externalRef,
        paymentDate: payment.paymentDate,
        createdAt: payment.createdAt,
      },
      hubtelStatus,
      contract: payment.contract,
    });
  } catch (error: any) {
    console.error('Test Check Payment Status error:', error);
    res.status(500).json({ error: 'Failed to check payment status' });
  }
}

// Get all test preapprovals
export async function getTestPreapprovals(req: Request, res: Response): Promise<void> {
  try {
    const preapprovals = await prisma.hubtelPreapproval.findMany({
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
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ preapprovals });
  } catch (error) {
    console.error('Get test preapprovals error:', error);
    res.status(500).json({ error: 'Failed to fetch preapprovals' });
  }
}

// Get recent test payments
export async function getTestPayments(req: Request, res: Response): Promise<void> {
  try {
    const payments = await prisma.paymentTransaction.findMany({
      where: {
        paymentMethod: { in: ['HUBTEL_MOMO', 'HUBTEL_REGULAR', 'HUBTEL_DIRECT_DEBIT'] },
      },
      include: {
        contract: {
          select: {
            contractNumber: true,
            customer: {
              select: {
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ payments });
  } catch (error) {
    console.error('Get test payments error:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
}
