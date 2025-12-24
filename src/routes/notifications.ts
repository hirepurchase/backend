import express from 'express';
import {
  getNotificationSettings,
  updateNotificationSettings,
  getNotificationLogs,
  getNotificationStats,
} from '../controllers/notificationController';
import { authenticateAdmin, requirePermission } from '../middleware/auth';
import { triggerManualCheck } from '../services/notificationScheduler';

const router = express.Router();

// Notification settings routes
router.get('/settings', authenticateAdmin, getNotificationSettings);
router.put('/settings', authenticateAdmin, requirePermission('MANAGE_SETTINGS'), updateNotificationSettings);

// Notification logs routes
router.get('/logs', authenticateAdmin, requirePermission('VIEW_REPORTS'), getNotificationLogs);
router.get('/stats', authenticateAdmin, requirePermission('VIEW_REPORTS'), getNotificationStats);

// Manual trigger route
router.post('/trigger', authenticateAdmin, requirePermission('MANAGE_SETTINGS'), async (req, res) => {
  try {
    const result = await triggerManualCheck();
    res.json({
      message: 'Notification check triggered successfully',
      upcomingSent: result.upcomingCount,
      overdueSent: result.overdueCount,
    });
  } catch (error) {
    console.error('Manual trigger error:', error);
    res.status(500).json({ error: 'Failed to trigger notification check' });
  }
});

export default router;
