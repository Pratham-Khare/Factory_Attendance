import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import AttendanceAudit from '../models/AttendanceAudit.js';
import FactorySettings from '../models/FactorySettings.js';
import Leave from '../models/Leave.js';
import Holiday from '../models/Holiday.js';

const DEFAULTS = { shiftStart:'09:00', shiftEnd:'18:00', graceMinutes:15, halfDayAfter:'13:00', minimumFullDayHours:8, overtimeEnabled:true, overtimeAfter:'18:00' };

async function getSettings() {
  return await FactorySettings.findOne({ key:'default' }).lean() || DEFAULTS;
}

function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function timeToMinutes(value) { const [h,m] = String(value || '00:00').split(':').map(Number); return h*60+m; }
function localMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(date));
  return Number(parts.find(p=>p.type==='hour')?.value||0)*60 + Number(parts.find(p=>p.type==='minute')?.value||0);
}
function statusFromTimes(checkIn, checkOut, settings, employee, requested='auto') {
  if (requested && requested !== 'auto') return requested;
  if (!checkIn) return 'absent';
  const arrival = localMinutes(checkIn);
  const shiftStart = employee?.shift?.start || settings.shiftStart;
  let status = arrival >= timeToMinutes(settings.halfDayAfter) ? 'half-day' : arrival > timeToMinutes(shiftStart) + Number(settings.graceMinutes||0) ? 'late' : 'present';
  if (checkOut && status === 'present') {
    const hours = Math.max(0,(new Date(checkOut)-new Date(checkIn))/3600000);
    if (hours < Number(settings.minimumFullDayHours||0)) status='half-day';
  }
  return status;
}
function overtimeFromCheckout(checkOut, settings, employee) {
  if (!checkOut || !settings.overtimeEnabled) return 0;
  const threshold = employee?.shift?.end || settings.overtimeAfter;
  return Math.max(0, Number(((localMinutes(checkOut)-timeToMinutes(threshold))/60).toFixed(2)));
}
function snapshot(record) {
  if (!record) return null;
  return { employeeId:record.employeeId, date:record.date, checkIn:record.checkIn || null, checkOut:record.checkOut || null, status:record.status, verificationMethod:record.verificationMethod, overtimeHours:Number(record.overtimeHours||0) };
}

export async function manageAttendance(req,res,next) {
  try {
    const date = validDate(req.query.date) ? req.query.date : new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
    const [employees, records, approvedLeaves, holiday] = await Promise.all([
      Employee.find().select('-faceEmbedding').sort({name:1}).lean(),
      Attendance.find({date}).sort({checkIn:1}).lean(),
      Leave.find({status:'approved',startDate:{$lte:date},endDate:{$gte:date}}).lean(),
      Holiday.findOne({date}).lean(),
    ]);
    const byId = new Map(records.map(r=>[r.employeeId,r]));
    const leaveById = new Map(approvedLeaves.map(l=>[l.employeeId,l]));
    const rows = employees.map(employee => {
      const attendance=byId.get(employee.employeeId)||null;
      const leave=leaveById.get(employee.employeeId)||null;
      let specialStatus=null;
      if(!attendance && holiday) specialStatus='holiday';
      else if(!attendance && leave) specialStatus='leave';
      return {
        employeeId:employee.employeeId, name:employee.name, department:employee.department||'', designation:employee.designation||'', status:employee.status,
        attendance, leave:leave?{_id:leave._id,type:leave.type,startDate:leave.startDate,endDate:leave.endDate,reason:leave.reason}:null,
        specialStatus, holiday:holiday?{_id:holiday._id,name:holiday.name,description:holiday.description}:null,
      };
    });
    res.json({date, rows, records:records.length, holiday:holiday?{_id:holiday._id,name:holiday.name,description:holiday.description}:null});
  } catch(e){ next(e); }
}

export async function saveManagedAttendance(req,res,next) {
  try {
    const { employeeId, date, checkIn, checkOut, status='auto', reason='' } = req.body;
    if (!employeeId || !validDate(date)) return res.status(400).json({message:'Employee ID and a valid date (YYYY-MM-DD) are required'});
    if (checkIn && Number.isNaN(new Date(checkIn).getTime())) return res.status(400).json({message:'Invalid check-in time'});
    if (checkOut && Number.isNaN(new Date(checkOut).getTime())) return res.status(400).json({message:'Invalid check-out time'});
    if (checkIn && checkOut && new Date(checkOut) < new Date(checkIn)) return res.status(400).json({message:'Check-out cannot be before check-in'});
    const employee = await Employee.findOne({employeeId});
    if (!employee) return res.status(404).json({message:'Employee not found'});
    let record = await Attendance.findOne({employeeId,date});
    const before = snapshot(record);
    const settings = await getSettings();
    const requestedStatus = status || 'auto';
    const normalizedIn = checkIn ? new Date(checkIn) : undefined;
    const normalizedOut = checkOut ? new Date(checkOut) : undefined;
    const finalStatus = statusFromTimes(normalizedIn, normalizedOut, settings, employee, requestedStatus);
    const overtimeHours = overtimeFromCheckout(normalizedOut, settings, employee);

    if (record) {
      record.checkIn = normalizedIn;
      record.checkOut = normalizedOut;
      record.status = finalStatus;
      record.verificationMethod = 'manual';
      record.verificationScore = undefined;
      record.overtimeHours = overtimeHours;
      await record.save();
    } else {
      record = await Attendance.create({ employee:employee._id, employeeId, date, checkIn:normalizedIn, checkOut:normalizedOut, status:finalStatus, verificationMethod:'manual', overtimeHours });
    }
    const after = snapshot(record);
    await AttendanceAudit.create({ action:before?'updated':'created', employeeId, date, adminUsername:req.admin?.username||'admin', reason:String(reason||'').trim(), before, after });
    res.status(before?200:201).json({message:before?'Attendance updated successfully':'Attendance marked successfully',record});
  } catch(e){ next(e); }
}

export async function attendanceAudit(req,res,next) {
  try {
    const query = validDate(req.query.date) ? {date:req.query.date} : {};
    const audits = await AttendanceAudit.find(query).sort({createdAt:-1}).limit(200).lean();
    res.json({audits});
  } catch(e){ next(e); }
}
