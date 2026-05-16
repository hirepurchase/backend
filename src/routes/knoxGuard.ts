import { Router } from 'express';
import {
  enrollKnoxGuardContractDevice,
  evaluateKnoxGuardContractDevice,
  getKnoxGuardContractDevice,
  getKnoxGuardHealth,
  handleKnoxGuardWebhook,
  listKnoxGuardCommands,
  listKnoxGuardDevices,
  lockKnoxGuardContractDevice,
  processKnoxGuardCommands,
  unlockKnoxGuardContractDevice,
} from '../controllers/knoxGuardController';
import { getKnoxGuardSettings, updateKnoxGuardSettings } from '../controllers/knoxGuardSettingsController';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

router.post(
  '/webhook',
  handleKnoxGuardWebhook
);

router.get(
  '/settings',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  getKnoxGuardSettings
);

router.patch(
  '/settings',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  updateKnoxGuardSettings
);

router.get(
  '/health',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  getKnoxGuardHealth
);

router.get(
  '/devices',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  listKnoxGuardDevices
);

router.get(
  '/commands',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  listKnoxGuardCommands
);

router.get(
  '/contracts/:contractId',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  getKnoxGuardContractDevice
);

router.post(
  '/contracts/:contractId/enroll',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  enrollKnoxGuardContractDevice
);

router.post(
  '/contracts/:contractId/evaluate',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  evaluateKnoxGuardContractDevice
);

router.post(
  '/contracts/:contractId/lock',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  lockKnoxGuardContractDevice
);

router.post(
  '/contracts/:contractId/unlock',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  unlockKnoxGuardContractDevice
);

router.post(
  '/commands/process',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  processKnoxGuardCommands
);

export default router;
