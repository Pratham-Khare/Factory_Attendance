import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import FactorySettings from '../models/FactorySettings.js';

const DEFAULTS = {
  shiftStart: '09:00',
  shiftEnd: '18:00',
  graceMinutes: 15,
  halfDayAfter: '13:00',
  minimumFullDayHours: 8,
  workingDays: [1,2,3,4,5,6],
  overtimeEnabled: true,
  overtimeAfter: '18:00',
  minimumCheckoutGapMinutes: 30,
};

async function getSettings() {
  let settings = await FactorySettings.findOne({ key: 'default' }).lean();
  if (!settings) settings = await FactorySettings.create({ key: 'default', ...DEFAULTS });
  return settings;
}

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function currentMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

function timeToMinutes(value) {
  const [h, m] = String(value || '00:00').split(':').map(Number);
  return h * 60 + m;
}

function statusForCheckIn(now, settings, employee) {
  const arrival = currentMinutes(now);
  const start = timeToMinutes(employee?.shift?.start || settings.shiftStart);
  const halfDay = timeToMinutes(settings.halfDayAfter);
  if (arrival >= halfDay) return 'half-day';
  if (arrival > start + Number(settings.graceMinutes || 0)) return 'late';
  return 'present';
}

function overtimeHours(checkOut, settings, employee) {
  if (!settings.overtimeEnabled) return 0;
  const out = currentMinutes(checkOut);
  const threshold = timeToMinutes(employee?.shift?.end || settings.overtimeAfter);
  return Math.max(0, Number(((out - threshold) / 60).toFixed(2)));
}

export async function checkIn(req, res, next) {
  try {
    const { employeeId, verificationMethod='face', verificationScore } = req.body;
    const employee = await Employee.findOne({ employeeId, status:'active' });
    if (!employee) return res.status(404).json({ message:'Employee not found' });
    const settings = await getSettings();
    const date = today();
    const now = new Date();
    let record = await Attendance.findOne({ employeeId, date });
    if (record?.checkIn) return res.status(409).json({ message:'Employee already checked in', record });
    const status = statusForCheckIn(now, settings, employee);
    if (record) {
      record.checkIn = now; record.status = status; record.verificationMethod = verificationMethod; record.verificationScore = verificationScore; await record.save();
    } else {
      record = await Attendance.create({ employee:employee._id, employeeId, date, checkIn:now, status, verificationMethod, verificationScore });
    }
    res.status(201).json({ message:'Check-in recorded', employee:{employeeId:employee.employeeId,name:employee.name}, record });
  } catch(e) { next(e); }
}

export async function checkOut(req, res, next) {
  try {
    const { employeeId, verificationMethod='face', verificationScore } = req.body;
    const employee = await Employee.findOne({ employeeId, status:'active' });
    if (!employee) return res.status(404).json({ message:'Employee not found' });
    const record = await Attendance.findOne({ employeeId, date:today() });
    if (!record?.checkIn) return res.status(400).json({ message:'No check-in found for today' });
    if (record.checkOut) return res.status(409).json({ message:'Employee already checked out', record });

    const settings = await getSettings();
    const now = new Date();
    const minimumGap = Math.max(30, Number(settings.minimumCheckoutGapMinutes || 30));
    const earliestCheckout = new Date(new Date(record.checkIn).getTime() + minimumGap * 60000);
    if (now < earliestCheckout) {
      const remainingMinutes = Math.ceil((earliestCheckout - now) / 60000);
      return res.status(409).json({
        message: `Check-out is available after ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`,
        code: 'CHECKOUT_TOO_SOON',
        earliestCheckout,
        remainingMinutes
      });
    }
    record.checkOut = now;
    record.verificationMethod = verificationMethod;
    record.verificationScore = verificationScore;
    record.overtimeHours = overtimeHours(now, settings, employee);

    const hours = Math.max(0, (now - new Date(record.checkIn)) / 3600000);
    if (hours < Number(settings.minimumFullDayHours || 0) && record.status === 'present') record.status = 'half-day';
    await record.save();

    res.json({ message:'Check-out recorded', employee:{employeeId:employee.employeeId,name:employee.name}, record });
  } catch(e) { next(e); }
}

export async function todayAttendance(req,res,next){
  try { res.json({ attendance:await Attendance.find({date:today()}).populate('employee','name department').sort({checkIn:1}) }); }
  catch(e){ next(e); }
}

export async function monthlyAttendance(req,res,next){
  try { const month=req.params.month; res.json({attendance:await Attendance.find({date:{$regex:`^${month}`}}).populate('employee','name department').sort({date:1,checkIn:1})}); }
  catch(e){ next(e); }
}
