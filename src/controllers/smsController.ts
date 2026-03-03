import { Response } from 'express';
import prisma from '../config/database';
import { sendSMS } from '../services/notificationService';
import { AuthenticatedRequest } from '../types';
import { sanitizePhoneNumber } from '../utils/helpers';

// Send custom SMS to selected customers or all customers
export async function sendCustomSMS(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { message, customerIds, sendToAll } = req.body;

    if (!message || !message.trim()) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    if (!sendToAll && (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0)) {
      res.status(400).json({ error: 'Select at least one customer or choose Send to All' });
      return;
    }

    // Fetch target customers
    const customers = await prisma.customer.findMany({
      where: sendToAll ? {} : { id: { in: customerIds } },
      select: { id: true, firstName: true, lastName: true, phone: true, membershipId: true },
    });

    if (customers.length === 0) {
      res.status(400).json({ error: 'No active customers found' });
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
    const { search } = req.query;

    const searchWhere = search
      ? {
          OR: [
            { firstName: { contains: search as string, mode: 'insensitive' as const } },
            { lastName: { contains: search as string, mode: 'insensitive' as const } },
            { membershipId: { contains: search as string, mode: 'insensitive' as const } },
            { phone: { contains: search as string, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [customers, totalAll] = await Promise.all([
      prisma.customer.findMany({
        where: searchWhere,
        select: { id: true, firstName: true, lastName: true, phone: true, membershipId: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.customer.count(),
    ]);

    res.json({ customers, total: customers.length, totalAll });
  } catch (error) {
    console.error('Get SMS customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
}
