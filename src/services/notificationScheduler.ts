import { sendCombinedOverdueNotification, sendDueTodayNotification } from './notificationService';
import prisma from '../config/database';
import cron from 'node-cron';
import { enqueueSingletonJob } from './backgroundJobService';
import { isOverdue, calculatePenalty } from '../utils/helpers';

// Mark past-due installments as OVERDUE and apply penalties
export async function markOverdueInstallments(): Promise<{ updated: number; penalties: number }> {
  try {
    console.log('Marking overdue installments...');

    const activeContracts = await prisma.hirePurchaseContract.findMany({
      where: { status: 'ACTIVE' },
      include: {
        installments: {
          where: { status: { in: ['PENDING', 'PARTIAL'] } },
        },
      },
    });

    let updated = 0;
    let penalties = 0;

    for (const contract of activeContracts) {
      for (const installment of contract.installments) {
        if (isOverdue(installment.dueDate, contract.gracePeriodDays)) {
          await prisma.installmentSchedule.update({
            where: { id: installment.id },
            data: { status: 'OVERDUE' },
          });
          updated++;

          if (contract.penaltyPercentage > 0) {
            const remaining = installment.amount - installment.paidAmount;
            const penaltyAmount = calculatePenalty(remaining, contract.penaltyPercentage);

            // Only create penalty if one doesn't already exist for this installment
            const existing = await prisma.penalty.findFirst({
              where: { contractId: contract.id, isPaid: false },
            });
            if (!existing) {
              await prisma.penalty.create({
                data: {
                  contractId: contract.id,
                  amount: penaltyAmount,
                  reason: `Late payment penalty for installment #${installment.installmentNo}`,
                },
              });
              await prisma.hirePurchaseContract.update({
                where: { id: contract.id },
                data: { outstandingBalance: { increment: penaltyAmount } },
              });
              penalties++;
            }
          }
        }
      }
    }

    console.log(`Marked ${updated} installments as OVERDUE, applied ${penalties} penalties`);
    return { updated, penalties };
  } catch (error) {
    console.error('Error marking overdue installments:', error);
    return { updated: 0, penalties: 0 };
  }
}

// Check for upcoming payments and send reminders
export async function checkUpcomingPayments(): Promise<void> {
  try {
    console.log('Checking for due-today payments...');

    const settings = await prisma.notificationSettings.findFirst();
    if (!settings || !settings.sendSMS) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endOfToday = new Date(today);
    endOfToday.setHours(23, 59, 59, 999);

    // Only notify customers whose installment is due TODAY
    const installments = await prisma.installmentSchedule.findMany({
      where: {
        status: 'PENDING',
        dueDate: { gte: today, lte: endOfToday },
      },
      include: { contract: { include: { customer: true, inventoryItem: { include: { product: true } } } } },
    });

    console.log(`Found ${installments.length} installments due today`);

    for (const installment of installments) {
      const customer = installment.contract.customer;

      // Skip if already notified today
      const alreadySent = await prisma.notificationLog.findFirst({
        where: {
          customerId_uuid: customer.id_uuid!,
          installmentId: installment.id,
          type: 'SMS',
          createdAt: { gte: today },
        },
      });
      if (alreadySent) continue;

      const itemName = installment.contract.inventoryItem?.product?.name || installment.contract.contractNumber;

      await sendDueTodayNotification({
        customerFirstName: customer.firstName,
        customerPhone: customer.phone,
        itemName,
        amount: installment.amount - installment.paidAmount,
      });

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('Finished due-today notifications');
  } catch (error) {
    console.error('Error checking upcoming payments:', error);
  }
}

// Check for overdue payments — one combined SMS per customer
export async function checkOverduePayments(): Promise<void> {
  try {
    console.log('Checking for overdue payments...');

    const settings = await prisma.notificationSettings.findFirst();
    if (!settings || !settings.enableOverdueReminders || !settings.sendSMS) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const overdueInstallments = await prisma.installmentSchedule.findMany({
      where: {
        status: { in: ['OVERDUE', 'PARTIAL'] },
        dueDate: { lt: today },
      },
      include: { contract: { include: { customer: true, inventoryItem: { include: { product: true } } } } },
    });

    console.log(`Found ${overdueInstallments.length} overdue installments`);

    // Group by customer UUID so we send one SMS per customer
    const byCustomer = new Map<string, typeof overdueInstallments>();
    for (const inst of overdueInstallments) {
      const uid = inst.contract.customer.id_uuid!;
      if (!byCustomer.has(uid)) byCustomer.set(uid, []);
      byCustomer.get(uid)!.push(inst);
    }

    for (const [customerId, installments] of byCustomer) {
      const customer = installments[0].contract.customer;

      // Check frequency — one SMS per customer per day/week
      const lastReminder = await prisma.notificationLog.findFirst({
        where: {
          customerId_uuid: customerId,
          type: 'SMS',
          message: { contains: 'overdue' },
        },
        orderBy: { createdAt: 'desc' },
      });

      if (lastReminder) {
        const daysSince = Math.floor((today.getTime() - new Date(lastReminder.createdAt).getTime()) / 86400000);
        if (settings.overdueReminderFrequency === 'DAILY' && daysSince < 1) continue;
        if (settings.overdueReminderFrequency === 'WEEKLY' && daysSince < 7) continue;
      }

      // Aggregate totals across all overdue installments
      const totalOwed = installments.reduce((sum, i) => sum + (i.amount - i.paidAmount), 0);
      const mostDaysOverdue = Math.max(
        ...installments.map(i => Math.floor((today.getTime() - i.dueDate.getTime()) / 86400000))
      );

      // Get unpaid penalty for the contract (one per contract)
      const contractId = installments[0].contract.id;
      const penalty = await prisma.penalty.findFirst({
        where: { contractId, isPaid: false },
      });

      console.log(`Sending combined overdue SMS to ${customer.firstName} ${customer.lastName} (${installments.length} installments)`);

      const itemName = installments[0].contract.inventoryItem?.product?.name || installments[0].contract.contractNumber;

      await sendCombinedOverdueNotification({
        customerFirstName: customer.firstName,
        customerPhone: customer.phone,
        itemName,
        overdueCount: installments.length,
        totalOwed,
        mostDaysOverdue,
        penaltyAmount: penalty?.amount,
      });

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('Finished checking overdue payments');
  } catch (error) {
    console.error('Error checking overdue payments:', error);
  }
}

// Initialize notification scheduler
export function initializeNotificationScheduler(): void {
  console.log('Initializing notification scheduler...');

  // Mark overdue installments every day at 8:00 AM (before notification jobs)
  cron.schedule('0 8 * * *', () => {
    const enqueued = enqueueSingletonJob('mark-overdue-installments', async () => {
      console.log('Running scheduled overdue installment marking');
      await markOverdueInstallments();
    });
    if (!enqueued) {
      console.log('Skipping overdue marking - previous job still running');
    }
  });

  // Run upcoming payment check every day at 9:00 AM
  cron.schedule('0 9 * * *', () => {
    const enqueued = enqueueSingletonJob('notifications-upcoming', async () => {
      console.log('Running scheduled upcoming payment check');
      await checkUpcomingPayments();
    });
    if (!enqueued) {
      console.log('Skipping upcoming payment check - previous job still running');
    }
  });

  // Run overdue payment check every day at 10:00 AM
  cron.schedule('0 10 * * *', () => {
    const enqueued = enqueueSingletonJob('notifications-overdue', async () => {
      console.log('Running scheduled overdue payment check');
      await checkOverduePayments();
    });
    if (!enqueued) {
      console.log('Skipping overdue payment check - previous job still running');
    }
  });

  console.log('Notification scheduler initialized');
  console.log('- Overdue installment marking: Daily at 8:00 AM');
  console.log('- Upcoming payments check: Daily at 9:00 AM');
  console.log('- Overdue payments check: Daily at 10:00 AM');
}

// Manually trigger checks (for testing or admin action)
export async function triggerManualCheck(): Promise<{ upcomingCount: number; overdueCount: number; markedOverdue: number }> {
  console.log('Manual notification check triggered');

  const { updated: markedOverdue } = await markOverdueInstallments();

  const upcomingBefore = await prisma.notificationLog.count();
  await checkUpcomingPayments();
  const upcomingAfter = await prisma.notificationLog.count();

  const overdueBefore = await prisma.notificationLog.count();
  await checkOverduePayments();
  const overdueAfter = await prisma.notificationLog.count();

  return {
    upcomingCount: upcomingAfter - upcomingBefore,
    overdueCount: overdueAfter - overdueBefore,
    markedOverdue,
  };
}
