import express from 'express';
const { Router } = express;
import { createEmployee, listEmployees, getEmployeeById, identifyByFace, updateEmployee, employeeAttendanceHistory } from '../controllers/employeeController.js';
import { requireAdmin, requireAttendance } from '../middleware/auth.js';
const router = Router();
router.post('/identify-face', requireAttendance, identifyByFace); // kiosk endpoint
router.post('/', requireAdmin, createEmployee);
router.get('/', requireAdmin, listEmployees);
router.get('/:employeeId', requireAdmin, getEmployeeById);
router.put('/:employeeId', requireAdmin, updateEmployee);
router.get('/:employeeId/attendance', requireAdmin, employeeAttendanceHistory);
export default router;
