import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import FactorySettings from '../models/FactorySettings.js';
import Leave from '../models/Leave.js';
import Holiday from '../models/Holiday.js';
import { calculatePayroll } from '../utils/payroll.js';

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
    const unpaidLeaveByEmployee = new Map();
    for (const leave of leaves) {
      if (leave.type !== 'unpaid') continue;
      const dates = dateRange(
        leave.startDate > monthDates[0] ? leave.startDate : monthDates[0],
        leave.endDate < monthDates.at(-1) ? leave.endDate : monthDates.at(-1)
      );
      const set = unpaidLeaveByEmployee.get(leave.employeeId) || new Set();
      dates.forEach(date => {
        const day = Number(date.slice(-2));
        if (isWorkingDay(year, monthNumber, day, workingDays) && !holidayDates.has(date)) set.add(date);
      });
      unpaidLeaveByEmployee.set(leave.employeeId, set);
    }

    const byEmployee = new Map();
    for (const employee of employees) {
      const leaveDates = leaveByEmployee.get(employee.employeeId) || new Set();
      byEmployee.set(employee.employeeId, {
        employeeId: employee.employeeId,
        name: employee.name,
        department: employee.department || '',
        designation: employee.designation || '',
        scheduledDays,
        holidayDays: holidayWorkingDates.size,
        leave: leaveDates.size,
        present: 0,
        late: 0,
        halfDay: 0,
        absent: 0,
        incomplete: 0,
        totalHours: 0,
        overtimeHours: 0,
        records: 0,
        attendanceDetails: [],
        salary: employee.salary || {}
      });
    }

    const workedDatesByEmployee = new Map();
    for (const record of attendance) {
      const row = byEmployee.get(record.employeeId);
      if (!row) continue;
      row.records += 1;
      row.attendanceDetails.push({
        date: record.date,
        checkIn: record.checkIn || null,
        checkOut: record.checkOut || null,
        status: record.status || 'incomplete',
        verificationMethod: record.verificationMethod || '',
        totalHours: Number(durationHours(record.checkIn, record.checkOut).toFixed(2)),
        overtimeHours: Number(Math.max(0, Number(record.overtimeHours || 0)).toFixed(2))
      });
      if (record.checkIn) {
        row.present += 1;
        const workedDates = workedDatesByEmployee.get(record.employeeId) || new Set();
        workedDates.add(record.date);
        workedDatesByEmployee.set(record.employeeId, workedDates);
      }
      if (record.status === 'late') row.late += 1;
      if (record.status === 'half-day') row.halfDay += 1;
      if (record.status === 'incomplete' || (record.checkIn && !record.checkOut)) row.incomplete += 1;
      row.totalHours += durationHours(record.checkIn, record.checkOut);
      row.overtimeHours += Math.max(0, Number(record.overtimeHours || 0));
    }

    // Salary policy:
    // - Daily rate uses scheduled workdays minus factory holidays, not days remaining after leave.
    // - Approved paid/casual/sick/other leave is excluded from the absence count and is not deducted.
    // - Unpaid leave is deducted separately, once per eligible workday.
    // - Absences are already calculated excluding approved leave; never subtract unpaid leave from them again.
    // - A zero custom deduction means use the documented automatic default for half-day/absence/unpaid leave.
    const payableWorkDays = Math.max(0, scheduledDays - holidayWorkingDates.size);
    for (const row of byEmployee.values()) {
      const leaveDates = leaveByEmployee.get(row.employeeId) || new Set();
      const workedDates = workedDatesByEmployee.get(row.employeeId) || new Set();
      const effectiveLeaveDates = [...leaveDates].filter(date => !workedDates.has(date));
      row.leave = effectiveLeaveDates.length;
      row.absent = Math.max(payableWorkDays - row.leave - row.present, 0);
      row.effectiveScheduledDays = Math.max(payableWorkDays - row.leave, 0);
      const creditedAttendanceDays = Math.max(0, row.present - row.halfDay * 0.5);
      row.attendancePercentage = row.effectiveScheduledDays
        ? Number(Math.min(100, (creditedAttendanceDays / row.effectiveScheduledDays) * 100).toFixed(1))
        : 100;
      row.totalHours = Number(row.totalHours.toFixed(2));
      row.overtimeHours = Number(row.overtimeHours.toFixed(2));
      row.attendanceDetails.sort((a, b) => a.date.localeCompare(b.date));

      const salary = row.salary || {};
      const unpaidLeaveDates = unpaidLeaveByEmployee.get(row.employeeId) || new Set();
      const unpaidLeaveDays = [...unpaidLeaveDates].filter(date => !workedDates.has(date)).length;

      row.salaryBreakdown = calculatePayroll({
        monthlySalary: salary.monthlySalary,
        payableWorkDays,
        overtimeHours: row.overtimeHours,
        overtimeRatePerHour: salary.overtimeRatePerHour,
        halfDayCount: row.halfDay,
        absentDays: row.absent,
        lateCount: row.late,
        unpaidLeaveDays,
        halfDayDeductionRate: salary.halfDayDeduction,
        absentDeductionRate: salary.absentDeduction,
        lateDeductionRate: salary.lateDeduction,
        unpaidLeaveDeductionRate: salary.unpaidLeaveDeduction
      });
      delete row.salary;
    }
    res.json({ month, scheduledDays, holidayDays:holidayWorkingDates.size, holidays, workingDays, shiftStart:settings.shiftStart, shiftEnd:settings.shiftEnd, graceMinutes:settings.graceMinutes, employees:[...byEmployee.values()] });
  } catch(error){ next(error); }
}
