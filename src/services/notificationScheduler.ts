import { sendPaymentReminder, sendOverdueNotification } from './notificationService';
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
    console.log('Checking for upcoming payments...');

    // Get notification settings
    const settings = await prisma.notificationSettings.findFirst();

    if (!settings) {
      console.log('No notification settings found');
      return;
    }

    if (!settings.sendSMS && !settings.sendEmail) {
      console.log('Notifications are disabled');
      return;
    }

    const daysBeforeDue = settings.daysBeforeDue;
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + daysBeforeDue);
    targetDate.setHours(0, 0, 0, 0);

    const endOfTargetDate = new Date(targetDate);
    endOfTargetDate.setHours(23, 59, 59, 999);

    // Find pending installments due on the target date
    const installments = await prisma.installmentSchedule.findMany({
      where: {
        status: 'PENDING',
        dueDate: {
          gte: targetDate,
          lte: endOfTargetDate,
        },
      },
      include: {
        contract: {
          include: {
            customer: true,
          },
        },
      },
    });

    console.log(`Found ${installments.length} installments due in ${daysBeforeDue} days`);

    for (const installment of installments) {
      const customer = installment.contract.customer;

      // Check if we already sent a reminder today
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const existingReminder = await prisma.notificationLog.findFirst({
        where: {
          customerId_uuid: customer.id_uuid!,
          installmentId: installment.id,
          type: 'SMS',
          createdAt: {
            gte: today,
          },
        },
      });

      // Skip if we already sent a reminder today (for ONCE frequency)
      if (existingReminder && settings.reminderFrequency === 'ONCE') {
        console.log(`Skipping reminder for ${customer.firstName} ${customer.lastName} - already sent today`);
        continue;
      }

      // Send reminder
      console.log(`Sending payment reminder to ${customer.firstName} ${customer.lastName}`);

      await sendPaymentReminder({
        customerFirstName: customer.firstName,
        customerLastName: customer.lastName,
        customerEmail: customer.email || undefined,
        customerPhone: customer.phone,
        customerId: customer.id_uuid!,
        contractNumber: installment.contract.contractNumber,
        contractId: installment.contract.id,
        installmentId: installment.id,
        installmentNumber: installment.installmentNo,
        amount: installment.amount,
        dueDate: installment.dueDate,
        daysUntilDue: daysBeforeDue,
      });

      // Small delay to avoid overwhelming the SMS API
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('Finished checking upcoming payments');
  } catch (error) {
    console.error('Error checking upcoming payments:', error);
  }
}

// Check for overdue payments and send reminders
export async function checkOverduePayments(): Promise<void> {
  try {
    console.log('Checking for overdue payments...');

    // Get notification settings
    const settings = await prisma.notificationSettings.findFirst();

    if (!settings) {
      console.log('No notification settings found');
      return;
    }

    if (!settings.enableOverdueReminders) {
      console.log('Overdue reminders are disabled');
      return;
    }

    if (!settings.sendSMS && !settings.sendEmail) {
      console.log('Notifications are disabled');
      return;
    }

    // Find overdue installments
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const overdueInstallments = await prisma.installmentSchedule.findMany({
      where: {
        status: {
          in: ['OVERDUE', 'PARTIAL'],
        },
        dueDate: {
          lt: now,
        },
      },
      include: {
        contract: {
          include: {
            customer: true,
          },
        },
      },
    });

    console.log(`Found ${overdueInstallments.length} overdue installments`);

    for (const installment of overdueInstallments) {
      const customer = installment.contract.customer;
      const daysOverdue = Math.floor((now.getTime() - installment.dueDate.getTime()) / (1000 * 60 * 60 * 24));

      // Check if we should send a reminder based on frequency
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const lastReminder = await prisma.notificationLog.findFirst({
        where: {
          customerId_uuid: customer.id_uuid!,
          installmentId: installment.id,
          type: 'SMS',
          message: {
            contains: 'OVERDUE',
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Skip if we sent a reminder today and frequency is daily
      if (lastReminder && settings.overdueReminderFrequency === 'DAILY') {
        const lastReminderDate = new Date(lastReminder.createdAt);
        lastReminderDate.setHours(0, 0, 0, 0);
        if (lastReminderDate.getTime() === today.getTime()) {
          console.log(`Skipping overdue reminder for ${customer.firstName} ${customer.lastName} - already sent today`);
          continue;
        }
      }

      // Skip if we sent a reminder this week and frequency is weekly
      if (lastReminder && settings.overdueReminderFrequency === 'WEEKLY') {
        const daysSinceLastReminder = Math.floor((today.getTime() - new Date(lastReminder.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceLastReminder < 7) {
          console.log(`Skipping overdue reminder for ${customer.firstName} ${customer.lastName} - sent within last week`);
          continue;
        }
      }

      // Get penalty amount if any (penalties are per contract, not per installment)
      const penalty = await prisma.penalty.findFirst({
        where: {
          contractId: installment.contract.id,
          isPaid: false,
        },
      });

      // Send overdue notification
      console.log(`Sending overdue notification to ${customer.firstName} ${customer.lastName} - ${daysOverdue} days overdue`);

      await sendOverdueNotification({
        customerFirstName: customer.firstName,
        customerLastName: customer.lastName,
        customerEmail: customer.email || undefined,
        customerPhone: customer.phone,
        customerId: customer.id_uuid!,
        contractNumber: installment.contract.contractNumber,
        contractId: installment.contract.id,
        installmentId: installment.id,
        installmentNumber: installment.installmentNo,
        amount: installment.amount,
        paidAmount: installment.paidAmount,
        dueDate: installment.dueDate,
        daysOverdue,
        penaltyAmount: penalty?.amount,
      });

      // Small delay to avoid overwhelming the SMS API
      await new Promise(resolve => setTimeout(resolve, 1000));
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
