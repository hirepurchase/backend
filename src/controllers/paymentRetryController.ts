import { Request, Response } from 'express';
import {
  getRetrySettings,
  updateRetrySettings,
  retryPayment,
  retryAllEligiblePayments,
  getFailedPayments,
  getPaymentRetryHistory,
} from '../services/paymentRetryService';

// Get retry settings
export async function getSettings(req: Request, res: Response): Promise<void> {
  try {
    const settings = await getRetrySettings();
    res.json(settings);
  } catch (error: any) {
    console.error('Error getting retry settings:', error);
    res.status(500).json({ error: 'Failed to get retry settings' });
  }
}

// Update retry settings
export async function updateSettings(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const {
      enableAutoRetry,
      maxRetryAttempts,
      retryIntervalHours,
      retrySchedule,
      notifyOnFailure,
      notifyCustomerOnFailure,
      sendSMSOnFailure,
      failureSMSTemplate,
    } = req.body;

    // Validation
    if (maxRetryAttempts !== undefined && (maxRetryAttempts < 0 || maxRetryAttempts > 10)) {
      res.status(400).json({ error: 'Max retry attempts must be between 0 and 10' });
      return;
    }

    if (retryIntervalHours !== undefined && (retryIntervalHours < 1 || retryIntervalHours > 168)) {
      res.status(400).json({ error: 'Retry interval must be between 1 and 168 hours' });
      return;
    }

    if (retrySchedule !== undefined) {
      // Validate retry schedule format
      const scheduleArray = retrySchedule.split(',').map((d: string) => parseInt(d.trim()));
      if (scheduleArray.some((d: number) => isNaN(d) || d < 0 || d > 30)) {
        res.status(400).json({ error: 'Invalid retry schedule format. Must be comma-separated numbers between 0 and 30' });
        return;
      }
    }

    const settings = await updateRetrySettings({
      enableAutoRetry,
      maxRetryAttempts,
      retryIntervalHours,
      retrySchedule,
      notifyOnFailure,
      notifyCustomerOnFailure,
      sendSMSOnFailure,
      failureSMSTemplate,
    });

    res.json(settings);
  } catch (error: any) {
    console.error('Error updating retry settings:', error);
    res.status(500).json({ error: 'Failed to update retry settings' });
  }
}

// Get all failed payments
export async function getFailedPaymentsList(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const {
      contractId,
      customerId,
      limit = '50',
      offset = '0',
    } = req.query;

    const { payments, total } = await getFailedPayments({
      contractId: contractId as string,
      customerId: customerId as string,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });

    res.json({
      payments,
      total,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    });
  } catch (error: any) {
    console.error('Error getting failed payments:', error);
    res.status(500).json({ error: 'Failed to get failed payments' });
  }
}

// Retry a single payment
export async function retrySinglePayment(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { paymentId } = req.params;

    if (!paymentId) {
      res.status(400).json({ error: 'Payment ID is required' });
      return;
    }

    const result = await retryPayment(paymentId);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: any) {
    console.error('Error retrying payment:', error);
    res.status(500).json({ error: 'Failed to retry payment' });
  }
}

// Retry multiple payments
export async function retryMultiplePayments(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { paymentIds } = req.body;

    if (!Array.isArray(paymentIds) || paymentIds.length === 0) {
      res.status(400).json({ error: 'Payment IDs array is required' });
      return;
    }

    const results: Array<Record<string, any>> = [];
    let succeeded = 0;
    let failed = 0;

    for (const paymentId of paymentIds) {
      const result = await retryPayment(paymentId);
      results.push({
        paymentId,
        ...result,
      });

      if (result.success) {
        succeeded++;
      } else {
        failed++;
      }
    }

    res.json({
      success: true,
      processed: paymentIds.length,
      succeeded,
      failed,
      results,
    });
  } catch (error: any) {
    console.error('Error retrying multiple payments:', error);
    res.status(500).json({ error: 'Failed to retry payments' });
  }
}

// Retry all eligible payments
export async function retryAllPayments(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const result = await retryAllEligiblePayments();
    res.json(result);
  } catch (error: any) {
    console.error('Error retrying all payments:', error);
    res.status(500).json({ error: 'Failed to retry all payments' });
  }
}

// Get retry history for a payment
export async function getRetryHistory(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { paymentId } = req.params;

    if (!paymentId) {
      res.status(400).json({ error: 'Payment ID is required' });
      return;
    }

    const history = await getPaymentRetryHistory(paymentId);
    res.json(history);
  } catch (error: any) {
    console.error('Error getting retry history:', error);
    res.status(500).json({ error: 'Failed to get retry history' });
  }
}
