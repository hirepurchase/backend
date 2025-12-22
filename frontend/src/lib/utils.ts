import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-GH', {
    style: 'currency',
    currency: 'GHS',
  }).format(amount);
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-GB').format(d);
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function calculateProgress(totalPaid: number, totalPrice: number): number {
  if (totalPrice === 0) return 0;
  return Math.min((totalPaid / totalPrice) * 100, 100);
}

export function getPaymentFrequencyLabel(frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'): string {
  const labels = {
    DAILY: 'Daily',
    WEEKLY: 'Weekly',
    MONTHLY: 'Monthly',
  };
  return labels[frequency];
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    ACTIVE: 'bg-blue-100 text-blue-800',
    COMPLETED: 'bg-green-100 text-green-800',
    DEFAULTED: 'bg-red-100 text-red-800',
    CANCELLED: 'bg-gray-100 text-gray-800',
    PENDING: 'bg-yellow-100 text-yellow-800',
    PARTIAL: 'bg-orange-100 text-orange-800',
    PAID: 'bg-green-100 text-green-800',
    OVERDUE: 'bg-red-100 text-red-800',
    SUCCESS: 'bg-green-100 text-green-800',
    FAILED: 'bg-red-100 text-red-800',
    AVAILABLE: 'bg-blue-100 text-blue-800',
    SOLD: 'bg-gray-100 text-gray-800',
    RESERVED: 'bg-yellow-100 text-yellow-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-800';
}

export function isOverdue(dueDate: Date | string, gracePeriodDays: number = 0): boolean {
  const due = typeof dueDate === 'string' ? new Date(dueDate) : dueDate;
  const gracePeriod = new Date(due);
  gracePeriod.setDate(gracePeriod.getDate() + gracePeriodDays);
  return new Date() > gracePeriod;
}
