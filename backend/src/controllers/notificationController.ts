import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import prisma from '../config/database';

// Get notification settings
export async function getNotificationSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    let settings = await prisma.notificationSettings.findFirst();

    // Create default settings if none exist
    if (!settings) {
      settings = await prisma.notificationSettings.create({
        data: {
          daysBeforeDue: 3,
          sendSMS: true,
          sendEmail: true,
          reminderFrequency: 'ONCE',
          enableOverdueReminders: true,
          overdueReminderFrequency: 'DAILY',
        },
      });
    }

    res.json(settings);
  } catch (error) {
    console.error('Get notification settings error:', error);
    res.status(500).json({ error: 'Failed to get notification settings' });
  }
}

// Update notification settings
export async function updateNotificationSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const {
      daysBeforeDue,
      sendSMS,
      sendEmail,
      reminderFrequency,
      enableOverdueReminders,
      overdueReminderFrequency,
      smsTemplate,
      emailTemplate,
    } = req.body;

    // Validation
    if (daysBeforeDue !== undefined && (daysBeforeDue < 1 || daysBeforeDue > 30)) {
      res.status(400).json({ error: 'Days before due must be between 1 and 30' });
      return;
    }

    if (reminderFrequency && !['ONCE', 'DAILY', 'WEEKLY'].includes(reminderFrequency)) {
      res.status(400).json({ error: 'Invalid reminder frequency' });
      return;
    }

    if (overdueReminderFrequency && !['DAILY', 'WEEKLY'].includes(overdueReminderFrequency)) {
      res.status(400).json({ error: 'Invalid overdue reminder frequency' });
      return;
    }

    // Get existing settings
    let settings = await prisma.notificationSettings.findFirst();

    if (settings) {
      // Update existing settings
      settings = await prisma.notificationSettings.update({
        where: { id: settings.id },
        data: {
          daysBeforeDue: daysBeforeDue !== undefined ? daysBeforeDue : settings.daysBeforeDue,
          sendSMS: sendSMS !== undefined ? sendSMS : settings.sendSMS,
          sendEmail: sendEmail !== undefined ? sendEmail : settings.sendEmail,
          reminderFrequency: reminderFrequency || settings.reminderFrequency,
          enableOverdueReminders: enableOverdueReminders !== undefined ? enableOverdueReminders : settings.enableOverdueReminders,
          overdueReminderFrequency: overdueReminderFrequency || settings.overdueReminderFrequency,
          smsTemplate: smsTemplate !== undefined ? smsTemplate : settings.smsTemplate,
          emailTemplate: emailTemplate !== undefined ? emailTemplate : settings.emailTemplate,
        },
      });
    } else {
      // Create new settings
      settings = await prisma.notificationSettings.create({
        data: {
          daysBeforeDue: daysBeforeDue || 3,
          sendSMS: sendSMS !== undefined ? sendSMS : true,
          sendEmail: sendEmail !== undefined ? sendEmail : true,
          reminderFrequency: reminderFrequency || 'ONCE',
          enableOverdueReminders: enableOverdueReminders !== undefined ? enableOverdueReminders : true,
          overdueReminderFrequency: overdueReminderFrequency || 'DAILY',
          smsTemplate,
          emailTemplate,
        },
      });
    }

    res.json({ message: 'Notification settings updated successfully', settings });
  } catch (error) {
    console.error('Update notification settings error:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
}

// Get notification logs with pagination
export async function getNotificationLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { page = '1', limit = '50', type, status, customerId } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (type) where.type = type;
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;

    const [logs, total] = await Promise.all([
      prisma.notificationLog.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              membershipId: true,
              firstName: true,
              lastName: true,
              phone: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.notificationLog.count({ where }),
    ]);

    res.json({
      logs,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Get notification logs error:', error);
    res.status(500).json({ error: 'Failed to get notification logs' });
  }
}

// Get notification stats
export async function getNotificationStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { startDate, endDate } = req.query;

    const where: any = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }

    const [totalSent, totalFailed, totalSMS, totalEmail] = await Promise.all([
      prisma.notificationLog.count({ where: { ...where, status: 'SENT' } }),
      prisma.notificationLog.count({ where: { ...where, status: 'FAILED' } }),
      prisma.notificationLog.count({ where: { ...where, type: 'SMS' } }),
      prisma.notificationLog.count({ where: { ...where, type: 'EMAIL' } }),
    ]);

    res.json({
      totalSent,
      totalFailed,
      totalSMS,
      totalEmail,
      successRate: totalSent + totalFailed > 0 ? ((totalSent / (totalSent + totalFailed)) * 100).toFixed(2) : 0,
    });
  } catch (error) {
    console.error('Get notification stats error:', error);
    res.status(500).json({ error: 'Failed to get notification stats' });
  }
}
