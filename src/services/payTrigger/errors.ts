/**
 * PayTrigger result codes (API doc §4) mapped to text an admin can act on.
 * Only the ones we can do something about get their own wording; the rest fall
 * back to PayTrigger's own message.
 */

const MESSAGES: Record<string, string> = {
  '400': 'PayTrigger rejected the request (missing signature or bad parameters).',
  '510': 'PayTrigger is rate-limiting this device — try again later.',
  '530': 'PayTrigger rejected our signature. Check PAYTRIGGER_API_KEY.',
  '20001': 'PayTrigger does not know this device (IMEI / device tag not found or mismatched).',
  '20003': 'PayTrigger API key is missing or expired.',
  '20004': 'PayTrigger refused this state change for the device.',
  '20005': 'Our PayTrigger account is not permitted to do this — ask Transsion to enable it.',
  '20015': 'This country / model / app version is not enabled on our PayTrigger account.',
  '30011': 'No PayTrigger licences left — buy more before activating further phones.',
  '30021': 'This phone is registered to another PayTrigger merchant.',
  '40000': 'PayTrigger rejected our signature. Check PAYTRIGGER_API_KEY.',
  '40001': 'Our server IP is not on the PayTrigger whitelist.',
  '40003': 'No IP whitelist configured on the PayTrigger portal.',
  '50008': 'PayTrigger 24-hour limit reached for this device — try again tomorrow.',
  '50010': 'PayTrigger says the device is not overdue, so it cannot be temporarily unlocked.',
  '50011': 'Temporary unlock is not enabled on our PayTrigger account — ask Transsion.',
  '50014': 'The anti-theft lock is on for this device, so it cannot be unlocked this way.',
  '50015': 'This IMEI is already enrolled or activated on PayTrigger.',
  '50020': 'IMEI must be 15–18 digits.',
  '50022': 'Expiration is required when the phone is not locked at activation.',
  '50056': 'The phone model does not match what was enrolled.',
  '50063': 'This phone runs an older PayTrigger app — ask the customer for the 4-digit key on their lock screen.',
  '50078': 'This IMEI is on the PayTrigger blacklist.',
  '55106': 'The device has not been activated yet.',
  '71107': 'Offline PIN unlock is not configured on our PayTrigger account.',
};

/** Codes meaning "slow down", for the retry logic. */
const RATE_LIMIT_CODES = new Set(['510', '50008']);

export function describeCode(code: string | number | undefined | null, fallback?: string): string {
  if (code === undefined || code === null) return fallback || 'Unknown PayTrigger error';
  return MESSAGES[String(code)] || fallback || `PayTrigger error ${code}`;
}

export function isRateLimited(code: string | number | undefined | null): boolean {
  return code !== undefined && code !== null && RATE_LIMIT_CODES.has(String(code));
}

/** Errors no retry will fix — retrying only burns the device's daily quota. */
export function isPermanent(code: string | number | undefined | null): boolean {
  if (code === undefined || code === null) return false;
  return ['20001', '20005', '20015', '30021', '50010', '50011', '50014', '50015', '50020', '50078'].includes(String(code));
}
