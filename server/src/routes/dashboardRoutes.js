import express from 'express';
const { Router } = express;
import { dashboardSummary, employees } from '../controllers/dashboardController.js';
import { requireAdmin } from '../middleware/auth.js';
const router = Router();
router.use(requireAdmin);
router.get('/summary', dashboardSummary);
router.get('/employees', employees);
export default router;
