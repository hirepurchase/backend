/**
 * Hubtel Send Money (payouts to a Mobile Money wallet from the Hubtel prepaid
 * deposit account).
 *
 * NOT YET CONFIRMED against Hubtel's current documentation, which could not be
 * read when this was written. It stays off unless HUBTEL_PAYOUTS_ENABLED=true,
 * and the endpoint URLs can be set from the environment, so it can be lined up
 * with the docs without a code change. Until then payouts go through Paystack.
 *
 *   HUBTEL_PAYOUTS_ENABLED=true
 *   HUBTEL_PREPAID_DEPOSIT_ID=<Hubtel prepaid deposit account id>
 *   HUBTEL_SEND_MONEY_URL (optional, defaults to the smp.hubtel.com pattern)
 *   HUBTEL_SEND_MONEY_STATUS_URL (optional; {ref} is replaced by our reference)
 *   HUBTEL_PAYOUT_CALLBACK_URL (where Hubtel reports the result)
 */
import axios from 'axios';
import { getHubtelChannel } from '../hubtelService';
import { appendWebhookToken } from '../../utils/callbackSecurity';

const TIMEOUT_MS = 20_000;

function depositId(): string {
  return (process.env.HUBTEL_PREPAID_DEPOSIT_ID || '').trim();
}

export function isHubtelPayoutReady(): boolean {
  return process.env.HUBTEL_PAYOUTS_ENABLED === 'true' && !!depositId() && !!process.env.HUBTEL_API_KEY && !!process.env.HUBTEL_API_SECRET;
}

export function hubtelPayoutBlockReason(): string | null {
  if (process.env.HUBTEL_PAYOUTS_ENABLED !== 'true') return 'Hubtel payouts are not switched on yet (they need confirming against Hubtel’s Send Money documentation).';
  if (!depositId()) return 'No Hubtel prepaid deposit account is set on the server.';
  if (!process.env.HUBTEL_API_KEY || !process.env.HUBTEL_API_SECRET) return 'Hubtel API keys are not set on the server.';
  return null;
}

function auth(): string {
  return `Basic ${Buffer.from(`${process.env.HUBTEL_API_KEY}:${process.env.HUBTEL_API_SECRET}`).toString('base64')}`;
}

function sendUrl(): string {
  return process.env.HUBTEL_SEND_MONEY_URL || `https://smp.hubtel.com/api/merchants/${depositId()}/send/mobilemoney`;
}

function statusUrl(reference: string): string {
  const tpl = process.env.HUBTEL_SEND_MONEY_STATUS_URL || `https://api-txnstatus.hubtel.com/transactions/${depositId()}/status?clientReference={ref}`;
  return tpl.replace('{ref}', encodeURIComponent(reference));
}

function to233(phone: string): string {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('233')) return d;
  if (d.startsWith('0')) return `233${d.slice(1)}`;
  return d;
}

export type HubtelPayoutState = 'PENDING' | 'SUCCESS' | 'FAILED';

function stateOfCode(code: string | undefined, status?: string): HubtelPayoutState {
  const c = String(code || '');
  const s = String(status || '').toLowerCase();
  if (c === '0000' || s === 'success' || s === 'paid') return 'SUCCESS';
  if (c === '0001' || s === 'pending' || !c) return 'PENDING';
  return 'FAILED';
}

export async function hubtelSendMoney(input: { amount: number; phone: string; network: string; name: string; reference: string; description: string }): Promise<{ state: HubtelPayoutState; externalRef: string | null; message: string }> {
  try {
    const res = await axios.post(sendUrl(), {
      RecipientName: input.name.slice(0, 100),
      RecipientMsisdn: to233(input.phone),
      Channel: getHubtelChannel(input.network),
      Amount: Math.round(input.amount * 100) / 100,
      PrimaryCallbackURL: appendWebhookToken(process.env.HUBTEL_PAYOUT_CALLBACK_URL || ''),
      Description: input.description.slice(0, 100),
      ClientReference: input.reference,
    }, { headers: { Authorization: auth(), 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS });
    const body: any = res.data ?? {};
    return {
      state: stateOfCode(body.ResponseCode, body.Data?.Status),
      externalRef: body.Data?.TransactionId ?? null,
      message: String(body.Data?.Description || body.Message || ''),
    };
  } catch (error: any) {
    if (!error?.response) throw error; // no answer: checked by reference later
    const body = error.response.data ?? {};
    return { state: 'FAILED', externalRef: null, message: String(body.Message || body.message || `Hubtel answered HTTP ${error.response.status}`).slice(0, 250) };
  }
}

export async function hubtelPayoutStatus(reference: string): Promise<{ state: HubtelPayoutState | 'NOT_FOUND'; externalRef: string | null; message: string }> {
  try {
    const res = await axios.get(statusUrl(reference), { headers: { Authorization: auth() }, timeout: TIMEOUT_MS });
    const body: any = res.data ?? {};
    const d = body.Data ?? body.data ?? {};
    return { state: stateOfCode(body.ResponseCode, d.Status ?? d.status), externalRef: d.TransactionId ?? null, message: String(d.Description || body.Message || '') };
  } catch (error: any) {
    if (error?.response?.status === 404) return { state: 'NOT_FOUND', externalRef: null, message: 'Not found at Hubtel' };
    throw error;
  }
}

/** Reads a Hubtel payout callback: our reference and the outcome. */
export function parseHubtelPayoutCallback(body: any): { reference: string | null; state: HubtelPayoutState; externalRef: string | null; message: string } {
  const d = body?.Data ?? body?.data ?? {};
  return {
    reference: d.ClientReference ?? body?.ClientReference ?? null,
    state: stateOfCode(body?.ResponseCode, d.Status),
    externalRef: d.TransactionId ?? null,
    message: String(d.Description || body?.Message || ''),
  };
}
