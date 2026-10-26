import axios from 'axios';
import { formatPhoneForHubtel } from './hubtelService';

/**
 * Checks a phone number against the name it was registered to on the
 * network (Hubtel Verification API, "MSISDN Name Query"), and compares that
 * name with the one staff typed in.
 *
 * Used when a customer or guarantor is registered or their number changes.
 * A number nobody is registered to is refused; a name that does not match
 * is saved and raised to the approver. When Hubtel cannot be reached the
 * customer is still saved, marked as not checked.
 *
 * Hubtel answers only from whitelisted IPs, as with payments.
 */

export type PhoneVerificationStatus = 'MATCHED' | 'PARTIAL' | 'MISMATCH' | 'NOT_REGISTERED' | 'UNAVAILABLE';

export interface PhoneVerificationResult {
  status: PhoneVerificationStatus;
  registeredName: string | null;
  /** Share of the typed name's words found in the registered name, 0–100. */
  score: number | null;
  checkedAt: Date;
  /** Why the check could not run; only for UNAVAILABLE. */
  reason?: string;
}

/** enforce (default): refuse unregistered numbers · warn: save and flag them · off: no checks. */
export function phoneVerificationMode(): 'enforce' | 'warn' | 'off' {
  const mode = String(process.env.PHONE_VERIFICATION_MODE || 'enforce').trim().toLowerCase();
  return mode === 'warn' || mode === 'off' ? mode : 'enforce';
}

// Hubtel's "Collection Account Number" is the same POS sales ID payments use.
const ACCOUNT = process.env.HUBTEL_VERIFICATION_ACCOUNT || process.env.HUBTEL_POS_SALES_ID || '';
const NAME_QUERY_URL =
  process.env.HUBTEL_NAME_QUERY_URL ||
  `https://cs.hubtel.com/commissionservices/${ACCOUNT}/3e0841e70afc42fb97d13d19abd36384`;

// Each query is billed by Hubtel, and the form checks as staff type, so the
// same number is answered from memory for a while.
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; registeredName: string | null; status: 'FOUND' | 'NOT_REGISTERED' }>();

function words(name: string): string[] {
  return name
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Levenshtein distance, small inputs only. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Allows one slip in a longer name (KWAME / KWAMI) and short forms (EMMA / EMMANUEL).
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return Math.min(a.length, b.length) >= 4 && distance(a, b) <= 1;
}

/**
 * MATCHED when two words agree (or every typed word, for a one-word name),
 * PARTIAL when one does, MISMATCH when none. Word order is ignored: SIM
 * names are often surname first.
 */
export function compareNames(typed: string, registered: string): { status: 'MATCHED' | 'PARTIAL' | 'MISMATCH'; score: number } {
  const typedWords = words(typed);
  const registeredWords = words(registered);
  if (typedWords.length === 0 || registeredWords.length === 0) return { status: 'MISMATCH', score: 0 };
  const matched = typedWords.filter((w) => registeredWords.some((r) => sameWord(w, r))).length;
  const score = Math.round((matched / typedWords.length) * 100);
  if (matched >= 2 || matched === typedWords.length) return { status: 'MATCHED', score };
  return { status: matched === 1 ? 'PARTIAL' : 'MISMATCH', score };
}

async function lookUp(phone: string): Promise<{ status: 'FOUND' | 'NOT_REGISTERED'; registeredName: string | null }> {
  const msisdn = formatPhoneForHubtel(phone);
  const hit = cache.get(msisdn);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;

  const credentials = Buffer.from(`${process.env.HUBTEL_API_KEY || ''}:${process.env.HUBTEL_API_SECRET || ''}`).toString('base64');
  const response = await axios.get(NAME_QUERY_URL, {
    params: { destination: msisdn },
    headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' },
    timeout: 15_000,
    // 404 is Hubtel's answer for "no one is registered to this number".
    validateStatus: (s) => s === 200 || s === 404,
  });

  const body: any = response.data || {};
  const code = String(body.ResponseCode ?? body.responseCode ?? '');
  let result: { status: 'FOUND' | 'NOT_REGISTERED'; registeredName: string | null };
  if (response.status === 404 || code === '3000') {
    result = { status: 'NOT_REGISTERED', registeredName: null };
  } else if (code === '0000') {
    const data = Array.isArray(body.Data) ? body.Data : Array.isArray(body.data) ? body.data : [];
    const entry = data.find((d: any) => String(d?.Display || '').toLowerCase() === 'name') || data[0];
    const name = String(entry?.Value || '').trim();
    result = name ? { status: 'FOUND', registeredName: name.toUpperCase() } : { status: 'NOT_REGISTERED', registeredName: null };
  } else {
    throw new Error(`Hubtel answered ${code || response.status}: ${body.Message || body.message || 'unexpected reply'}`);
  }

  cache.set(msisdn, { ...result, at: Date.now() });
  return result;
}

/** Never throws: anything that stops the check comes back as UNAVAILABLE. */
export async function verifyPhoneName(phone: string, typedName: string): Promise<PhoneVerificationResult> {
  const checkedAt = new Date();
  if (!ACCOUNT || !process.env.HUBTEL_API_KEY) {
    return { status: 'UNAVAILABLE', registeredName: null, score: null, checkedAt, reason: 'Hubtel is not configured' };
  }
  try {
    const found = await lookUp(phone);
    if (found.status === 'NOT_REGISTERED') return { status: 'NOT_REGISTERED', registeredName: null, score: null, checkedAt };
    const { status, score } = compareNames(typedName, found.registeredName!);
    return { status, registeredName: found.registeredName, score, checkedAt };
  } catch (error: any) {
    const status = error?.response?.status;
    const reason = status === 403
      ? 'Hubtel refused the request (server IP not whitelisted for verification)'
      : status
        ? `Hubtel answered HTTP ${status}`
        : String(error?.message || 'request failed');
    console.warn('Phone verification unavailable:', reason);
    return { status: 'UNAVAILABLE', registeredName: null, score: null, checkedAt, reason };
  }
}

/** Only for tests. */
export function clearPhoneVerificationCache(): void {
  cache.clear();
}
