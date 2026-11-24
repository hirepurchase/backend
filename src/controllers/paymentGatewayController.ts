import { Request, Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { createAuditLog } from '../services/auditService';
import { getGatewaySettings, saveGatewaySettings, notePaystackEvent, GATEWAYS, Gateway } from '../services/gateways';
import { checkPaystackConnection, isPaystackConfigured, isValidPaystackSignature, paystackKeyMode } from '../services/gateways/paystack';
import { handlePaystackReference, notePaystackRefund } from '../services/gateways/settle';
import { isTestReference, recordTestEvent } from './paystackTestController';

/**
 * The payment gateway switch (super admins) and Paystack's webhook.
 * See services/gateways for how a gateway is chosen.
 */

const WEBHOOK_PATH = '/api/payments/paystack/webhook';

function isSuperAdmin(req: AuthenticatedRequest): boolean {
  return req.userType === 'admin' && (req.user as AdminUserPayload)?.role === 'SUPER_ADMIN';
}

/** The address to paste into the Paystack dashboard: this backend's own. */
function webhookUrl(req: Request): string {
  const callback = process.env.HUBTEL_CALLBACK_URL || '';
  try {
    if (callback) return `${new URL(callback).origin}${WEBHOOK_PATH}`;
  } catch {
    /* fall through */
  }
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.get('host')}${WEBHOOK_PATH}`;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Today's web and app payments by gateway, and how many are still waiting. */
async function todayCounts() {
  const since = startOfToday();
  const [customer, agent] = await Promise.all([
    prisma.paymentTransaction.groupBy({
      by: ['gateway', 'status'],
      _count: { _all: true },
      where: { createdAt: { gte: since }, paymentMethod: { in: ['HUBTEL_MOMO', 'PAYSTACK_MOMO'] } },
    }),
    prisma.agentDepositPayment.groupBy({
      by: ['gateway', 'status'],
      _count: { _all: true },
      where: { createdAt: { gte: since }, channel: 'WEB' },
    }),
  ]);
  const shape = (rows: Array<{ gateway: string; status: string; _count: { _all: number } }>) => {
    const out = { total: 0, waiting: 0, byGateway: { HUBTEL: 0, PAYSTACK: 0 } as Record<string, number> };
    for (const r of rows) {
      out.total += r._count._all;
      out.byGateway[r.gateway] = (out.byGateway[r.gateway] ?? 0) + r._count._all;
      if (r.status === 'PENDING') out.waiting += r._count._all;
    }
    return out;
  };
  return { customer: shape(customer), agentDeposit: shape(agent) };
}

async function describe(req: Request) {
  const settings = await getGatewaySettings();
  const updatedBy = settings.updatedById
    ? await prisma.adminUser.findUnique({ where: { id: settings.updatedById }, select: { firstName: true, lastName: true } })
    : null;
  return {
    customerGateway: settings.customerGateway,
    agentDepositGateway: settings.agentDepositGateway,
    updatedAt: settings.updatedAt,
    updatedBy: updatedBy ? `${updatedBy.firstName} ${updatedBy.lastName}`.trim() : null,
    paystack: {
      configured: isPaystackConfigured(),
      mode: paystackKeyMode(),
      webhookUrl: webhookUrl(req),
      lastEventAt: settings.lastPaystackEventAt,
    },
    today: await todayCounts(),
  };
}

// GET /settings/payment-gateway
export async function getPaymentGatewaySettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  try {
    res.json(await describe(req));
  } catch (error) {
    console.error('Get payment gateway settings error:', error);
    res.status(500).json({ error: 'Failed to load the payment gateway settings' });
  }
}

// PUT /settings/payment-gateway { customerGateway?, agentDepositGateway? }
export async function putPaymentGatewaySettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  try {
    const { customerGateway, agentDepositGateway } = req.body || {};
    const changes: { customerGateway?: Gateway; agentDepositGateway?: Gateway } = {};
    for (const [key, value] of Object.entries({ customerGateway, agentDepositGateway })) {
      if (value === undefined) continue;
      if (!GATEWAYS.includes(value as Gateway)) {
        res.status(400).json({ error: `${key} must be HUBTEL or PAYSTACK` });
        return;
      }
      (changes as any)[key] = value;
    }
    if (Object.keys(changes).length === 0) {
      res.status(400).json({ error: 'Nothing to change.' });
      return;
    }
    if (Object.values(changes).includes('PAYSTACK') && !isPaystackConfigured()) {
      res.status(400).json({ error: 'Paystack is not set up on the server yet: add PAYSTACK_SECRET_KEY first.' });
      return;
    }

    const before = await getGatewaySettings();
    const admin = req.user as AdminUserPayload;
    await saveGatewaySettings(changes, admin.id);
    await createAuditLog({
      userId: admin.id,
      action: 'SET_PAYMENT_GATEWAY',
      entity: 'PaymentGatewaySettings',
      entityId: 'singleton',
      oldValues: { customerGateway: before.customerGateway, agentDepositGateway: before.agentDepositGateway },
      newValues: changes,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
    res.json(await describe(req));
  } catch (error) {
    console.error('Put payment gateway settings error:', error);
    res.status(500).json({ error: 'Failed to save the payment gateway settings' });
  }
}

// POST /settings/payment-gateway/check — one harmless request with the key
export async function checkPaymentGateway(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  res.json(await checkPaystackConnection());
}

// POST /payments/paystack/webhook — no auth middleware; the signature is the check.
export async function handlePaystackWebhook(req: Request & { rawBody?: Buffer }, res: Response): Promise<void> {
  const signature = req.headers['x-paystack-signature'];
  if (!isValidPaystackSignature(req.rawBody, Array.isArray(signature) ? signature[0] : signature)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Answered at once: Paystack retries anything slow, and the work below
  // looks the charge up with Paystack rather than trusting this message.
  res.status(200).json({ received: true });

  const event = String(req.body?.event || '');
  const reference = String(req.body?.data?.reference || '');
  try {
    await notePaystackEvent();
    // Test payments from the test page belong to no contract: record what
    // arrived (the page shows it) and stop there.
    const data = req.body?.data ?? {};
    const testRef = [reference, data.transaction_reference, data.transaction?.reference].find((r) => isTestReference(r));
    if (testRef) {
      await recordTestEvent(String(testRef), event, data);
      return;
    }
    if (event.startsWith('transfer.') && reference) {
      const { handlePaystackTransferEvent } = await import('../services/payouts/commissionPayouts');
      const found = await handlePaystackTransferEvent(reference);
      console.log(`[Paystack] ${event} ${reference} → ${found ? 'commission payout' : 'unknown transfer'}`);
    } else if (event === 'charge.success' && reference) {
      const routed = await handlePaystackReference(reference);
      console.log(`[Paystack] ${event} ${reference} → ${routed}`);
    } else if (event.startsWith('refund.') && event !== 'refund.failed') {
      // A refund names the charge it came from.
      const charged = String(data.transaction_reference || data.transaction?.reference || '');
      const amount = data.amount != null && Number.isFinite(Number(data.amount)) ? Number(data.amount) : null;
      if (charged) await notePaystackRefund(charged, event, amount);
    }
  } catch (error: any) {
    // The sweep picks the payment up within ten minutes.
    console.error(`[Paystack] webhook ${event} ${reference} failed:`, error?.message || error);
  }
}
