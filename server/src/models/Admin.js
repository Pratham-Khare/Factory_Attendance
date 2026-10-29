import mongoose from 'mongoose';

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  email: { type: String, trim: true, lowercase: true, default: '' },
}, { timestamps: true });

export default mongoose.model('Admin', adminSchema);
