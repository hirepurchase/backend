import prisma from '../../config/database';
import { initiateHubtelReceiveMoney } from '../hubtelService';
import * as paystack from './paystack';

/**
 * Which gateway sends a Mobile Money prompt, and sending it.
 *
 * Only payments started on the web or in the app come through here. The short
 * code belongs to Hubtel and every short-code flow keeps calling Hubtel
 * directly, whatever the switch says.
 *
 * The gateway chosen is stored on the payment row. Every later step (webhook,
 * status check, sweep, reconcile) follows the row, so flipping the switch only
 * affects payments started after it.
 */

export type Gateway = 'HUBTEL' | 'PAYSTACK';
export type GatewaySection = 'CUSTOMER' | 'AGENT_DEPOSIT';
export const GATEWAYS: Gateway[] = ['HUBTEL', 'PAYSTACK'];

export interface GatewaySettings {
  customerGateway: Gateway;
  agentDepositGateway: Gateway;
  lastPaystackEventAt: Date | null;
  updatedById: string | null;
  updatedAt: Date | null;
}

function asGateway(value: unknown): Gateway {
  return value === 'PAYSTACK' ? 'PAYSTACK' : 'HUBTEL';
}

export async function getGatewaySettings(): Promise<GatewaySettings> {
  const row = await prisma.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' } });
  return {
    customerGateway: asGateway(row?.customerGateway),
    agentDepositGateway: asGateway(row?.agentDepositGateway),
    lastPaystackEventAt: row?.lastPaystackEventAt ?? null,
    updatedById: row?.updatedById ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function saveGatewaySettings(
  changes: Partial<Pick<GatewaySettings, 'customerGateway' | 'agentDepositGateway'>>,
  updatedById: string,
): Promise<GatewaySettings> {
  const row = await prisma.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  const data = { ...changes, updatedById };
  if (row) await prisma.paymentGatewaySettings.update({ where: { id: row.id }, data });
  else await prisma.paymentGatewaySettings.create({ data });
  return getGatewaySettings();
}

/** Recorded on every correctly signed webhook, so the settings page can show the hook is set up. */
export async function notePaystackEvent(at: Date = new Date()): Promise<void> {
  const row = await prisma.paymentGatewaySettings.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (row) await prisma.paymentGatewaySettings.update({ where: { id: row.id }, data: { lastPaystackEventAt: at } });
  else await prisma.paymentGatewaySettings.create({ data: { lastPaystackEventAt: at } });
}

/**
 * The gateway for a payment starting now on the web or in the app.
 *
 * Paystack only when the switch says so and the key is set. Telecel payers on
 * Paystack get a code by SMS to type back in, so a client that cannot show
 * that box (an app version installed before Paystack) pays Telecel through
 * Hubtel instead.
 */
export async function gatewayFor(section: GatewaySection, opts: { otpCapable?: boolean; network: string }): Promise<Gateway> {
  const settings = await getGatewaySettings();
  const chosen = section === 'CUSTOMER' ? settings.customerGateway : settings.agentDepositGateway;
  if (chosen !== 'PAYSTACK' || !paystack.isPaystackConfigured()) return 'HUBTEL';
  if (paystack.normaliseNetwork(opts.network) === 'VODAFONE' && !opts.otpCapable) return 'HUBTEL';
  return 'PAYSTACK';
}

/** The payment method recorded on a customer payment for each gateway (web and app). */
export function paymentMethodFor(gateway: Gateway): string {
  return gateway === 'PAYSTACK' ? 'PAYSTACK_MOMO' : 'HUBTEL_MOMO';
}

/**
 * Paystack needs an email for every charge and sends its receipt there. The
 * customer's own when we have one, otherwise an address on our domain, so a
 * receipt never goes to a stranger.
 */
export function payerEmail(email: string | null | undefined, fallbackId: string): string {
  const e = String(email || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return e;
  const tag = String(fallbackId || 'customer').replace(/[^A-Za-z0-9]/g, '').slice(0, 40) || 'customer';
  return `pay+${tag}@aidootechsolutions.com`;
}

export interface StartPromptInput {
  gateway: Gateway;
  reference: string;
  amount: number;
  phone: string;
  network: string;
  payerName: string;
  email: string;
  description: string;
  /** Hubtel only: where Hubtel posts its result (agent deposits have their own). */
  hubtelCallbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface StartPromptResult {
  state: paystack.ChargeState;
  externalRef: string | null;
  message: string;
}

/**
 * Send the Mobile Money prompt through the chosen gateway. A stated refusal
 * returns FAILED; an error that leaves it unclear whether the prompt went out
 * throws, and the payment must be left waiting.
 */
export async function startPrompt(input: StartPromptInput): Promise<StartPromptResult> {
  if (input.gateway === 'PAYSTACK') {
    return paystack.startMobileMoneyCharge({
      reference: input.reference,
      amount: input.amount,
      phone: input.phone,
      network: input.network,
      email: input.email,
      metadata: { ...(input.metadata ?? {}), description: input.description },
    });
  }
  const hubtel = await initiateHubtelReceiveMoney({
    amount: input.amount,
    customerName: input.payerName,
    customerPhone: input.phone,
    customerEmail: input.email.startsWith('pay+') ? undefined : input.email,
    network: input.network,
    description: input.description,
    transactionRef: input.reference,
    callbackUrl: input.hubtelCallbackUrl,
  });
  // Hubtel answered, so the payment waits for its callback or the status
  // check, as it always has: its first answer is never taken as a failure
  // (a payment can still go through after an unexpected response code).
  return {
    state: 'PENDING',
    externalRef: hubtel.transactionId || null,
    message: 'Approve the Mobile Money prompt on your phone.',
  };
}

export { paystack };
