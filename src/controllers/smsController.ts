import { Response } from 'express';
import prisma from '../config/database';
import { sendSMS } from '../services/notificationService';
import { AuthenticatedRequest, AdminUserPayload } from '../types';
import { sanitizePhoneNumber } from '../utils/helpers';
import { resolveCustomerScope, applyCreatorScope, scopeAllows } from '../services/scopeService';

// The send loop is synchronous within the request, with a delay per recipient,
// so a very large blast would hold the connection open for minutes.
const MAX_RECIPIENTS_PER_SEND = 500;

/** Overdue = an active contract carrying at least one overdue installment. */
const OVERDUE_CUSTOMER_FILTER = {
  contracts: { some: { status: 'ACTIVE', installments: { some: { status: 'OVERDUE' } } } },
};

// Send custom SMS to selected customers or all customers
export async function sendCustomSMS(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { message, customerIds, sendToAll } = req.body;

    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (!sendToAll && (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0)) {
      res.status(400).json({ error: 'Select at least one customer or choose Send to All' });
      return;
    }

    // Scope applies to both branches: "send to all" means all customers the
    // sender is allowed to see, and explicit ids are filtered the same way so
    // an id outside the sender's portfolio can never be messaged.
    const scope = await resolveCustomerScope(admin);
    const where: Record<string, unknown> = {};
    applyCreatorScope(where, scope);

    if (!sendToAll) {
      where.id = { in: customerIds.map((value: unknown) => String(value)) };
    }

    const customers = await prisma.customer.findMany({
      where,
      select: { id: true, firstName: true, lastName: true, phone: true, membershipId: true, createdById: true },
    });

    // Explicit selections must all be reachable; silently dropping one would
    // leave the sender believing a customer was messaged when they were not.
    if (!sendToAll && customers.length !== new Set(customerIds.map(String)).size) {
      res.status(403).json({
        error: 'One or more selected customers are outside your assigned portfolio',
      });
      return;
    }

    if (customers.length === 0) {
      res.status(400).json({ error: 'No customers to send to' });
      return;
    }

    if (customers.length > MAX_RECIPIENTS_PER_SEND) {
      res.status(400).json({
        error: `Too many recipients (${customers.length}). Send to at most ${MAX_RECIPIENTS_PER_SEND} at a time.`,
      });
      return;
    }

    // Defence in depth — the where clause already scoped this.
    const unreachable = customers.find((customer) => !scopeAllows(scope, customer.createdById));
    if (unreachable) {
      res.status(403).json({ error: 'One or more customers are outside your assigned portfolio' });
      return;
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const customer of customers) {
      try {
        const phone = sanitizePhoneNumber(customer.phone);
        const success = await sendSMS({ to: phone, message: message.trim() });
        if (success) {
          sent++;
        } else {
          failed++;
          errors.push(`${customer.firstName} ${customer.lastName} (${customer.membershipId})`);
        }
      } catch {
        failed++;
        errors.push(`${customer.firstName} ${customer.lastName} (${customer.membershipId})`);
      }

      // Small delay to avoid overwhelming SMS API
      if (customers.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    res.json({
      message: `SMS sent to ${sent} customer${sent !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}`,
      sent,
      failed,
      total: customers.length,
      ...(errors.length > 0 && { failedCustomers: errors }),
    });
  } catch (error: any) {
    console.error('Send custom SMS error:', error);
    res.status(500).json({ error: 'Failed to send SMS', detail: error?.message || String(error) });
  }
}

// Get customers list for SMS selection (lightweight)
export async function getSMSCustomers(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const admin = req.user as AdminUserPayload;
    const { search, agentId, overdueOnly } = req.query;

    const scope = await resolveCustomerScope(admin);

    // Base scope first, so the agent filter below can only ever narrow it.
    const where: Record<string, unknown> = {};
    applyCreatorScope(where, scope);

    if (agentId) {
      if (!scopeAllows(scope, agentId as string)) {
        res.status(403).json({ error: 'That agent is outside your assigned portfolio' });
        return;
      }
      where.createdById = agentId as string;
    }

    if (String(overdueOnly).toLowerCase() === 'true') {
      Object.assign(where, OVERDUE_CUSTOMER_FILTER);
    }

    if (search) {
      where.OR = [
        { firstName: { contains: search as string, mode: 'insensitive' as const } },
        { lastName: { contains: search as string, mode: 'insensitive' as const } },
        { membershipId: { contains: search as string, mode: 'insensitive' as const } },
        { phone: { contains: search as string, mode: 'insensitive' as const } },
      ];
    }

    // totalAll is the sender's whole reachable audience, so the "send to all"
    // count in the UI matches what a send would actually target.
    const scopeOnlyWhere: Record<string, unknown> = {};
    applyCreatorScope(scopeOnlyWhere, scope);

    const [customers, totalAll] = await Promise.all([
      prisma.customer.findMany({
        where,
        select: { id: true, firstName: true, lastName: true, phone: true, membershipId: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        take: 1000,
      }),
      prisma.customer.count({ where: scopeOnlyWhere }),
    ]);

    res.json({ customers, total: customers.length, totalAll });
  } catch (error) {
    console.error('Get SMS customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
}
