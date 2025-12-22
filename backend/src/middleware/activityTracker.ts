import { Request, Response, NextFunction } from 'express';
import { recordActivity } from '../services/idleShutdownService';

/**
 * Middleware to track server activity
 * Records activity on every request to reset the idle shutdown timer
 */
export function activityTracker(req: Request, res: Response, next: NextFunction): void {
  // Record activity for every incoming request
  recordActivity();
  next();
}
