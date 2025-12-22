export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface AdminUser extends User {
  role: string;
  permissions: string[];
}

export interface Customer extends User {
  membershipId: string;
  phone: string;
  address?: string | null;
  nationalId?: string | null;
  dateOfBirth?: Date | null;
  isActivated: boolean;
}

export interface LoginResponse {
  token: string;
  user: AdminUser | Customer;
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  basePrice: number;
  categoryId: string;
  category?: ProductCategory;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductCategory {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryItem {
  id: string;
  productId: string;
  product?: Product;
  serialNumber: string;
  status: 'AVAILABLE' | 'SOLD' | 'RESERVED';
  lockStatus?: 'LOCKED' | 'UNLOCKED';
  registeredUnder?: string;
  contractId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HirePurchaseContract {
  id: string;
  contractNumber: string;
  customerId: string;
  customer?: Customer;
  inventoryItem?: InventoryItem;
  totalPrice: number;
  depositAmount: number;
  financeAmount: number;
  installmentAmount: number;
  paymentFrequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  totalInstallments: number;
  gracePeriodDays: number;
  penaltyPercentage: number;
  startDate: Date;
  endDate: Date;
  status: 'ACTIVE' | 'COMPLETED' | 'DEFAULTED' | 'CANCELLED';
  totalPaid: number;
  outstandingBalance: number;
  ownershipTransferred: boolean;
  installments?: InstallmentSchedule[];
  payments?: PaymentTransaction[];
  createdAt: Date;
  updatedAt: Date;
}

export interface InstallmentSchedule {
  id: string;
  contractId: string;
  installmentNo: number;
  dueDate: Date;
  amount: number;
  paidAmount: number;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';
  paidAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentTransaction {
  id: string;
  transactionRef: string;
  contractId: string;
  customerId: string;
  amount: number;
  paymentMethod: string;
  mobileMoneyProvider?: string;
  mobileMoneyNumber?: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  externalRef?: string;
  paymentDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCustomerDto {
  firstName: string;
  lastName: string;
  phone: string;
  address?: string;
  nationalId?: string;
  dateOfBirth?: string;
}

export interface CreateProductDto {
  name: string;
  description?: string;
  basePrice: number;
  categoryId: string;
}

export interface CreateInventoryItemDto {
  productId: string;
  serialNumber: string;
}

export interface CreateContractDto {
  customerId: string;
  inventoryItemId: string;
  totalPrice: number;
  depositAmount: number;
  paymentFrequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  totalInstallments: number;
  gracePeriodDays?: number;
  penaltyPercentage?: number;
  startDate?: string;
}

export interface InitiatePaymentDto {
  contractId: string;
  amount: number;
  phoneNumber: string;
  provider?: 'MTN' | 'VODAFONE' | 'AIRTELTIGO';
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
