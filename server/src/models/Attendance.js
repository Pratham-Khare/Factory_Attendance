import mongoose from 'mongoose';
const attendanceSchema = new mongoose.Schema({
  employee:{type:mongoose.Schema.Types.ObjectId,ref:'Employee',required:true},
  employeeId:{type:String,required:true,index:true},
  date:{type:String,required:true,index:true},
  checkIn:{type:Date},
  checkOut:{type:Date},
  status:{type:String,enum:['present','late','half-day','absent','incomplete'],default:'present'},
  verificationMethod:{type:String,enum:['face','fingerprint','manual'],required:true},
  verificationScore:{type:Number},
  overtimeHours:{type:Number,default:0}
},{timestamps:true});
attendanceSchema.index({employeeId:1,date:1},{unique:true});
export default mongoose.model('Attendance',attendanceSchema);
