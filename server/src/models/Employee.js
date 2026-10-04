import mongoose from 'mongoose';

const employeeSchema = new mongoose.Schema({
  employeeId:{type:String,required:true,unique:true,trim:true},
  name:{type:String,required:true,trim:true},
  department:{type:String,default:''},
  designation:{type:String,default:''},
  shift:{start:{type:String,default:'09:00'},end:{type:String,default:'18:00'}},
  salary:{
    monthlySalary:{type:Number,default:0,min:0},
    overtimeRatePerHour:{type:Number,default:0,min:0},
    halfDayDeduction:{type:Number,default:0,min:0},
    absentDeduction:{type:Number,default:0,min:0},
    lateDeduction:{type:Number,default:0,min:0},
    unpaidLeaveDeduction:{type:Number,default:0,min:0}
  },
  faceEmbedding:{type:[Number],default:undefined,select:false},
  status:{type:String,enum:['active','inactive'],default:'active'},
  createdAt:{type:Date,default:Date.now}
});
export default mongoose.model('Employee',employeeSchema);
