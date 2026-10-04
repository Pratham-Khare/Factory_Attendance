import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';

function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }

export async function dashboardSummary(req, res, next) {
  try {
    const date = today();
    const [totalEmployees, attendance] = await Promise.all([
      Employee.countDocuments({ status: 'active' }),
      Attendance.find({ date }).populate('employee', 'name department designation').sort({ checkIn: 1 }),
    ]);
    const present = attendance.filter((x) => x.status === 'present' || x.status === 'late').length;
    const late = attendance.filter((x) => x.status === 'late').length;
    const checkedOut = attendance.filter((x) => x.checkOut).length;
    res.json({ date, stats: { totalEmployees, present, absent: Math.max(totalEmployees - present, 0), late, checkedOut }, attendance });
  } catch (e) { next(e); }
}

export async function employees(req, res, next) {
  try {
    const data = await Employee.find().select('-faceEmbedding').sort({ name: 1 });
    res.json({ employees: data });
  } catch (e) { next(e); }
}
