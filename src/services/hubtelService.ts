import axios from 'axios';
import prisma from '../config/database';
import { sendPaymentFailureNotification } from './notificationService';
import { getRetrySettings, calculateNextRetryDate } from './paymentRetryService';
import { appendWebhookToken } from '../utils/callbackSecurity';

// Hubtel API Configuration
const HUBTEL_POS_SALES_ID = process.env.HUBTEL_POS_SALES_ID || '';
const HUBTEL_API_KEY = process.env.HUBTEL_API_KEY || '';
const HUBTEL_API_SECRET = process.env.HUBTEL_API_SECRET || '';
const RAW_HUBTEL_CALLBACK_URL = process.env.HUBTEL_CALLBACK_URL || '';
const RAW_HUBTEL_PREAPPROVAL_CALLBACK_URL = process.env.HUBTEL_PREAPPROVAL_CALLBACK_URL || '';

function derivePreapprovalCallbackUrl(callbackUrl: string): string {
  if (!callbackUrl) {
    return '';
  }

  try {
    const parsedUrl = new URL(callbackUrl);
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/callback\/?$/, '/preapproval/callback');
    return parsedUrl.toString();
  } catch {
    return callbackUrl.replace(/\/callback\/?$/, '/preapproval/callback');
  }
}

const HUBTEL_PAYMENT_CALLBACK_URL = appendWebhookToken(RAW_HUBTEL_CALLBACK_URL);
const HUBTEL_PREAPPROVAL_CALLBACK_URL = appendWebhookToken(
  RAW_HUBTEL_PREAPPROVAL_CALLBACK_URL || derivePreapprovalCallbackUrl(RAW_HUBTEL_CALLBACK_URL)
);

// API Endpoints
const RECEIVE_MONEY_URL = `https://rmp.hubtel.com/merchantaccount/merchants/${HUBTEL_POS_SALES_ID}/receive/mobilemoney`;
const TRANSACTION_STATUS_URL = `https://api-txnstatus.hubtel.com/transactions/${HUBTEL_POS_SALES_ID}/status`;
const PREAPPROVAL_INITIATE_URL = `https://preapproval.hubtel.com/api/v2/merchant/${HUBTEL_POS_SALES_ID}/preapproval/initiate`;
const PREAPPROVAL_VERIFY_OTP_URL = `https://preapproval.hubtel.com/api/v2/merchant/${HUBTEL_POS_SALES_ID}/preapproval/verifyotp`;
const PREAPPROVAL_STATUS_URL = `https://preapproval.hubtel.com/api/v2/merchant/${HUBTEL_POS_SALES_ID}/preapproval`;
const PREAPPROVAL_CANCEL_URL = `https://preapproval.hubtel.com/api/v2/merchant/${HUBTEL_POS_SALES_ID}/preapproval`;
const PREAPPROVAL_REACTIVATE_URL = `https://preapproval.hubtel.com/api/v2/merchant/${HUBTEL_POS_SALES_ID}/preapproval/reactivate`;

// Helper to create Basic Auth header
function getAuthHeader(): string {
  const credentials = Buffer.from(`${HUBTEL_API_KEY}:${HUBTEL_API_SECRET}`).toString('base64');
  return `Basic ${credentials}`;
}

// Helper to format phone number for Hubtel (233XXXXXXXXX without + sign)
export function formatPhoneForHubtel(phone: string): string {
  let cleaned = phone.replace(/\s/g, '').replace(/\+/g, '');

  // If starts with 0, replace with 233
  if (cleaned.startsWith('0')) {
    cleaned = '233' + cleaned.substring(1);
  }

  // Ensure it starts with 233
  if (!cleaned.startsWith('233')) {
    cleaned = '233' + cleaned;
  }

  return cleaned;
}

// Map network name to Hubtel channel codes
export function getHubtelChannel(network: string, isDirectDebit: boolean = false): string {
  const networkUpper = network.toUpperCase();
  const suffix = isDirectDebit ? '-direct-debit' : '';

  switch (networkUpper) {
    case 'MTN':
      return `mtn-gh${suffix}`;
    case 'VODAFONE':
    case 'TELECEL':
      return `vodafone-gh${suffix}`;
    case 'AIRTELTIGO':
      if (isDirectDebit) {
        throw new Error('AirtelTigo does not support Direct Debit');
      }
      return 'tigo-gh';
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

// ==================== REGULAR RECEIVE MONEY ====================

interface ReceiveMoneyRequest {
  CustomerName: string;
  CustomerMsisdn: string;
  CustomerEmail?: string;
  Channel: string;
  Amount: number;
  PrimaryCallbackUrl: string;
  Description: string;
  ClientReference: string;
}

interface ReceiveMoneyResponse {
  Message: string;
  ResponseCode: string;
  Data: {
    TransactionId: string;
    ClientReference: string;
    Amount: number;
    Charges: number;
    AmountCharged: number;
  };
}

export async function initiateHubtelReceiveMoney(params: {
  amount: number;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  network: string;
  description: string;
  transactionRef: string;
}): Promise<{ transactionId: string; status: string; message: string }> {
  try {
    console.log('=== HUBTEL SERVICE: initiateHubtelReceiveMoney START ===');
    console.log('Input params:', JSON.stringify(params, null, 2));

    const formattedPhone = formatPhoneForHubtel(params.customerPhone);
    console.log('Formatted phone:', formattedPhone);

    const channel = getHubtelChannel(params.network, false);
    console.log('Channel:', channel);

    const payload: ReceiveMoneyRequest = {
      CustomerName: params.customerName,
      CustomerMsisdn: formattedPhone,
      CustomerEmail: params.customerEmail,
      Channel: channel,
      Amount: params.amount,
      PrimaryCallbackUrl: HUBTEL_PAYMENT_CALLBACK_URL,
      Description: params.description,
      ClientReference: params.transactionRef,
    };

    console.log('Hubtel API URL:', RECEIVE_MONEY_URL);
    console.log('Hubtel Payload:', JSON.stringify(payload, null, 2));
    console.log('Hubtel Auth Header:', getAuthHeader().substring(0, 20) + '...');
    console.log('Hubtel POS Sales ID:', HUBTEL_POS_SALES_ID);
    console.log('Hubtel API Key:', HUBTEL_API_KEY);
    console.log('Hubtel API Secret:', HUBTEL_API_SECRET?.substring(0, 5) + '...');
    console.log('Hubtel Callback URL:', HUBTEL_PAYMENT_CALLBACK_URL);

    console.log('Making POST request to Hubtel...');

    const response = await axios.post<ReceiveMoneyResponse>(
      RECEIVE_MONEY_URL,
      payload,
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Hubtel Response Status:', response.status);
    console.log('Hubtel Response Data:', JSON.stringify(response.data, null, 2));
    console.log('=== HUBTEL SERVICE: SUCCESS ===');

    return {
      transactionId: response.data.Data.TransactionId,
      status: response.data.ResponseCode === '0001' ? 'PENDING' : 'FAILED',
      message: response.data.Message,
    };
  } catch (error: any) {
    console.error('=== HUBTEL SERVICE: ERROR ===');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Response status:', error.response?.status);
    console.error('Response status text:', error.response?.statusText);
    console.error('Response data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Response headers:', JSON.stringify(error.response?.headers, null, 2));
    console.error('Request URL:', error.config?.url);
    console.error('Request method:', error.config?.method);
    console.error('Request headers:', JSON.stringify(error.config?.headers, null, 2));
    console.error('=== END HUBTEL SERVICE ERROR ===');

    throw new Error(error.response?.data?.Message || error.message || 'Failed to initiate payment');
  }
}

// ==================== DIRECT DEBIT - PREAPPROVAL ====================

interface PreapprovalInitiateRequest {
  clientReferenceId: string;
  customerMsisdn: string;
  channel: string;
  callbackUrl: string;
}

interface PreapprovalInitiateResponse {
  message: string;
  responseCode: string;
  data: {
    hubtelPreApprovalId: string;
    clientReferenceId: string;
    verificationType: 'USSD' | 'OTP';
    otpPrefix: string | null;
    preapprovalStatus: string;
  };
}

export async function initiatePreapproval(params: {
  customerId: string;
  customerPhone: string;
  network: string;
  clientReferenceId: string;
}): Promise<{
  hubtelPreapprovalId: string;
  clientReferenceId: string;
  verificationType: 'USSD' | 'OTP';
  otpPrefix: string | null;
  status: string;
}> {
  try {
    const formattedPhone = formatPhoneForHubtel(params.customerPhone);
    const channel = getHubtelChannel(params.network, true);

    const payload: PreapprovalInitiateRequest = {
      clientReferenceId: params.clientReferenceId,
      customerMsisdn: formattedPhone,
      channel: channel,
      callbackUrl: HUBTEL_PREAPPROVAL_CALLBACK_URL,
    };

    console.log('Initiating Hubtel Preapproval:', { ...payload, customerMsisdn: '***' });

    const response = await axios.post<PreapprovalInitiateResponse>(
      PREAPPROVAL_INITIATE_URL,
      payload,
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Hubtel Preapproval Response:', response.data);

    // Store preapproval in database
    await prisma.hubtelPreapproval.create({
      data: {
        customerId_uuid: params.customerId,
        customerMsisdn: formattedPhone,
        channel: channel,
        clientReferenceId: params.clientReferenceId,
        hubtelPreapprovalId: response.data.data.hubtelPreApprovalId,
        verificationType: response.data.data.verificationType,
        otpPrefix: response.data.data.otpPrefix,
        status: 'PENDING',
        metadata: JSON.stringify(response.data),
      },
    });

    return {
      hubtelPreapprovalId: response.data.data.hubtelPreApprovalId,
      clientReferenceId: response.data.data.clientReferenceId,
      verificationType: response.data.data.verificationType,
      otpPrefix: response.data.data.otpPrefix,
      status: response.data.data.preapprovalStatus,
    };
  } catch (error: any) {
    console.error('Hubtel Preapproval error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Failed to initiate preapproval');
  }
}

interface VerifyOTPRequest {
  customerMsisdn: string;
  hubtelPreApprovalId: string;
  clientReferenceId: string;
  otpCode: string;
}

interface VerifyOTPResponse {
  message: string;
  responseCode: string;
  data: {
    hubtelPreApprovalId: string;
    preapprovalStatus: string;
  };
}

export async function verifyPreapprovalOTP(params: {
  customerPhone: string;
  hubtelPreapprovalId: string;
  clientReferenceId: string;
  otpCode: string;
}): Promise<{ status: string; message: string }> {
  try {
    const formattedPhone = formatPhoneForHubtel(params.customerPhone);

    const payload: VerifyOTPRequest = {
      customerMsisdn: formattedPhone,
      hubtelPreApprovalId: params.hubtelPreapprovalId,
      clientReferenceId: params.clientReferenceId,
      otpCode: params.otpCode,
    };

    console.log('Verifying Hubtel Preapproval OTP:', { ...payload, customerMsisdn: '***', otpCode: '***' });

    const response = await axios.post<VerifyOTPResponse>(
      PREAPPROVAL_VERIFY_OTP_URL,
      payload,
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Hubtel OTP Verification Response:', response.data);

    return {
      status: response.data.data.preapprovalStatus,
      message: response.data.message,
    };
  } catch (error: any) {
    console.error('Hubtel OTP Verification error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Failed to verify OTP');
  }
}

export async function checkPreapprovalStatus(clientReferenceId: string): Promise<any> {
  try {
    const response = await axios.get(
      `${PREAPPROVAL_STATUS_URL}/${clientReferenceId}/status`,
      {
        headers: {
          'Authorization': getAuthHeader(),
        },
      }
    );

    return response.data;
  } catch (error: any) {
    console.error('Hubtel Preapproval Status error:', error.response?.data || error.message);
    throw new Error('Failed to check preapproval status');
  }
}

export async function cancelPreapproval(customerPhone: string): Promise<boolean> {
  try {
    const formattedPhone = formatPhoneForHubtel(customerPhone);

    const response = await axios.get(
      `${PREAPPROVAL_CANCEL_URL}/${formattedPhone}/cancel`,
      {
        headers: {
          'Authorization': getAuthHeader(),
        },
      }
    );

    return (response.data as any).data === true;
  } catch (error: any) {
    console.error('Hubtel Cancel Preapproval error:', error.response?.data || error.message);
    throw new Error('Failed to cancel preapproval');
  }
}

export async function reactivatePreapproval(params: {
  customerPhone: string;
}): Promise<{ success: boolean; message: string }> {
  try {
    const formattedPhone = formatPhoneForHubtel(params.customerPhone);

    const response = await axios.post(
      PREAPPROVAL_REACTIVATE_URL,
      {
        callbackUrl: HUBTEL_PREAPPROVAL_CALLBACK_URL,
        customerMsisdn: formattedPhone,
      },
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json',
        },
      }
    );

    return {
      success: true,
      message: (response.data as any).message,
    };
  } catch (error: any) {
    console.error('Hubtel Reactivate Preapproval error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Failed to reactivate preapproval');
  }
}

// ==================== DIRECT DEBIT - CHARGE ====================

export async function initiateDirectDebitCharge(params: {
  amount: number;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  network: string;
  description: string;
  transactionRef: string;
}): Promise<{ transactionId: string; status: string; message: string }> {
  try {
    const formattedPhone = formatPhoneForHubtel(params.customerPhone);
    const channel = getHubtelChannel(params.network, true); // Use direct debit channel

    const payload = {
      CustomerName: params.customerName,
      CustomerMsisdn: formattedPhone,
      CustomerEmail: params.customerEmail,
      Channel: channel, // Important: must use -direct-debit suffix
      Amount: params.amount,
      PrimaryCallbackUrl: HUBTEL_PAYMENT_CALLBACK_URL,
      Description: params.description,
      ClientReference: params.transactionRef,
    };

    console.log('Initiating Hubtel Direct Debit Charge:', { ...payload, CustomerMsisdn: '***' });

    const response = await axios.post<ReceiveMoneyResponse>(
      RECEIVE_MONEY_URL,
      payload,
      {
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('Hubtel Direct Debit Response:', response.data);

    return {
      transactionId: response.data.Data.TransactionId,
      status: response.data.ResponseCode === '0001' ? 'PENDING' : 'FAILED',
      message: response.data.Message,
    };
  } catch (error: any) {
    console.error('Hubtel Direct Debit error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.Message || 'Failed to initiate direct debit charge');
  }
}

// ==================== TRANSACTION STATUS CHECK ====================

export async function checkHubtelPaymentStatus(clientReference: string): Promise<any> {
  try {
    const response = await axios.get(
      `${TRANSACTION_STATUS_URL}?clientReference=${clientReference}`,
      {
        headers: {
          'Authorization': getAuthHeader(),
        },
      }
    );

    return response.data;
  } catch (error: any) {
    console.error('Hubtel Status Check error:', error.response?.data || error.message);
    throw new Error('Failed to check payment status');
  }
}

// ==================== CALLBACK PROCESSING ====================

interface NormalizedHubtelCallback {
  responseCode: string;
  message: string;
  data: {
    amount?: number;
    clientReference?: string;
    transactionId?: string;
    externalTransactionId?: string;
    paymentDate?: string;
    description?: string;
    status?: string;
    phoneNumber?: string;
  };
}

function normalizeHubtelCallback(callbackData: any): NormalizedHubtelCallback {
  const rawData = callbackData?.Data || callbackData?.data || {};

  return {
    responseCode: String(callbackData?.ResponseCode || callbackData?.responseCode || '').trim(),
    message: String(callbackData?.Message || callbackData?.message || ''),
    data: {
      amount: typeof rawData.Amount === 'number'
        ? rawData.Amount
        : typeof rawData.amount === 'number'
          ? rawData.amount
          : undefined,
      clientReference: rawData.ClientReference || rawData.clientReference,
      transactionId: rawData.TransactionId || rawData.transactionId,
      externalTransactionId: rawData.ExternalTransactionId || rawData.externalTransactionId,
      paymentDate: rawData.PaymentDate || rawData.paymentDate,
      description: rawData.Description || rawData.description,
      status: rawData.Status || rawData.status,
      phoneNumber:
        rawData.CustomerMsisdn ||
        rawData.customerMsisdn ||
        rawData.PhoneNumber ||
        rawData.phoneNumber ||
        rawData.MobileNumber ||
        rawData.mobileNumber,
    },
  };
}

function resolveHubtelPaymentStatus(callbackData: NormalizedHubtelCallback): 'SUCCESS' | 'FAILED' | 'PENDING' {
  const responseCode = callbackData.responseCode.toUpperCase();
  const callbackStatus = String(callbackData.data.status || '').toUpperCase();

  if (responseCode === '0000' || ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(callbackStatus)) {
    return 'SUCCESS';
  }

  if (responseCode === '2001' || ['FAILED', 'FAIL', 'REJECTED', 'DECLINED', 'CANCELLED'].includes(callbackStatus)) {
    return 'FAILED';
  }

  return 'PENDING';
}

export async function processHubtelCallback(callbackData: unknown): Promise<void> {
  try {
    console.log('Processing Hubtel callback:', callbackData);

    const normalizedCallback = normalizeHubtelCallback(callbackData);
    const {
      amount,
      clientReference,
      transactionId,
      externalTransactionId,
      paymentDate,
      description,
      phoneNumber,
    } = normalizedCallback.data;

    if (!clientReference) {
      console.error('No client reference in callback');
      return;
    }

    // Find the payment transaction
    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionRef: clientReference },
      include: {
        contract: {
          include: {
            installments: {
              where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
              orderBy: { installmentNo: 'asc' },
            },
            penalties: {
              where: { isPaid: false },
            },
          },
        },
      },
    });

    if (!payment) {
      console.error('Payment not found for reference:', clientReference);
      return;
    }

    if (typeof amount === 'number' && Math.abs(payment.amount - amount) > 0.01) {
      throw new Error(`Callback amount mismatch for ${clientReference}`);
    }

    if (phoneNumber && payment.mobileMoneyNumber) {
      const normalizedStoredPhone = formatPhoneForHubtel(payment.mobileMoneyNumber);
      const normalizedCallbackPhone = formatPhoneForHubtel(phoneNumber);
      if (normalizedStoredPhone !== normalizedCallbackPhone) {
        throw new Error(`Callback phone mismatch for ${clientReference}`);
      }
    }

    const paymentStatus = resolveHubtelPaymentStatus(normalizedCallback);
    const failureReason = paymentStatus === 'FAILED'
      ? description || normalizedCallback.message || 'Payment failed - insufficient funds or customer rejection'
      : '';

    if (payment.status === 'SUCCESS') {
      console.log('Ignoring Hubtel callback for already successful payment:', clientReference);
      return;
    }

    if (payment.status === paymentStatus && paymentStatus !== 'PENDING') {
      console.log('Ignoring duplicate Hubtel callback:', clientReference);
      return;
    }

    if (paymentStatus === 'PENDING' && payment.status !== 'PENDING') {
      console.log('Ignoring non-terminal Hubtel callback for settled payment:', clientReference);
      return;
    }

    // Get retry settings for calculating next retry
    const retrySettings = await getRetrySettings();
    const nextRetryAt =
      paymentStatus === 'FAILED' && payment.retryCount < retrySettings.maxRetryAttempts
        ? calculateNextRetryDate(
            payment.retryCount,
            retrySettings.retrySchedule,
            retrySettings.retryIntervalHours
          )
        : null;

    const updatedPayment = await prisma.paymentTransaction.updateMany({
      where: {
        id: payment.id,
        status: {
          not: 'SUCCESS',
        },
      },
      data: {
        status: paymentStatus,
        externalRef: externalTransactionId || transactionId || payment.externalRef,
        paymentDate: paymentStatus === 'SUCCESS'
          ? (paymentDate ? new Date(paymentDate) : new Date())
          : null,
        metadata: JSON.stringify(callbackData),
        failureReason: paymentStatus === 'FAILED' ? failureReason : null,
        nextRetryAt,
      },
    });

    if (updatedPayment.count === 0) {
      console.log('Ignoring duplicate Hubtel callback after status check:', clientReference);
      return;
    }

    // If payment successful, update contract and installments
    if (paymentStatus === 'SUCCESS' && payment.contract) {
      await processSuccessfulPayment(payment, payment.contract);
    }

    // If payment failed, send notification to customer
    if (
      paymentStatus === 'FAILED' &&
      retrySettings.notifyCustomerOnFailure &&
      retrySettings.sendSMSOnFailure
    ) {
      try {
        const contract = await prisma.hirePurchaseContract.findUnique({
          where: { id: payment.contractId },
          include: { customer: true },
        });

        if (contract) {
          await sendPaymentFailureNotification({
            customerFirstName: contract.customer.firstName,
            customerLastName: contract.customer.lastName,
            customerEmail: contract.customer.email || undefined,
            customerPhone: contract.customer.phone,
            customerId: contract.customer.id_uuid!,
            contractNumber: contract.contractNumber,
            contractId: contract.id,
            amount: payment.amount,
            failureReason: failureReason,
            transactionRef: payment.transactionRef,
            nextRetryDate: nextRetryAt || undefined,
          });
        }
      } catch (notificationError) {
        console.error('Error sending payment failure notification:', notificationError);
        // Don't throw - notification failure shouldn't break payment processing
      }
    }

    console.log('Payment callback processed successfully:', clientReference);
  } catch (error) {
    console.error('Error processing Hubtel callback:', error);
    throw error;
  }
}

interface NormalizedPreapprovalCallback {
  customerMsisdn?: string;
  verificationType?: string;
  preapprovalStatus: string;
  hubtelPreapprovalId?: string;
  clientReferenceId?: string;
  createdAt?: string;
}

function normalizePreapprovalCallback(callbackData: any): NormalizedPreapprovalCallback {
  return {
    customerMsisdn: callbackData?.CustomerMsisdn || callbackData?.customerMsisdn,
    verificationType: callbackData?.VerificationType || callbackData?.verificationType,
    preapprovalStatus: String(callbackData?.PreapprovalStatus || callbackData?.preapprovalStatus || ''),
    hubtelPreapprovalId: callbackData?.HubtelPreapprovalId || callbackData?.hubtelPreapprovalId,
    clientReferenceId: callbackData?.ClientReferenceId || callbackData?.clientReferenceId,
    createdAt: callbackData?.CreatedAt || callbackData?.createdAt,
  };
}

export async function processPreapprovalCallback(callbackData: unknown): Promise<void> {
  try {
    console.log('Processing Hubtel preapproval callback:', callbackData);

    const normalizedCallback = normalizePreapprovalCallback(callbackData);
    const { clientReferenceId, preapprovalStatus, hubtelPreapprovalId, customerMsisdn } = normalizedCallback;

    if (!clientReferenceId) {
      console.error('No client reference in preapproval callback');
      return;
    }

    // Find the preapproval
    const preapproval = await prisma.hubtelPreapproval.findUnique({
      where: { clientReferenceId: clientReferenceId },
    });

    if (!preapproval) {
      console.error('Preapproval not found for reference:', clientReferenceId);
      return;
    }

    if (hubtelPreapprovalId && preapproval.hubtelPreapprovalId && preapproval.hubtelPreapprovalId !== hubtelPreapprovalId) {
      throw new Error(`Preapproval callback id mismatch for ${clientReferenceId}`);
    }

    if (customerMsisdn && formatPhoneForHubtel(customerMsisdn) !== preapproval.customerMsisdn) {
      throw new Error(`Preapproval callback phone mismatch for ${clientReferenceId}`);
    }

    const nextStatus = preapprovalStatus.toUpperCase();
    if (!nextStatus) {
      throw new Error(`Missing preapproval status for ${clientReferenceId}`);
    }

    if (preapproval.status === 'APPROVED' && nextStatus !== 'APPROVED') {
      console.log('Ignoring preapproval status downgrade:', clientReferenceId);
      return;
    }

    if (preapproval.status === nextStatus) {
      console.log('Ignoring duplicate preapproval callback:', clientReferenceId);
      return;
    }

    // Update preapproval status
    const updateData: any = {
      status: nextStatus,
      metadata: JSON.stringify(callbackData),
    };

    if (nextStatus === 'APPROVED') {
      updateData.approvedAt = new Date();
    }

    await prisma.hubtelPreapproval.update({
      where: { id: preapproval.id },
      data: updateData,
    });

    console.log('Preapproval callback processed successfully:', clientReferenceId);
  } catch (error) {
    console.error('Error processing preapproval callback:', error);
    throw error;
  }
}

// ==================== HELPER FUNCTIONS ====================

async function processSuccessfulPayment(payment: any, contract: any): Promise<void> {
  let remainingAmount = payment.amount;

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

    const contractUpdate: any = {
      totalPaid: newTotalPaid,
      outstandingBalance: Math.max(0, newOutstandingBalance),
    };

    // Check if fully paid
    if (newOutstandingBalance <= 0) {
      contractUpdate.status = 'COMPLETED';
      contractUpdate.ownershipTransferred = true;
    }

    await tx.hirePurchaseContract.update({
      where: { id: contract.id },
      data: contractUpdate,
    });
  });
}

export default {
  initiateHubtelReceiveMoney,
  initiateDirectDebitCharge,
  initiatePreapproval,
  verifyPreapprovalOTP,
  checkPreapprovalStatus,
  cancelPreapproval,
  reactivatePreapproval,
  checkHubtelPaymentStatus,
  processHubtelCallback,
  processPreapprovalCallback,
  formatPhoneForHubtel,
  getHubtelChannel,
};
