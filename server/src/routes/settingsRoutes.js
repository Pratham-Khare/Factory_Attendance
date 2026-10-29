import express from 'express';
const { Router } = express;
import { getSettings, updateSettings } from '../controllers/settingsController.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAdmin);
router.get('/', getSettings);
router.put('/', updateSettings);
export default router;
