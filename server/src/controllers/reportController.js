import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import FactorySettings from '../models/FactorySettings.js';
import Leave from '../models/Leave.js';
import Holiday from '../models/Holiday.js';

const DEFAULTS = { workingDays:[1,2,3,4,5,6] };

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function isWorkingDay(year, month, day, workingDays) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return workingDays.includes(dow);
}
function durationHours(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  return Math.max(0, (new Date(checkOut) - new Date(checkIn)) / 3600000);
}
function dateRange(start,end){
  const out=[]; let d=new Date(`${start}T00:00:00Z`); const stop=new Date(`${end}T00:00:00Z`);
  while(d<=stop){out.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()+1);}
  return out;
}

export async function monthlyReport(req, res, next) {
  try {
    const month = /^\d{4}-\d{2}$/.test(req.params.month) ? req.params.month : null;
    if (!month) return res.status(400).json({ message:'Month must be YYYY-MM' });
    const settings = await FactorySettings.findOne({ key:'default' }).lean() || DEFAULTS;
    const [year, monthNumber] = month.split('-').map(Number);
    const totalCalendarDays = daysInMonth(month);
    const workingDays = settings.workingDays || DEFAULTS.workingDays;
    const monthDates=[];
    let scheduledDays = 0;
    for(let day=1; day<=totalCalendarDays; day+=1){
      const date=`${month}-${String(day).padStart(2,'0')}`;
      monthDates.push(date);
      if(isWorkingDay(year,monthNumber,day,workingDays)) scheduledDays += 1;
    }
    const [employees, attendance, holidays, leaves] = await Promise.all([
      Employee.find({ status:'active' }).select('-faceEmbedding').sort({name:1}),
      Attendance.find({ date:{ $regex:`^${month}` } }).sort({date:1,checkIn:1}),
      Holiday.find({date:{$in:monthDates}}).lean(),
      Leave.find({status:'approved',startDate:{$lte:monthDates.at(-1)},endDate:{$gte:monthDates[0]}}).lean(),
    ]);
    const holidayDates=new Set(holidays.map(h=>h.date));
    const holidayWorkingDates=new Set(monthDates.filter(d=>holidayDates.has(d) && isWorkingDay(year,monthNumber,Number(d.slice(-2)),workingDays)));
    const leaveByEmployee=new Map();
    for(const leave of leaves){
      const dates=dateRange(leave.startDate>monthDates[0]?leave.startDate:monthDates[0], leave.endDate<monthDates.at(-1)?leave.endDate:monthDates.at(-1));
      const set=leaveByEmployee.get(leave.employeeId)||new Set();
      dates.forEach(d=>{const day=Number(d.slice(-2)); if(isWorkingDay(year,monthNumber,day,workingDays) && !holidayDates.has(d)) set.add(d);});
      leaveByEmployee.set(leave.employeeId,set);
    }
    const byEmployee = new Map();
    for (const employee of employees) {
      const leaveDates=leaveByEmployee.get(employee.employeeId)||new Set();
      byEmployee.set(employee.employeeId, { employeeId:employee.employeeId,name:employee.name,department:employee.department||'',designation:employee.designation||'',scheduledDays,holidayDays:holidayWorkingDates.size,leave:leaveDates.size,present:0,late:0,halfDay:0,absent:0,incomplete:0,totalHours:0,overtimeHours:0,records:0, salary: employee.salary || {} });
    }
    for (const record of attendance) {
      const row=byEmployee.get(record.employeeId); if(!row) continue;
      row.records += 1;
      if(record.checkIn) row.present += 1;
      if(record.status==='late') row.late += 1;
      if(record.status==='half-day') row.halfDay += 1;
      if(record.status==='incomplete' || (record.checkIn && !record.checkOut)) row.incomplete += 1;
      row.totalHours += durationHours(record.checkIn,record.checkOut);
      row.overtimeHours += Number(record.overtimeHours || 0);
    }
    for(const row of byEmployee.values()) {
      const leaveDates=leaveByEmployee.get(row.employeeId)||new Set();
      // A day with a real attendance record is treated as worked even if leave was also recorded.
      const workedDates=new Set(attendance.filter(a=>a.employeeId===row.employeeId && a.checkIn).map(a=>a.date));
      const effectiveLeave=[...leaveDates].filter(d=>!workedDates.has(d)).length;
      row.leave=effectiveLeave;
      row.absent=Math.max(row.scheduledDays-row.holidayDays-effectiveLeave-row.present,0);
      row.effectiveScheduledDays=Math.max(row.scheduledDays-row.holidayDays-effectiveLeave,0);
      row.attendancePercentage=row.effectiveScheduledDays?Number(((row.present/row.effectiveScheduledDays)*100).toFixed(1)):100;
      row.totalHours=Number(row.totalHours.toFixed(2));
      row.overtimeHours=Number(row.overtimeHours.toFixed(2));
      const salary = row.salary || {};
      const monthlySalary = Number(salary.monthlySalary || 0);
      const dailyRate = row.effectiveScheduledDays > 0 ? monthlySalary / row.effectiveScheduledDays : 0;
      const halfDayDeductionRate = Number(salary.halfDayDeduction || 0) || dailyRate / 2;
      const absentDeductionRate = Number(salary.absentDeduction || 0) || dailyRate;
      const lateDeductionRate = Number(salary.lateDeduction || 0);
      const unpaidLeaveRate = Number(salary.unpaidLeaveDeduction || 0) || dailyRate;
      const unpaidLeaveDates = [...leaveDates].filter(d => !workedDates.has(d));
      // Leave objects are not kept in the row, so query the month leaves for this employee.
      const employeeLeaveRecords = leaves.filter(l => l.employeeId === row.employeeId && l.status === 'approved');
      let unpaidLeaveDays = 0;
      for (const leave of employeeLeaveRecords) {
        if (leave.type !== 'unpaid') continue;
        const dates = dateRange(leave.startDate > monthDates[0] ? leave.startDate : monthDates[0], leave.endDate < monthDates.at(-1) ? leave.endDate : monthDates.at(-1));
        unpaidLeaveDays += dates.filter(d => !holidayDates.has(d) && isWorkingDay(year,monthNumber,Number(d.slice(-2)),workingDays) && !workedDates.has(d)).length;
      }
      const attendanceDeductions = row.halfDay * halfDayDeductionRate + Math.max(row.absent - unpaidLeaveDays, 0) * absentDeductionRate + row.late * lateDeductionRate;
      const leaveDeductions = unpaidLeaveDays * unpaidLeaveRate;
      const overtimePay = row.overtimeHours * Number(salary.overtimeRatePerHour || 0);
      row.salaryBreakdown = {
        monthlySalary: Number(monthlySalary.toFixed(2)),
        dailyRate: Number(dailyRate.toFixed(2)),
        overtimeRatePerHour: Number(salary.overtimeRatePerHour || 0),
        overtimePay: Number(overtimePay.toFixed(2)),
        halfDayDeduction: Number((row.halfDay * halfDayDeductionRate).toFixed(2)),
        absentDeduction: Number((Math.max(row.absent - unpaidLeaveDays, 0) * absentDeductionRate).toFixed(2)),
        lateDeduction: Number((row.late * lateDeductionRate).toFixed(2)),
        unpaidLeaveDeduction: Number(leaveDeductions.toFixed(2)),
        totalDeductions: Number((attendanceDeductions + leaveDeductions).toFixed(2)),
        finalSalary: Number(Math.max(0, monthlySalary + overtimePay - attendanceDeductions - leaveDeductions).toFixed(2)),
      };
      delete row.salary;
    }
    res.json({ month, scheduledDays, holidayDays:holidayWorkingDates.size, holidays, workingDays, shiftStart:settings.shiftStart, shiftEnd:settings.shiftEnd, graceMinutes:settings.graceMinutes, employees:[...byEmployee.values()] });
  } catch(error){ next(error); }
}
