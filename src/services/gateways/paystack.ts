import axios from 'axios';

/** The parts of an axios error we read (this axios version exports no type for it). */
type AxiosError<T> = { response?: { status?: number; data?: T }; message?: string };
import crypto from 'crypto';

/**
 * Paystack, for Mobile Money prompts started on the web or in the app.
 *
 * Server to server through the Charge API: we send the prompt, the customer
 * approves it on their phone, and Paystack tells us by webhook. Telecel
 * (formerly Vodafone) sends the payer a code by SMS first, which they type
 * back in (submitOtp). Nothing here touches the database; callers decide what
 * an answer means for their own rows.
 *
 * The secret key is read on every call, so setting it needs only a restart,
 * and it is never logged or returned.
 */

const DEFAULT_BASE_URL = 'https://api.paystack.co';
const TIMEOUT_MS = 20_000;

function secretKey(): string {
  return (process.env.PAYSTACK_SECRET_KEY || '').trim();
}

function baseUrl(): string {
  return (process.env.PAYSTACK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function isPaystackConfigured(): boolean {
  return secretKey().length > 0;
}

/** TEST or LIVE from the key's prefix; null when there is no key. Never the key. */
export function paystackKeyMode(): 'TEST' | 'LIVE' | 'UNKNOWN' | null {
  const key = secretKey();
  if (!key) return null;
  if (key.startsWith('sk_test_')) return 'TEST';
  if (key.startsWith('sk_live_')) return 'LIVE';
  return 'UNKNOWN';
}

function client() {
  return axios.create({
    baseURL: baseUrl(),
    timeout: TIMEOUT_MS,
    headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
  });
}

/** Paystack's own words for a refusal, without anything from our request. */
function describeError(error: unknown): string {
  const e = error as AxiosError<any>;
  const data = e?.response?.data;
  return String(data?.data?.message || data?.message || e?.message || 'Paystack request failed').slice(0, 250);
}

// ── Money and phone ─────────────────────────────────────────────────────────

/** GHS to pesewas, the unit Paystack counts in. */
export function toPesewas(amount: number): number {
  return Math.round(Number(amount) * 100);
}

/** 0XXXXXXXXX, the local form Paystack takes for Ghana Mobile Money. */
export function toLocalGhanaPhone(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

// ── Network codes ───────────────────────────────────────────────────────────
//
// Read from Paystack's own list rather than written in here, so a rename on
// their side (Vodafone to Telecel) does not break payments. The fallbacks are
// only for when the list cannot be fetched.

const FALLBACK_PROVIDERS: Record<string, string> = { MTN: 'mtn', VODAFONE: 'vod', AIRTELTIGO: 'atl' };
const PROVIDER_CACHE_MS = 24 * 3600_000;
let providerCache: { at: number; codes: Record<string, string> } | null = null;

/** Our network name (MTN, VODAFONE, TELECEL, AIRTELTIGO) as one of ours. */
export function normaliseNetwork(network: string): 'MTN' | 'VODAFONE' | 'AIRTELTIGO' | null {
  const n = String(network || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (n === 'MTN') return 'MTN';
  if (n === 'VODAFONE' || n === 'TELECEL' || n === 'VOD') return 'VODAFONE';
  if (n === 'AIRTELTIGO' || n === 'AT' || n === 'ATL' || n === 'TIGO' || n === 'AIRTEL') return 'AIRTELTIGO';
  return null;
}

function classifyProvider(entry: { name?: string; code?: string }): 'MTN' | 'VODAFONE' | 'AIRTELTIGO' | null {
  const text = `${entry.name ?? ''} ${entry.code ?? ''}`.toUpperCase();
  if (/\bMTN\b/.test(text)) return 'MTN';
  if (/VODAFONE|TELECEL|\bVOD\b/.test(text)) return 'VODAFONE';
  if (/AIRTEL|TIGO|\bATL\b|\bAT\b/.test(text)) return 'AIRTELTIGO';
  return null;
}

export async function mobileMoneyProviders(force = false): Promise<Record<string, string>> {
  if (!force && providerCache && Date.now() - providerCache.at < PROVIDER_CACHE_MS) return providerCache.codes;
  const res: any = await client().get('/bank', { params: { currency: 'GHS', type: 'mobile_money' } });
  const codes: Record<string, string> = {};
  for (const entry of (res.data?.data ?? []) as Array<{ name?: string; code?: string }>) {
    const ours = classifyProvider(entry);
    if (ours && entry.code && !codes[ours]) codes[ours] = entry.code;
  }
  if (Object.keys(codes).length === 0) throw new Error('Paystack returned no Mobile Money providers for GHS');
  providerCache = { at: Date.now(), codes };
  return codes;
}

async function providerCodeFor(network: string): Promise<string> {
  const ours = normaliseNetwork(network);
  if (!ours) throw new Error(`Unsupported network: ${network}`);
  try {
    const codes = await mobileMoneyProviders();
    // The charge takes the code in lower case (mtn, vod, atl), whatever
    // case Paystack's list writes it in.
    if (codes[ours]) return codes[ours].toLowerCase();
  } catch (error) {
    console.warn('[Paystack] provider list unavailable, using the usual codes:', describeError(error));
  }
  return FALLBACK_PROVIDERS[ours];
}

/** For the settings page: one harmless call that proves the key works. */
export async function checkPaystackConnection(): Promise<{ ok: boolean; message: string; providers?: string[]; codes?: Record<string, string> }> {
  if (!isPaystackConfigured()) return { ok: false, message: 'No Paystack secret key is set on the server.' };
  try {
    const codes = await mobileMoneyProviders(true);
    return { ok: true, message: 'Paystack accepted the key.', providers: Object.keys(codes), codes };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

// ── Charges ─────────────────────────────────────────────────────────────────

export type ChargeState = 'PENDING' | 'OTP_REQUIRED' | 'SUCCESS' | 'FAILED';

export interface ChargeStart {
  state: ChargeState;
  /** Paystack's transaction id, when it gave one. */
  externalRef: string | null;
  /** What to tell the payer: Paystack's display text, or our own words. */
  message: string;
}

/** Paystack's charge statuses, as our four. Anything unrecognised is still waiting. */
export function chargeStateOf(status: string): ChargeState {
  switch (String(status || '').toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'failed':
    case 'timeout':
      return 'FAILED';
    case 'send_otp':
      return 'OTP_REQUIRED';
    default:
      // pay_offline (prompt on the phone), pending, ongoing, processing
      return 'PENDING';
  }
}

const STATE_MESSAGES: Record<ChargeState, string> = {
  PENDING: 'Approve the Mobile Money prompt on your phone.',
  OTP_REQUIRED: 'Enter the code sent to your phone by SMS to continue.',
  SUCCESS: 'Payment received.',
  FAILED: 'The payment did not go through.',
};

function startFrom(data: any): ChargeStart {
  const state = chargeStateOf(data?.status);
  const text = String(data?.display_text || '').trim();
  return {
    state,
    externalRef: data?.id != null ? String(data.id) : null,
    message: state === 'FAILED' ? String(data?.gateway_response || data?.message || STATE_MESSAGES.FAILED) : text || STATE_MESSAGES[state],
  };
}

export interface StartChargeInput {
  reference: string;
  amount: number;
  phone: string;
  network: string;
  email: string;
  metadata?: Record<string, unknown>;
}

/**
 * Send a Mobile Money prompt. A refusal Paystack states (a bad number, an
 * unsupported network) comes back as FAILED; a request that may or may not
 * have reached Paystack throws, and the caller must leave the payment waiting
 * for the webhook or the status check to settle.
 */
export async function startMobileMoneyCharge(input: StartChargeInput): Promise<ChargeStart> {
  if (!isPaystackConfigured()) throw new Error('Paystack is not configured');
  const provider = await providerCodeFor(input.network);
  try {
    const res: any = await client().post('/charge', {
      email: input.email,
      amount: toPesewas(input.amount),
      currency: 'GHS',
      reference: input.reference,
      mobile_money: { phone: toLocalGhanaPhone(input.phone), provider },
      metadata: input.metadata ?? {},
    });
    return startFrom(res.data?.data);
  } catch (error) {
    const e = error as AxiosError<any>;
    const status = e.response?.status;
    // A 4xx with a body is Paystack refusing the charge: nothing was sent to the phone.
    if (status && status >= 400 && status < 500 && e.response?.data) {
      return { state: 'FAILED', externalRef: null, message: describeError(error) };
    }
    throw new Error(describeError(error));
  }
}

/** Telecel: pass on the code the payer received by SMS. */
export async function submitOtp(reference: string, otp: string): Promise<ChargeStart> {
  try {
    const res: any = await client().post('/charge/submit_otp', { reference, otp: String(otp).trim() });
    return startFrom(res.data?.data);
  } catch (error) {
    const e = error as AxiosError<any>;
    const status = e.response?.status;
    if (status && status >= 400 && status < 500 && e.response?.data) {
      // A wrong code: the charge may still be open for another try.
      const data = e.response.data?.data;
      const state = data?.status ? chargeStateOf(data.status) : 'OTP_REQUIRED';
      return { state, externalRef: null, message: describeError(error) };
    }
    throw new Error(describeError(error));
  }
}

// ── What happened to a charge ───────────────────────────────────────────────

export interface ChargeCheck {
  outcome: 'SUCCESS' | 'FAILED' | 'PENDING';
  /** Paystack's status word, for records. */
  status: string;
  amountMinor: number | null;
  currency: string | null;
  externalRef: string | null;
  message: string;
  /** Paid, but not the amount or currency we asked for: never credited. */
  mismatch?: boolean;
  /** Paystack's fee on this charge in GHS, when it says (the merchant's cost unless passed to the payer). */
  feeGhs?: number | null;
}

/** How long a charge Paystack calls "abandoned" is treated as still waiting. */
const ABANDONED_GRACE_MS = 30 * 60_000;

/**
 * Ask Paystack what happened, and check it against what we asked for. Only a
 * success for exactly `expectedAmount` GHS counts; anything else paid is
 * reported as a mismatch for staff to look at.
 *
 * When the account passes Paystack's fee on to the payer, `amount` is what we
 * asked for plus that fee and `requested_amount` is what we asked for. The
 * charge counts when what we asked for matches and nothing less was taken.
 */
export async function checkCharge(reference: string, expectedAmount: number, startedAt?: Date): Promise<ChargeCheck> {
  let data: any;
  try {
    const res: any = await client().get(`/transaction/verify/${encodeURIComponent(reference)}`);
    data = res.data?.data;
  } catch (error) {
    const e = error as AxiosError<any>;
    // Not known yet: a prompt nobody has acted on.
    if (e.response?.status === 404 || e.response?.status === 400) {
      return { outcome: 'PENDING', status: 'not_found', amountMinor: null, currency: null, externalRef: null, message: describeError(error) };
    }
    throw new Error(describeError(error));
  }

  const status = String(data?.status || '').toLowerCase();
  const amountMinor = data?.amount != null ? Number(data.amount) : null;
  const requestedMinor = data?.requested_amount != null ? Number(data.requested_amount) : amountMinor;
  const currency = data?.currency ? String(data.currency).toUpperCase() : null;
  const externalRef = data?.id != null ? String(data.id) : null;
  const message = String(data?.gateway_response || data?.message || status);
  const feeGhs = data?.fees != null && Number.isFinite(Number(data.fees)) ? Math.round(Number(data.fees)) / 100 : null;
  const base = { status, amountMinor, currency, externalRef, message, feeGhs };

  if (status === 'success') {
    const expected = toPesewas(expectedAmount);
    const asked = requestedMinor === expected;
    const taken = amountMinor !== null && amountMinor >= expected;
    if (!asked || !taken || currency !== 'GHS') {
      return { ...base, outcome: 'FAILED', mismatch: true };
    }
    return { ...base, outcome: 'SUCCESS' };
  }
  if (status === 'failed' || status === 'reversed') return { ...base, outcome: 'FAILED' };
  if (status === 'abandoned') {
    const old = startedAt && Date.now() - startedAt.getTime() > ABANDONED_GRACE_MS;
    return { ...base, outcome: old ? 'FAILED' : 'PENDING' };
  }
  return { ...base, outcome: 'PENDING' };
}

// ── Webhook ─────────────────────────────────────────────────────────────────

/** Paystack signs the raw body with HMAC-SHA512 under the secret key. */
export function isValidPaystackSignature(rawBody: Buffer | string | undefined, signature: string | undefined): boolean {
  const key = secretKey();
  if (!key || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature).trim().toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── For the test page only ──────────────────────────────────────────────────

/** What Paystack holds for a reference, as plain fields (no payer details). Null when it has nothing yet. */
export async function lookupCharge(reference: string): Promise<Record<string, unknown> | null> {
  try {
    const res: any = await client().get(`/transaction/verify/${encodeURIComponent(reference)}`);
    const d = res.data?.data ?? {};
    return {
      status: d.status ?? null,
      amount: d.amount ?? null,
      requested_amount: d.requested_amount ?? null,
      fees: d.fees ?? null,
      currency: d.currency ?? null,
      channel: d.channel ?? null,
      gateway_response: d.gateway_response ?? null,
      paid_at: d.paid_at ?? d.paidAt ?? null,
      id: d.id ?? null,
    };
  } catch (error) {
    const e = error as AxiosError<any>;
    if (e.response?.status === 404 || e.response?.status === 400) return null;
    throw new Error(describeError(error));
  }
}

/** Give a charge's money back (the whole charge). Paystack confirms by webhook later. */
export async function refundCharge(reference: string, note: string): Promise<{ ok: boolean; status: string | null; message: string }> {
  try {
    const res: any = await client().post('/refund', { transaction: reference, merchant_note: note.slice(0, 200) });
    return { ok: true, status: res.data?.data?.status ?? null, message: String(res.data?.message || 'Refund requested') };
  } catch (error) {
    return { ok: false, status: null, message: describeError(error) };
  }
}

// ── Transfers (commission payouts) ──────────────────────────────────────────
//
// Paystack pays out from the business balance to a "transfer recipient". For
// Ghana Mobile Money the recipient is type mobile_money with the network's
// bank code from the same list the charges use (kept in the case Paystack
// writes it). Transfers are idempotent on our reference.

const FALLBACK_RECIPIENT_CODES: Record<string, string> = { MTN: 'MTN', VODAFONE: 'VOD', AIRTELTIGO: 'ATL' };

async function recipientBankCode(network: string): Promise<string> {
  const ours = normaliseNetwork(network);
  if (!ours) throw new Error(`Unsupported network: ${network}`);
  try {
    const codes = await mobileMoneyProviders();
    if (codes[ours]) return codes[ours];
  } catch (error) {
    console.warn('[Paystack] provider list unavailable, using the usual recipient codes:', describeError(error));
  }
  return FALLBACK_RECIPIENT_CODES[ours];
}

/** Creates (or Paystack returns the existing) recipient for a wallet. */
export async function createMobileMoneyRecipient(input: { name: string; phone: string; network: string; description?: string }): Promise<string> {
  try {
    const res: any = await client().post('/transferrecipient', {
      type: 'mobile_money',
      name: input.name.slice(0, 100),
      account_number: toLocalGhanaPhone(input.phone),
      bank_code: await recipientBankCode(input.network),
      currency: 'GHS',
      description: input.description,
    });
    const code = res.data?.data?.recipient_code;
    if (!code) throw new Error('Paystack did not return a recipient code');
    return String(code);
  } catch (error) {
    throw new Error(`Could not set up the recipient: ${describeError(error)}`);
  }
}

export type TransferState = 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVERSED' | 'OTP';

export function transferStateOf(status: string | undefined): TransferState {
  const s = String(status || '').toLowerCase();
  if (s === 'success') return 'SUCCESS';
  if (s === 'reversed') return 'REVERSED';
  if (s === 'otp') return 'OTP';
  if (['failed', 'abandoned', 'blocked', 'rejected'].includes(s)) return 'FAILED';
  return 'PENDING';
}

export async function initiateTransfer(input: { amount: number; recipientCode: string; reference: string; reason: string }): Promise<{ state: TransferState; transferCode: string | null; message: string }> {
  try {
    const res: any = await client().post('/transfer', {
      source: 'balance',
      amount: toPesewas(input.amount),
      currency: 'GHS',
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason.slice(0, 100),
    });
    const data = res.data?.data ?? {};
    return { state: transferStateOf(data.status), transferCode: data.transfer_code ?? null, message: String(res.data?.message || '') };
  } catch (error) {
    const status = (error as AxiosError<any>)?.response?.status;
    // A response that never arrived is not a refusal: the caller checks by reference.
    if (!status) throw error;
    return { state: 'FAILED', transferCode: null, message: describeError(error) };
  }
}

/** Where a transfer stands, by our reference. NOT_FOUND means Paystack never received it. */
export async function verifyTransfer(reference: string): Promise<{ state: TransferState | 'NOT_FOUND'; transferCode: string | null; amountMinor: number | null; message: string }> {
  try {
    const res: any = await client().get(`/transfer/verify/${encodeURIComponent(reference)}`);
    const data = res.data?.data ?? {};
    return {
      state: transferStateOf(data.status),
      transferCode: data.transfer_code ?? null,
      amountMinor: typeof data.amount === 'number' ? data.amount : null,
      message: String(data.reason || data.gateway_response || res.data?.message || ''),
    };
  } catch (error) {
    if ((error as AxiosError<any>)?.response?.status === 404) return { state: 'NOT_FOUND', transferCode: null, amountMinor: null, message: describeError(error) };
    throw error;
  }
}

/** The GHS balance available to pay out from, or null if it cannot be read. */
export async function getGhsBalance(): Promise<number | null> {
  try {
    const res: any = await client().get('/balance');
    const row = (res.data?.data ?? []).find((b: any) => String(b.currency).toUpperCase() === 'GHS');
    return row && typeof row.balance === 'number' ? row.balance / 100 : null;
  } catch (error) {
    console.warn('[Paystack] balance unavailable:', describeError(error));
    return null;
  }
}
