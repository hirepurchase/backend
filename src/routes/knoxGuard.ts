import { Router } from 'express';
import {
  checkPortalActiveDevices,
  enrollDeviceManual,
  linkDeviceToContract,
  enrollKnoxGuardContractDevice,
  approveKnoxGuardContractDevice,
  evaluateKnoxGuardContractDevice,
  getKnoxGuardContractDevice,
  getKnoxGuardHealth,
  getKnoxPortalDeviceStatus,
  handleKnoxGuardWebhook,
  listKnoxGuardCommands,
  listKnoxGuardDevices,
  lockKnoxGuardContractDevice,
  processKnoxGuardCommands,
  unlockKnoxGuardContractDevice,
} from '../controllers/knoxGuardController';
import { getKnoxGuardSettings, updateKnoxGuardSettings } from '../controllers/knoxGuardSettingsController';
import {
  getKnoxUploadStatuses,
  getSamsungUploadStatus,
  retryKnoxUpload,
  syncUploadStatusFromPortal,
  uploadDevicesDirect,
  listDevicesFromDevicesApi,
  deleteDevices,
  resetKnoxDevice,
  removeManagedDevice,
  patchKnoxUploadStatus,
} from '../controllers/knoxGuardUploadController';
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
  '/contracts/:contractId/approve',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  approveKnoxGuardContractDevice
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

router.get(
  '/upload/status',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  getKnoxUploadStatuses
);

router.post(
  '/upload/sync',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  syncUploadStatusFromPortal
);

router.post(
  '/upload/retry',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  retryKnoxUpload
);

router.get(
  '/upload/:uploadId/samsung-status',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  getSamsungUploadStatus
);

router.get(
  '/devices/portal-check',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  checkPortalActiveDevices
);

router.post(
  '/devices/enroll-manual',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  enrollDeviceManual
);

router.patch(
  '/devices/:managedDeviceId/link-contract',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  linkDeviceToContract
);

router.post(
  '/devices/upload-direct',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  uploadDevicesDirect
);

router.get(
  '/devices/list-api',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  listDevicesFromDevicesApi
);

router.delete(
  '/devices/delete',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  deleteDevices
);

router.post(
  '/devices/reset',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  resetKnoxDevice
);

router.delete(
  '/devices/managed/:imei',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  removeManagedDevice
);

router.get(
  '/devices/portal-status/:serialNumber',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL),
  getKnoxPortalDeviceStatus
);

router.patch(
  '/upload/status/:serialNumber',
  authenticateAdmin,
  requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL),
  patchKnoxUploadStatus
);

export default router;
