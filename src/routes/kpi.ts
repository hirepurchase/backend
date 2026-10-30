import { Router } from 'express';
import { getKpiTargets, getMyKpis, getPeopleKpis, getStockGateStatus, putKpiTargets } from '../controllers/kpiController';
import { authenticateAdmin } from '../middleware/auth';

const router = Router();

// Who may see whom, and who may set targets, is decided in the controller:
// everyone sees their own card, cluster leaders their agents, admins everyone.
router.get('/me', authenticateAdmin, getMyKpis);
router.get('/people', authenticateAdmin, getPeopleKpis);
router.get('/targets', authenticateAdmin, getKpiTargets);
router.put('/targets', authenticateAdmin, putKpiTargets);
router.get('/stock-gate', authenticateAdmin, getStockGateStatus);

export default router;
