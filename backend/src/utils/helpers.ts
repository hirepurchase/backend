import { v4 as uuidv4 } from 'uuid';
import { PaymentFrequency, InstallmentScheduleInput } from '../types';

export function generateMembershipId(): string {
  const prefix = 'HP';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${timestamp}${random}`;
}

export function generateContractNumber(): string {
  const prefix = 'CON';
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${year}${month}${random}`;
}

export function generateTransactionRef(): string {
  const prefix = 'TXN';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = uuidv4().split('-')[0].toUpperCase();
  return `${prefix}${timestamp}${random}`;
}

export function calculateInstallmentSchedule(
  financeAmount: number,
  frequency: PaymentFrequency,
  totalInstallments: number,
  startDate: Date
): InstallmentScheduleInput[] {
  const installmentAmount = Math.ceil((financeAmount / totalInstallments) * 100) / 100;
  const schedule: InstallmentScheduleInput[] = [];

  let currentDate = new Date(startDate);

  for (let i = 1; i <= totalInstallments; i++) {
    // Adjust amount for last installment to handle rounding
    const amount = i === totalInstallments
      ? financeAmount - (installmentAmount * (totalInstallments - 1))
      : installmentAmount;

    schedule.push({
      installmentNo: i,
      dueDate: new Date(currentDate),
      amount: Math.round(amount * 100) / 100,
    });

    // Move to next due date based on frequency
    currentDate = getNextDueDate(currentDate, frequency);
  }

  return schedule;
}

export function getNextDueDate(currentDate: Date, frequency: PaymentFrequency): Date {
  const nextDate = new Date(currentDate);

  switch (frequency) {
    case 'DAILY':
      nextDate.setDate(nextDate.getDate() + 1);
      break;
    case 'WEEKLY':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'MONTHLY':
      nextDate.setMonth(nextDate.getMonth() + 1);
      break;
  }

  return nextDate;
}

export function calculateEndDate(
  startDate: Date,
  frequency: PaymentFrequency,
  totalInstallments: number
): Date {
  let endDate = new Date(startDate);

  for (let i = 0; i < totalInstallments; i++) {
    endDate = getNextDueDate(endDate, frequency);
  }

  return endDate;
}

export function isOverdue(dueDate: Date, gracePeriodDays: number = 0): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueWithGrace = new Date(dueDate);
  dueWithGrace.setDate(dueWithGrace.getDate() + gracePeriodDays);
  dueWithGrace.setHours(0, 0, 0, 0);

  return today > dueWithGrace;
}

export function calculatePenalty(amount: number, penaltyPercentage: number): number {
  return Math.round((amount * penaltyPercentage / 100) * 100) / 100;
}

export function formatCurrency(amount: number, currency: string = 'GHS'): string {
  return new Intl.NumberFormat('en-GH', {
    style: 'currency',
    currency,
  }).format(amount);
}

export function sanitizePhoneNumber(phone: string): string {
  // Remove all non-numeric characters
  let cleaned = phone.replace(/\D/g, '');

  // Handle Ghana phone numbers
  if (cleaned.startsWith('233')) {
    cleaned = '0' + cleaned.slice(3);
  } else if (cleaned.startsWith('0') && cleaned.length === 10) {
    // Already in correct format
  } else if (cleaned.length === 9) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
}

export function validatePhoneNumber(phone: string): boolean {
  const sanitized = sanitizePhoneNumber(phone);
  // Ghana phone numbers are 10 digits starting with 0
  return /^0[235]\d{8}$/.test(sanitized);
}
