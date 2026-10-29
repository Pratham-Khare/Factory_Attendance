import express from 'express';
const { Router } = express;
import { createEmployee, listEmployees, getEmployeeById, identifyByFace, updateEmployee, employeeAttendanceHistory } from '../controllers/employeeController.js';
import { requireAdmin } from '../middleware/auth.js';
const router = Router();
router.post('/identify-face', identifyByFace); // public kiosk face match; attendance writes require signed match proof
router.post('/', requireAdmin, createEmployee);
router.get('/', requireAdmin, listEmployees);
router.get('/:employeeId', requireAdmin, getEmployeeById);
router.put('/:employeeId', requireAdmin, updateEmployee);
router.get('/:employeeId/attendance', requireAdmin, employeeAttendanceHistory);
export default router;
