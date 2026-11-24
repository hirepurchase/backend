import { Response } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { validateWebhookRequest } from '../utils/callbackSecurity';
import { parseHubtelPayoutCallback } from '../services/payouts/hubtelSendMoney';
import {
  PayoutError,
  getPayoutGateway,
  gatewayBlock,
  handleHubtelPayoutCallback,
  listPayable,
  sendPayouts,
  setPayoutGateway,
} from '../services/payouts/commissionPayouts';
import { isPaystackConfigured } from '../services/gateways/paystack';
import { hubtelPayoutBlockReason } from '../services/payouts/hubtelSendMoney';

const me = (req: AuthenticatedRequest) => req.user as AdminUserPayload;

function fail(res: Response, error: unknown) {
  if (error instanceof PayoutError) return res.status(error.status).json({ error: error.message });
  console.error('Commission payout error:', error);
  return res.status(500).json({ error: 'Something went wrong' });
}

// GET /commission-payouts/:kind/:month
export async function getPayable(req: AuthenticatedRequest, res: Response) {
  try {
    if (!/^\d{4}-\d{2}$/.test(req.params.month)) throw new PayoutError('Month must be YYYY-MM');
    res.json(await listPayable(req.params.kind, req.params.month));
  } catch (e) { fail(res, e); }
}

// POST /commission-payouts/:kind/:month/send { items: [{ payoutId, confirmMismatch }], password }
export async function postSend(req: AuthenticatedRequest, res: Response) {
  try {
    const admin = me(req);
    const password = String(req.body?.password || '');
    if (!password) throw new PayoutError('Enter your password to confirm.');
    const user = await prisma.adminUser.findUnique({ where: { id: admin.id }, select: { password: true } });
    if (!user || !(await bcrypt.compare(password, user.password))) throw new PayoutError('Password is incorrect.', 400);
    const items = Array.isArray(req.body?.items) ? req.body.items.map((i: any) => ({ payoutId: String(i?.payoutId || ''), confirmMismatch: Boolean(i?.confirmMismatch) })) : [];
    res.json(await sendPayouts({ kind: req.params.kind, month: req.params.month, items, adminId: admin.id }));
  } catch (e) { fail(res, e); }
}

// GET /commission-payouts/settings
export async function getPayoutSettings(_req: AuthenticatedRequest, res: Response) {
  try {
    const gateway = await getPayoutGateway();
    res.json({
      gateway,
      gatewayBlock: gatewayBlock(gateway),
      paystack: { configured: isPaystackConfigured() },
      hubtel: { ready: !hubtelPayoutBlockReason(), reason: hubtelPayoutBlockReason() },
    });
  } catch (e) { fail(res, e); }
}

// PUT /commission-payouts/settings { gateway }
export async function putPayoutSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const g = String(req.body?.gateway || '').toUpperCase();
    if (g !== 'PAYSTACK' && g !== 'HUBTEL') throw new PayoutError('Gateway must be PAYSTACK or HUBTEL');
    await setPayoutGateway(g, me(req).id);
    return getPayoutSettings(req, res);
  } catch (e) { fail(res, e); }
}

// POST /commission-payouts/hubtel/callback — no login; the outcome is re-checked with Hubtel.
export async function hubtelPayoutCallback(req: AuthenticatedRequest, res: Response) {
  try {
    const webhookError = validateWebhookRequest(req as any);
    if (webhookError) {
      res.status(401).json({ error: webhookError });
      return;
    }
    res.status(200).json({ received: true });
    const { reference } = parseHubtelPayoutCallback(req.body);
    if (reference) await handleHubtelPayoutCallback(reference);
  } catch (e) {
    console.error('Hubtel payout callback error:', e);
  }
}
