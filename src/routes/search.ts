import { Router } from 'express';
import { authenticateAdmin } from '../middleware/auth';
import { globalSearch } from '../controllers/searchController';

const router = Router();
// Signed-in staff only; results are narrowed to what each person may see.
router.get('/', authenticateAdmin, globalSearch);
export default router;
