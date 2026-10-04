import { NextFunction, Request, Response, Router } from 'express';
import {
  cancelEnrolment,
  enrolDevices,
  getDevice,
  getEnrolmentCandidates,
  getHealth,
  getIssues,
  getLadder,
  getLicence,
  getProducts,
  getSettings,
  handlePayTriggerWebhook,
  holdRelease,
  issuePin,
  listDevices,
  putBranding,
  putLadder,
  putProducts,
  putSettings,
  reconcileDevice,
  releaseDevice,
  uploadBrandingLogo,
  getLockProvider,
  verifyDevice,
} from '../controllers/payTriggerController';
import { upload } from '../config/upload';
import { authenticateAdmin, requireAnyPermission } from '../middleware/auth';
import { PERMISSIONS } from '../constants/permissions';

const router = Router();

const view = [authenticateAdmin, requireAnyPermission(PERMISSIONS.VIEW_DEVICE_CONTROL, PERMISSIONS.MANAGE_DEVICE_CONTROL)];
const manage = [authenticateAdmin, requireAnyPermission(PERMISSIONS.MANAGE_DEVICE_CONTROL)];

// Signed by PayTrigger, not by a user session.
router.post('/webhook', handlePayTriggerWebhook);

router.get('/health', ...view, getHealth);
router.get('/licence', ...view, getLicence);
router.get('/issues', ...view, getIssues);

router.get('/devices', ...view, listDevices);
router.get('/devices/:id', ...view, getDevice);
router.post('/devices/:id/reconcile', ...manage, reconcileDevice);
router.post('/devices/:id/verify', ...manage, verifyDevice);
router.post('/devices/:id/cancel-enrolment', ...manage, cancelEnrolment);
router.post('/devices/:id/hold-release', ...manage, holdRelease);
// The controller also requires the ADMIN or SUPER_ADMIN role.
router.post('/devices/:id/pin', ...manage, issuePin);
// Irreversible: the PayTrigger app uninstalls itself.
router.post('/devices/:id/release', authenticateAdmin, requireAnyPermission(PERMISSIONS.WRITE_OFF_CONTRACT), releaseDevice);

router.get('/lock-provider', ...manage, getLockProvider);
router.get('/enrolment/candidates', ...manage, getEnrolmentCandidates);
router.post('/enrolment', ...manage, enrolDevices);

router.get('/products', ...manage, getProducts);
router.put('/products', ...manage, putProducts);

router.get('/ladder', ...manage, getLadder);
router.put('/ladder', ...manage, putLadder);

router.get('/settings', ...manage, getSettings);
router.put('/settings', ...manage, putSettings);
router.put('/branding', ...manage, putBranding);
// A wrong file type or an oversized file comes back as a plain message, not a server error.
const logoUpload = (req: Request, res: Response, next: NextFunction) =>
  upload.single('logo')(req, res, (err: unknown) => {
    if (err) return res.status(400).json({ error: (err as Error).message || 'Upload failed' });
    next();
  });
router.post('/branding/logo', ...manage, logoUpload, uploadBrandingLogo);

export default router;
