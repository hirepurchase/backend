import { Request } from 'express';

export interface AdminUserPayload {
  id: string;
  email: string;
  role: string;
  permissions: string[];
}

export interface CustomerPayload {
  id: string;
  legacyId?: string;
  membershipId: string;
  email: string | null;
}

export interface AuthenticatedRequest extends Request {
  user?: AdminUserPayload | CustomerPayload;
  userType?: 'admin' | 'customer';
}

export type PaymentFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export type ContractStatus = 'ACTIVE' | 'COMPLETED' | 'DEFAULTED' | 'CANCELLED';

export type InstallmentStatus = 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';

export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

export type InventoryStatus = 'AVAILABLE' | 'SOLD' | 'RESERVED';

export interface InstallmentScheduleInput {
  installmentNo: number;
  dueDate: Date;
  amount: number;
}

export interface HirePurchaseTerms {
  paymentFrequency: PaymentFrequency;
  depositAmount: number;
  installmentAmount: number;
  totalInstallments: number;
  gracePeriodDays: number;
  penaltyPercentage: number;
}

export interface MobileMoneyPaymentRequest {
  amount: number;
  phoneNumber: string;
  provider: 'MTN' | 'VODAFONE' | 'AIRTELTIGO';
  contractId: string;
  customerId: string;
  reference: string;
}

export interface MobileMoneyPaymentResponse {
  success: boolean;
  transactionId?: string;
  externalRef?: string;
  message: string;
  status: PaymentStatus;
}

export interface WebhookPayload {
  transactionRef: string;
  externalRef: string;
  status: 'SUCCESS' | 'FAILED';
  amount: number;
  metadata?: Record<string, unknown>;
}
