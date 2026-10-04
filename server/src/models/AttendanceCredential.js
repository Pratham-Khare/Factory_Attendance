import mongoose from 'mongoose';

const attendanceCredentialSchema = new mongoose.Schema({
  username:{type:String,required:true,unique:true,trim:true},
  passwordHash:{type:String,required:true},
  email:{type:String,lowercase:true,trim:true,default:''},
  credentialSource:{type:String,enum:['environment','otp'],default:'environment'},
  updatedAt:{type:Date,default:Date.now}
},{timestamps:true});

export default mongoose.model('AttendanceCredential',attendanceCredentialSchema);
