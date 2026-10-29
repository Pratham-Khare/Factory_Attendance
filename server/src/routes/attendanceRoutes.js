import express from 'express';
const { Router } = express;
import {checkIn,checkOut,todayAttendance,monthlyAttendance} from '../controllers/attendanceController.js';
import { requireFaceMatchProof } from '../middleware/auth.js';
const router=Router(); router.post('/check-in', requireFaceMatchProof, checkIn); router.post('/check-out', requireFaceMatchProof, checkOut); router.get('/today',todayAttendance); router.get('/monthly/:month',monthlyAttendance); export default router;
