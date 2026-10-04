import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';

let faceIndex = null;

async function getFaceIndex() {
  if (faceIndex) return faceIndex;
  const employees = await Employee.find({ status: 'active', faceEmbedding: { $exists: true, $ne: [] } })
    .select('+faceEmbedding employeeId name department designation')
    .lean();
  faceIndex = employees.map((employee) => ({
    employeeId: employee.employeeId,
    name: employee.name,
    department: employee.department,
    designation: employee.designation,
    descriptor: employee.faceEmbedding,
  }));
  return faceIndex;
}

export function invalidateFaceIndex() {
  faceIndex = null;
}

function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Number(a[i]) - Number(b[i]);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function normalizeSalary(input = {}) {
  const keys = ['monthlySalary','overtimeRatePerHour','halfDayDeduction','absentDeduction','lateDeduction','unpaidLeaveDeduction'];
  const salary = {};
  for (const key of keys) {
    if (input?.[key] !== undefined && input?.[key] !== '') salary[key] = Math.max(0, Number(input[key]) || 0);
  }
  return salary;
}

export async function createEmployee(req,res,next){
  try{
    const {employeeId,name,department,designation,shift,salary,faceEmbedding}=req.body;
    if(!employeeId||!name) return res.status(400).json({message:'employeeId and name are required'});
    if(faceEmbedding && (!Array.isArray(faceEmbedding) || faceEmbedding.length !== 128))
      return res.status(400).json({message:'faceEmbedding must contain 128 numbers'});
    const employee=await Employee.create({employeeId,name,department,designation,shift,salary:normalizeSalary(salary),faceEmbedding});
    invalidateFaceIndex();
    res.status(201).json({employee});
  }catch(e){
    if(e?.code===11000) return res.status(409).json({message:`Employee ID ${req.body?.employeeId || ''} already exists`.trim()});
    next(e);
  }
}

export async function listEmployees(req,res,next){
  try{
    const employees=await Employee.find().select('-faceEmbedding').sort({name:1});
    res.json({employees});
  }catch(e){next(e)}
}

export async function getEmployeeById(req,res,next){
  try{
    const employee=await Employee.findOne({employeeId:req.params.employeeId}).select('+faceEmbedding');
    if(!employee)return res.status(404).json({message:'Employee not found'});
    res.json({employee});
  }catch(e){next(e)}
}

// Match a live face descriptor against enrolled employee descriptors on the server.
// This keeps the biometric templates out of the browser.
export async function identifyByFace(req,res,next){
  try{
    const {descriptor}=req.body;
    if(!Array.isArray(descriptor) || descriptor.length !== 128)
      return res.status(400).json({message:'A 128-value face descriptor is required'});

    const employees = await getFaceIndex();
    let best = null;
    let bestDistance = Infinity;

    for (const employee of employees) {
      const distance = euclideanDistance(descriptor, employee.descriptor);
      if (distance < bestDistance) {
        best = employee;
        bestDistance = distance;
      }
    }

    const threshold=Number(process.env.FACE_MATCH_THRESHOLD || 0.52);
    if(!best || bestDistance>threshold){
      return res.status(404).json({message:'Face not recognized',distance:bestDistance});
    }

    res.json({
      employee:{
        employeeId:best.employeeId,
        name:best.name,
        department:best.department,
        designation:best.designation
      },
      distance:bestDistance,
      verificationScore:1-bestDistance
    });
  }catch(e){next(e)}
}


export async function updateEmployee(req,res,next){
  try{
    const current = await Employee.findOne({ employeeId:req.params.employeeId }).select('+faceEmbedding');
    if(!current) return res.status(404).json({message:'Employee not found'});
    const {name, department, designation, shift, status, salary, faceEmbedding} = req.body;
    if (name !== undefined) current.name = String(name).trim();
    if (department !== undefined) current.department = String(department).trim();
    if (designation !== undefined) current.designation = String(designation).trim();
    if (shift !== undefined) current.shift = { ...(current.shift?.toObject?.() || current.shift || {}), ...shift };
    if (salary !== undefined) current.salary = normalizeSalary({ ...(current.salary?.toObject?.() || current.salary || {}), ...salary });
    if (status !== undefined) {
      if (!['active','inactive'].includes(status)) return res.status(400).json({message:'Invalid employee status'});
      current.status = status;
    }
    if (faceEmbedding !== undefined) {
      if (!Array.isArray(faceEmbedding) || faceEmbedding.length !== 128) return res.status(400).json({message:'faceEmbedding must contain 128 numbers'});
      current.faceEmbedding = faceEmbedding;
    }
    await current.save();
    invalidateFaceIndex();
    const employee = current.toObject();
    delete employee.faceEmbedding;
    res.json({employee});
  }catch(e){next(e)}
}

export async function employeeAttendanceHistory(req,res,next){
  try{
    const employee = await Employee.findOne({employeeId:req.params.employeeId}).select('employeeId name department status');
    if(!employee) return res.status(404).json({message:'Employee not found'});
    const limit = Math.min(Math.max(Number(req.query.limit || 60), 1), 365);
    const attendance = await Attendance.find({employeeId:employee.employeeId})
      .sort({date:-1})
      .limit(limit)
      .select('date checkIn checkOut status verificationMethod overtimeHours');
    res.json({employee, attendance});
  }catch(e){next(e)}
}
