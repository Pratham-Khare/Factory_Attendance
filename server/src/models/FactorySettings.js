import mongoose from 'mongoose';

const factorySettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'default' },
  shiftStart: { type: String, default: '09:00' },
  shiftEnd: { type: String, default: '18:00' },
  graceMinutes: { type: Number, default: 15, min: 0, max: 180 },
  halfDayAfter: { type: String, default: '13:00' },
  minimumFullDayHours: { type: Number, default: 8, min: 0, max: 24 },
  workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
  overtimeEnabled: { type: Boolean, default: true },
  overtimeAfter: { type: String, default: '18:00' },
  minimumCheckoutGapMinutes: { type: Number, default: 30, min: 1, max: 1440 },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.model('FactorySettings', factorySettingsSchema);
