import { Response } from 'express';
import prisma from '../config/database';
import { AuthenticatedRequest } from '../types';

export async function getCommissionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    let settings = await prisma.commissionSettings.findFirst();

    if (!settings) {
      settings = await prisma.commissionSettings.create({
        data: {
          fixedAmount: 0,
          effectiveDate: new Date(),
        },
      });
    }

    res.json(settings);
  } catch (error) {
    console.error('Get commission settings error:', error);
    res.status(500).json({ error: 'Failed to get commission settings' });
  }
}

export async function updateCommissionSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { fixedAmount, effectiveDate } = req.body;

    if (fixedAmount === undefined || fixedAmount === null) {
      res.status(400).json({ error: 'fixedAmount is required' });
      return;
    }

    const amount = Number(fixedAmount);
    if (isNaN(amount) || amount < 0) {
      res.status(400).json({ error: 'fixedAmount must be a non-negative number' });
      return;
    }

    if (!effectiveDate) {
      res.status(400).json({ error: 'effectiveDate is required' });
      return;
    }

    const parsedDate = new Date(effectiveDate);
    if (isNaN(parsedDate.getTime())) {
      res.status(400).json({ error: 'Invalid effectiveDate' });
      return;
    }

    let settings = await prisma.commissionSettings.findFirst();

    if (settings) {
      settings = await prisma.commissionSettings.update({
        where: { id: settings.id },
        data: { fixedAmount: amount, effectiveDate: parsedDate },
      });
    } else {
      settings = await prisma.commissionSettings.create({
        data: { fixedAmount: amount, effectiveDate: parsedDate },
      });
    }

    res.json(settings);
  } catch (error) {
    console.error('Update commission settings error:', error);
    res.status(500).json({ error: 'Failed to update commission settings' });
  }
}
