import { PrismaClient } from '@prisma/client';
import {
  initiateDirectDebitCharge,
  initiateHubtelReceiveMoney,
} from './hubtelService';
import { sendPaymentFailureNotification } from './notificationService';

const prisma = new PrismaClient();

// Get retry settings (creates default if not exists)
export async function getRetrySettings() {
  let settings = await prisma.retrySettings.findFirst();

  if (!settings) {
    // Create default settings
    settings = await prisma.retrySettings.create({
      data: {
        enableAutoRetry: true,
        maxRetryAttempts: 3,
        retryIntervalHours: 24,
        retrySchedule: '1,3,7', // Retry on day 1, 3, and 7
        notifyOnFailure: true,
        notifyCustomerOnFailure: true,
        sendSMSOnFailure: true,
        failureSMSTemplate:
          'Dear {customerName}, your payment of GHS {amount} failed due to insufficient funds. Please ensure you have enough balance for the next retry.',
      },
    });
  }

  return settings;
}

// Update retry settings
export async function updateRetrySettings(data: {
  enableAutoRetry?: boolean;
  maxRetryAttempts?: number;
  retryIntervalHours?: number;
  retrySchedule?: string;
  notifyOnFailure?: boolean;
  notifyCustomerOnFailure?: boolean;
  sendSMSOnFailure?: boolean;
  failureSMSTemplate?: string;
}) {
  const settings = await getRetrySettings();

  return await prisma.retrySettings.update({
    where: { id: settings.id },
    data,
  });
}

// Calculate next retry date based on retry schedule
export function calculateNextRetryDate(
  retryCount: number,
  retrySchedule: string,
  retryIntervalHours: number
): Date | null {
  const scheduleArray = retrySchedule.split(',').map((d) => parseInt(d.trim()));

  if (retryCount >= scheduleArray.length) {
    return null; // No more retries
  }

  const daysToAdd = scheduleArray[retryCount];
  const nextRetry = new Date();
  nextRetry.setDate(nextRetry.getDate() + daysToAdd);
  nextRetry.setHours(nextRetry.getHours() + retryIntervalHours);

  return nextRetry;
}

// Get all failed payments that need retry
export async function getPaymentsForRetry(): Promise<any[]> {
  const settings = await getRetrySettings();

  if (!settings.enableAutoRetry) {
    return [];
  }

  const now = new Date();

  // Get all failed payments that:
  // 1. Are failed
  // 2. Have auto retry enabled
  // 3. Haven't exceeded max retries
  // 4. Next retry date is now or in the past
  const payments = await prisma.paymentTransaction.findMany({
    where: {
      status: 'FAILED',
      isAutoRetryEnabled: true,
      retryCount: {
        lt: settings.maxRetryAttempts,
      },
      nextRetryAt: {
        lte: now,
      },
    },
    include: {
      contract: {
        include: {
          customer: true,
          inventoryItem: {
            include: {
              product: true,
            },
          },
        },
      },
    },
  });

  return payments;
}

// Retry a specific payment
export async function retryPayment(paymentId: string): Promise<{
  success: boolean;
  message: string;
  payment?: any;
  error?: string;
}> {
  try {
    const payment = await prisma.paymentTransaction.findUnique({
      where: { id: paymentId },
      include: {
        contract: {
          include: {
            customer: true,
          },
        },
      },
    });

    if (!payment) {
      return { success: false, message: 'Payment not found' };
    }

    if (payment.status !== 'FAILED') {
      return { success: false, message: 'Payment is not in FAILED status' };
    }

    const settings = await getRetrySettings();

    if (payment.retryCount >= settings.maxRetryAttempts) {
      return {
        success: false,
        message: 'Maximum retry attempts exceeded',
      };
    }

    // Increment retry count
    const newRetryCount = payment.retryCount + 1;

    // Calculate next retry date
    const nextRetryAt = calculateNextRetryDate(
      newRetryCount,
      settings.retrySchedule,
      settings.retryIntervalHours
    );

    // Create retry attempt record
    const retryAttempt = await prisma.paymentRetry.create({
      data: {
        paymentId: payment.id,
        attemptNumber: newRetryCount,
        status: 'PENDING',
      },
    });

    let result: any;
    let retrySuccess = false;
    let responseCode = '';
    let responseMessage = '';
    let externalRef = '';

    try {
      // Determine payment method and retry
      if (payment.contract.paymentMethod === 'HUBTEL_DIRECT_DEBIT') {
        // Direct Debit retry
        result = await initiateDirectDebitCharge({
          amount: payment.amount,
          customerPhone: payment.contract.mobileMoneyNumber!,
          customerName: `${payment.contract.customer.firstName} ${payment.contract.customer.lastName}`,
          customerEmail: payment.contract.customer.email || undefined,
          network: payment.contract.mobileMoneyNetwork!,
          description: `Retry ${newRetryCount} - Contract ${payment.contract.contractNumber} - Installment Payment`,
          transactionRef: `${payment.transactionRef}-retry-${newRetryCount}`,
        });
      } else if (payment.contract.paymentMethod === 'HUBTEL_REGULAR') {
        // Regular payment retry
        result = await initiateHubtelReceiveMoney({
          amount: payment.amount,
          customerPhone: payment.contract.mobileMoneyNumber!,
          customerName: `${payment.contract.customer.firstName} ${payment.contract.customer.lastName}`,
          customerEmail: payment.contract.customer.email || undefined,
          network: payment.contract.mobileMoneyNetwork!,
          description: `Retry ${newRetryCount} - Contract ${payment.contract.contractNumber} - Installment Payment`,
          transactionRef: `${payment.transactionRef}-retry-${newRetryCount}`,
        });
      } else {
        return {
          success: false,
          message: 'Payment method does not support automatic retry',
        };
      }

      responseCode = result.ResponseCode || '';
      responseMessage = result.Message || '';
      externalRef = result.Data?.CheckoutId || result.Data?.TransactionId || '';

      // Check if retry was successful
      if (responseCode === '0000' || responseCode === '0001') {
        retrySuccess = true;
      }
    } catch (error: any) {
      responseMessage = error.message || 'Unknown error during retry';
      console.error('Error during payment retry:', error);
    }

    // Update retry attempt
    await prisma.paymentRetry.update({
      where: { id: retryAttempt.id },
      data: {
        status: retrySuccess ? 'SUCCESS' : 'FAILED',
        transactionRef: `${payment.transactionRef}-retry-${newRetryCount}`,
        externalRef,
        responseCode,
        responseMessage,
        failureReason: retrySuccess ? null : responseMessage,
        completedAt: new Date(),
      },
    });

    // Update payment
    const updatedPayment = await prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        retryCount: newRetryCount,
        lastRetryAt: new Date(),
        nextRetryAt: retrySuccess ? null : nextRetryAt,
        status: retrySuccess ? 'PENDING' : 'FAILED',
        failureReason: retrySuccess ? null : responseMessage,
      },
    });

    // Send notification if retry failed and customer notification is enabled
    if (!retrySuccess && settings.notifyCustomerOnFailure && settings.sendSMSOnFailure) {
      await sendPaymentFailureNotification({
        customerFirstName: payment.contract.customer.firstName,
        customerLastName: payment.contract.customer.lastName,
        customerEmail: payment.contract.customer.email || undefined,
        customerPhone: payment.contract.customer.phone,
        customerId: payment.contract.customer.id,
        contractNumber: payment.contract.contractNumber,
        contractId: payment.contract.id,
        amount: payment.amount,
        failureReason: responseMessage || 'insufficient funds',
        transactionRef: payment.transactionRef,
        nextRetryDate: nextRetryAt || undefined,
      });
    }

    return {
      success: true,
      message: retrySuccess
        ? 'Payment retry initiated successfully'
        : 'Payment retry failed, next retry scheduled',
      payment: updatedPayment,
    };
  } catch (error: any) {
    console.error('Error in retryPayment:', error);
    return {
      success: false,
      message: 'Error retrying payment',
      error: error.message,
    };
  }
}

// Retry all eligible failed payments
export async function retryAllEligiblePayments(): Promise<{
  success: boolean;
  processed: number;
  succeeded: number;
  failed: number;
  results: any[];
}> {
  const payments = await getPaymentsForRetry();

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (const payment of payments) {
    const result = await retryPayment(payment.id);
    results.push({
      paymentId: payment.id,
      transactionRef: payment.transactionRef,
      ...result,
    });

    if (result.success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  return {
    success: true,
    processed: payments.length,
    succeeded,
    failed,
    results,
  };
}

// Get all failed payments for admin dashboard
export async function getFailedPayments(filters?: {
  contractId?: string;
  customerId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ payments: any[]; total: number }> {
  const where: any = {
    status: 'FAILED',
  };

  if (filters?.contractId) {
    where.contractId = filters.contractId;
  }

  if (filters?.customerId) {
    where.customerId = filters.customerId;
  }

  const [payments, total] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where,
      include: {
        contract: {
          include: {
            customer: true,
            inventoryItem: {
              include: {
                product: true,
              },
            },
          },
        },
        retries: {
          orderBy: {
            attemptNumber: 'desc',
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip: filters?.offset || 0,
      take: filters?.limit || 50,
    }),
    prisma.paymentTransaction.count({ where }),
  ]);

  return { payments, total };
}

// Get retry history for a payment
export async function getPaymentRetryHistory(paymentId: string) {
  return await prisma.paymentRetry.findMany({
    where: { paymentId },
    orderBy: {
      attemptNumber: 'asc',
    },
  });
}

// Helper function to get channel code
function getChannelCode(network: string, isDirectDebit: boolean): string {
  const networkMap: { [key: string]: string } = {
    MTN: 'mtn-gh',
    VODAFONE: 'vodafone-gh',
    TELECEL: 'vodafone-gh',
    AIRTELTIGO: 'tigo-gh',
  };

  const baseChannel = networkMap[network.toUpperCase()] || 'mtn-gh';

  return isDirectDebit ? `${baseChannel}-direct-debit` : baseChannel;
}

export default {
  getRetrySettings,
  updateRetrySettings,
  retryPayment,
  retryAllEligiblePayments,
  getFailedPayments,
  getPaymentRetryHistory,
  getPaymentsForRetry,
};
