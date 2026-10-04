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

/**
 * Round a money value to 2 decimal places using integer-cent arithmetic,
 * avoiding IEEE-754 drift (e.g. 111.66999999999998 -> 111.67).
 */
export function roundMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * True when two money values are equal within half a cent, or `a` is
 * effectively >= `b`. Use instead of raw >=/<=/== comparisons on money
 * so leftover fractions-of-a-cent from float arithmetic don't block a
 * payment from settling an installment/contract balance.
 */
export function isMoneyGte(a: number, b: number): boolean {
  return roundMoney(a) >= roundMoney(b) - 0.005;
}

/** Saturday and Sunday are not collection days. */
export function isWeekend(date: Date): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * Move a date forward to the next collection day, so nothing ever falls due on
 * a Saturday or Sunday. A date already on a weekday is returned unchanged.
 */
export function toBusinessDay(date: Date): Date {
  const result = new Date(date);
  while (isWeekend(result)) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}

/** Advance by one frequency period, ignoring weekends. */
function advanceByFrequency(date: Date, frequency: PaymentFrequency): Date {
  const next = new Date(date);

  switch (frequency) {
    case 'DAILY':
      next.setDate(next.getDate() + 1);
      break;
    case 'WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'MONTHLY':
      next.setMonth(next.getMonth() + 1);
      break;
  }

  return next;
}

/**
 * The due dates for a contract, in order, none of them on a weekend.
 *
 * The `anchor` carries the contract's own cadence and is never shifted, so a
 * monthly contract due on the 15th stays on the 15th even when one month's 15th
 * falls on a Saturday. Each date is moved off the weekend as it is emitted,
 * rather than carried forward shifted, which would make the due date creep
 * later and later.
 *
 * Daily collections are the exception: they run on working days, so each one is
 * counted from the day actually collected. Friday's next due date is Monday.
 */
function buildDueDates(
  frequency: PaymentFrequency,
  totalInstallments: number,
  startDate: Date
): Date[] {
  const dueDates: Date[] = [];
  let anchor = new Date(startDate);

  for (let i = 0; i < totalInstallments; i++) {
    const dueDate = toBusinessDay(anchor);
    dueDates.push(dueDate);

    anchor = frequency === 'DAILY'
      ? advanceByFrequency(dueDate, 'DAILY')
      : advanceByFrequency(anchor, frequency);
  }

  return dueDates;
}

export function calculateInstallmentSchedule(
  financeAmount: number,
  frequency: PaymentFrequency,
  totalInstallments: number,
  startDate: Date
): InstallmentScheduleInput[] {
  const installmentAmount = Math.ceil((financeAmount / totalInstallments) * 100) / 100;
  const dueDates = buildDueDates(frequency, totalInstallments, startDate);

  return dueDates.map((dueDate, index) => {
    const installmentNo = index + 1;

    // Adjust amount for last installment to handle rounding
    const amount = installmentNo === totalInstallments
      ? financeAmount - (installmentAmount * (totalInstallments - 1))
      : installmentAmount;

    return {
      installmentNo,
      dueDate,
      amount: Math.round(amount * 100) / 100,
    };
  });
}

export function getNextDueDate(currentDate: Date, frequency: PaymentFrequency): Date {
  return toBusinessDay(advanceByFrequency(currentDate, frequency));
}

export function calculateEndDate(
  startDate: Date,
  frequency: PaymentFrequency,
  totalInstallments: number
): Date {
  const dueDates = buildDueDates(frequency, totalInstallments, startDate);
  const lastDueDate = dueDates[dueDates.length - 1];

  // The contract runs one period past the final installment. With no
  // installments at all there is nothing to run past, so the start date stands.
  return lastDueDate ? getNextDueDate(lastDueDate, frequency) : toBusinessDay(startDate);
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
  // Remove all non-numeric characters (trim whitespace first)
  let cleaned = phone.trim().replace(/\D/g, '');

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

export const MINIMUM_CUSTOMER_AGE_YEARS = 20;

/** Whole years completed between `dob` and `at`. */
export function calculateAge(dob: Date, at: Date = new Date()): number {
  let age = at.getFullYear() - dob.getFullYear();
  const monthDiff = at.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

/**
 * Returns an error message when the date of birth is unusable or puts the
 * customer under the minimum age, otherwise null. Also rejects unparseable
 * and future dates, which is how most of the bad rows got in — a date of
 * birth equal to the registration date, or a mistyped year.
 */
export function validateCustomerDateOfBirth(value: unknown): string | null {
  const dob = new Date(value as string);
  if (Number.isNaN(dob.getTime())) {
    return 'Invalid date of birth';
  }

  const age = calculateAge(dob);
  if (age < 0) {
    return 'Date of birth cannot be in the future';
  }
  if (age < MINIMUM_CUSTOMER_AGE_YEARS) {
    return `Customer must be at least ${MINIMUM_CUSTOMER_AGE_YEARS} years old. This date of birth gives an age of ${age}.`;
  }

  return null;
}
