import mongoose from 'mongoose';

const holidaySchema = new mongoose.Schema({
  date:{type:String,required:true,unique:true,index:true},
  name:{type:String,required:true,trim:true},
  description:{type:String,default:'',trim:true},
  createdBy:{type:String,default:''}
},{timestamps:true});
export default mongoose.model('Holiday',holidaySchema);
