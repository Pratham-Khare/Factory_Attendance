import mongoose from 'mongoose';

const leaveSchema = new mongoose.Schema({
  employee:{type:mongoose.Schema.Types.ObjectId,ref:'Employee',required:true},
  employeeId:{type:String,required:true,index:true},
  type:{type:String,enum:['casual','sick','paid','unpaid','other'],required:true},
  startDate:{type:String,required:true,index:true},
  endDate:{type:String,required:true,index:true},
  days:{type:Number,required:true,min:1},
  reason:{type:String,default:'',trim:true},
  status:{type:String,enum:['pending','approved','rejected'],default:'pending',index:true},
  adminUsername:{type:String,default:''},
  decisionNote:{type:String,default:'',trim:true}
},{timestamps:true});
leaveSchema.index({employeeId:1,startDate:1,endDate:1});
export default mongoose.model('Leave',leaveSchema);
