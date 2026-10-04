import express from 'express';
const { Router } = express;
import {checkIn,checkOut,todayAttendance,monthlyAttendance} from '../controllers/attendanceController.js';
import { requireAttendance } from '../middleware/auth.js';
const router=Router(); router.post('/check-in', requireAttendance, checkIn); router.post('/check-out', requireAttendance, checkOut); router.get('/today',todayAttendance); router.get('/monthly/:month',monthlyAttendance); export default router;
