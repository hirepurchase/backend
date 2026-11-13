import { Router } from 'express';
import { authenticateAdmin } from '../middleware/auth';
import { getLicences, setKnoxSeatsPurchased } from '../controllers/licenceController';

// Device-lock licences left (Knox Guard and PayTrigger). Super admin only,
// checked in the controller.
const router = Router();
router.use(authenticateAdmin);
router.get('/', getLicences);
router.put('/knox', setKnoxSeatsPurchased);
export default router;
