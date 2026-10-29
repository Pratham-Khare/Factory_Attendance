import mongoose from 'mongoose';

const passwordOtpSchema = new mongoose.Schema({
  accountType:{type:String,enum:['admin','attendance'],required:true,index:true},
  identifier:{type:String,required:true,index:true},
  email:{type:String,required:true,lowercase:true,trim:true},
  codeHash:{type:String,required:true},
  expiresAt:{type:Date,required:true,index:{expires:0}},
  attempts:{type:Number,default:0},
  usedAt:{type:Date}
},{timestamps:true});

passwordOtpSchema.index({accountType:1,identifier:1,createdAt:-1});
export default mongoose.model('PasswordOtp',passwordOtpSchema);
