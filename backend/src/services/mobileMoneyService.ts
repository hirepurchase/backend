import { MobileMoneyPaymentRequest, MobileMoneyPaymentResponse } from '../types';

// Mobile Money Gateway Service
// This is a mock implementation - replace with actual provider SDK (e.g., Paystack, Flutterwave, MTN MoMo API)

const MOMO_API_URL = process.env.MOMO_API_URL || 'https://api.mobilemoney.example.com';
const MOMO_API_KEY = process.env.MOMO_API_KEY || '';
const MOMO_SECRET_KEY = process.env.MOMO_SECRET_KEY || '';

export async function initiatePayment(
  request: MobileMoneyPaymentRequest
): Promise<MobileMoneyPaymentResponse> {
  try {
    // In production, this would make an actual API call to the Mobile Money provider
    // Example with fetch:
    /*
    const response = await fetch(`${MOMO_API_URL}/payments/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MOMO_API_KEY}`,
        'X-Secret-Key': MOMO_SECRET_KEY,
      },
      body: JSON.stringify({
        amount: request.amount,
        phone_number: request.phoneNumber,
        provider: request.provider,
        reference: request.reference,
        callback_url: process.env.MOMO_CALLBACK_URL,
        metadata: {
          contract_id: request.contractId,
          customer_id: request.customerId,
        },
      }),
    });

    const data = await response.json();

    return {
      success: data.status === 'pending' || data.status === 'success',
      transactionId: data.transaction_id,
      externalRef: data.external_reference,
      message: data.message,
      status: data.status === 'success' ? 'SUCCESS' : 'PENDING',
    };
    */

    // Mock implementation for development
    console.log('Mobile Money Payment Request:', {
      amount: request.amount,
      phone: request.phoneNumber,
      provider: request.provider,
      reference: request.reference,
    });

    // Simulate API call delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Mock successful response
    return {
      success: true,
      transactionId: `MOMO-${Date.now()}`,
      externalRef: `EXT-${Math.random().toString(36).substring(7).toUpperCase()}`,
      message: 'Payment initiated. Please approve on your phone.',
      status: 'PENDING',
    };
  } catch (error) {
    console.error('Mobile Money payment error:', error);
    return {
      success: false,
      message: 'Payment initiation failed',
      status: 'FAILED',
    };
  }
}

export async function checkPaymentStatus(transactionRef: string): Promise<{
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  message: string;
}> {
  try {
    // In production, this would check the actual payment status
    /*
    const response = await fetch(`${MOMO_API_URL}/payments/status/${transactionRef}`, {
      headers: {
        'Authorization': `Bearer ${MOMO_API_KEY}`,
      },
    });

    const data = await response.json();
    return {
      status: data.status.toUpperCase(),
      message: data.message,
    };
    */

    // Mock implementation
    console.log('Checking payment status for:', transactionRef);

    // Simulate checking status
    return {
      status: 'SUCCESS',
      message: 'Payment completed successfully',
    };
  } catch (error) {
    console.error('Check payment status error:', error);
    return {
      status: 'FAILED',
      message: 'Failed to check payment status',
    };
  }
}

export function validateProvider(provider: string): boolean {
  return ['MTN', 'VODAFONE', 'AIRTELTIGO'].includes(provider.toUpperCase());
}

export function getProviderFromPhone(phone: string): 'MTN' | 'VODAFONE' | 'AIRTELTIGO' | null {
  // Ghana phone number prefixes
  const cleanPhone = phone.replace(/\D/g, '');
  const prefix = cleanPhone.substring(0, 3);
  const fullPrefix = cleanPhone.substring(0, 4);

  // MTN prefixes: 024, 054, 055, 059
  if (['024', '054', '055', '059'].some(p => cleanPhone.startsWith(p)) ||
      ['0244', '0544', '0554', '0594'].some(p => cleanPhone.startsWith(p))) {
    return 'MTN';
  }

  // Vodafone prefixes: 020, 050
  if (['020', '050'].some(p => cleanPhone.startsWith(p))) {
    return 'VODAFONE';
  }

  // AirtelTigo prefixes: 026, 027, 056, 057
  if (['026', '027', '056', '057'].some(p => cleanPhone.startsWith(p))) {
    return 'AIRTELTIGO';
  }

  return null;
}
