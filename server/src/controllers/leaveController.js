import Employee from '../models/Employee.js';
import Leave from '../models/Leave.js';
import Holiday from '../models/Holiday.js';

function validDate(value){ return /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')); }
function toUtcDate(value){ return new Date(`${value}T00:00:00Z`); }
function daysBetween(start,end){ return Math.floor((toUtcDate(end)-toUtcDate(start))/86400000)+1; }
function overlaps(aStart,aEnd,bStart,bEnd){ return aStart<=bEnd && bStart<=aEnd; }

export async function listLeaves(req,res,next){
  try{
    const {month,employeeId,status}=req.query;
    const query={};
    if(employeeId) query.employeeId=employeeId;
    if(status && ['pending','approved','rejected'].includes(status)) query.status=status;
    if(month && /^\d{4}-\d{2}$/.test(month)){
      const start=`${month}-01`;
      const [y,m]=month.split('-').map(Number);
      const last=new Date(Date.UTC(y,m,0)).getUTCDate();
      const end=`${month}-${String(last).padStart(2,'0')}`;
      query.startDate={$lte:end}; query.endDate={$gte:start};
    }
    const leaves=await Leave.find(query).populate('employee','name department designation').sort({startDate:1,createdAt:-1}).lean();
    res.json({leaves});
  }catch(e){next(e);}
}

export async function createLeave(req,res,next){
  try{
    const {employeeId,type,startDate,endDate,reason=''}=req.body;
    if(!employeeId || !['casual','sick','paid','unpaid','other'].includes(type) || !validDate(startDate) || !validDate(endDate)) return res.status(400).json({message:'Employee, leave type, start date and end date are required'});
    if(startDate>endDate) return res.status(400).json({message:'End date cannot be before start date'});
    const days=daysBetween(startDate,endDate);
    const employee=await Employee.findOne({employeeId});
    if(!employee) return res.status(404).json({message:'Employee not found'});
    const conflict=await Leave.findOne({employeeId,status:{$in:['pending','approved']},startDate:{$lte:endDate},endDate:{$gte:startDate}}).lean();
    if(conflict) return res.status(409).json({message:'This employee already has an overlapping pending or approved leave'});
    const leave=await Leave.create({employee:employee._id,employeeId,type,startDate,endDate,days,reason:String(reason||'').trim(),status:'pending'});
    res.status(201).json({message:'Leave request created',leave});
  }catch(e){next(e);}
}

export async function updateLeave(req,res,next){
  try{
    const {id}=req.params;
    const {status,decisionNote=''}=req.body;
    if(!['pending','approved','rejected'].includes(status)) return res.status(400).json({message:'Invalid leave status'});
    const leave=await Leave.findById(id);
    if(!leave) return res.status(404).json({message:'Leave request not found'});
    if(status==='approved'){
      const conflict=await Leave.findOne({_id:{$ne:id},employeeId:leave.employeeId,status:'approved',startDate:{$lte:leave.endDate},endDate:{$gte:leave.startDate}}).lean();
      if(conflict) return res.status(409).json({message:'Another approved leave overlaps this request'});
    }
    leave.status=status;
    leave.adminUsername=req.admin?.username||'admin';
    leave.decisionNote=String(decisionNote||'').trim();
    await leave.save();
    res.json({message:`Leave ${status}`,leave});
  }catch(e){next(e);}
}

export async function deleteLeave(req,res,next){
  try{
    const leave=await Leave.findById(req.params.id);
    if(!leave) return res.status(404).json({message:'Leave request not found'});
    if(leave.status==='approved') return res.status(400).json({message:'Approved leave cannot be deleted. Reject it first.'});
    await leave.deleteOne();
    res.json({message:'Leave request deleted'});
  }catch(e){next(e);}
}

export async function listHolidays(req,res,next){
  try{
    const {year}=req.query;
    const query={};
    if(year && /^\d{4}$/.test(year)) query.date={$regex:`^${year}-`};
    const holidays=await Holiday.find(query).sort({date:1}).lean();
    res.json({holidays});
  }catch(e){next(e);}
}

export async function createHoliday(req,res,next){
  try{
    const {date,name,description=''}=req.body;
    if(!validDate(date) || !String(name||'').trim()) return res.status(400).json({message:'Holiday date and name are required'});
    const existing=await Holiday.findOne({date});
    if(existing) return res.status(409).json({message:'A holiday already exists on this date'});
    const holiday=await Holiday.create({date,name:String(name).trim(),description:String(description||'').trim(),createdBy:req.admin?.username||'admin'});
    res.status(201).json({message:'Holiday added',holiday});
  }catch(e){next(e);}
}

export async function deleteHoliday(req,res,next){
  try{
    const holiday=await Holiday.findByIdAndDelete(req.params.id);
    if(!holiday) return res.status(404).json({message:'Holiday not found'});
    res.json({message:'Holiday deleted'});
  }catch(e){next(e);}
}

export async function employeeLeaveSummary(req,res,next){
  try{
    const {employeeId}=req.params;
    const employee=await Employee.findOne({employeeId}).select('employeeId name department').lean();
    if(!employee) return res.status(404).json({message:'Employee not found'});
    const leaves=await Leave.find({employeeId,status:'approved'}).sort({startDate:-1}).lean();
    const totals={casual:0,sick:0,paid:0,unpaid:0,other:0};
    leaves.forEach(l=>{ totals[l.type]=(totals[l.type]||0)+Number(l.days||0); });
    res.json({employee,totals,approvedDays:leaves.reduce((s,l)=>s+Number(l.days||0),0),leaves});
  }catch(e){next(e);}
}
