import express from 'express';
const { Router } = express;
import { monthlyReport } from '../controllers/reportController.js';
import { requireAdmin } from '../middleware/auth.js';
const router = Router();
router.use(requireAdmin);
router.get('/monthly/:month', monthlyReport);
export default router;
