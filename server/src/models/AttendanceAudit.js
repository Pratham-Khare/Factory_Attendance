import mongoose from 'mongoose';

const attendanceAuditSchema = new mongoose.Schema({
  action: { type: String, enum: ['created','updated'], required: true },
  employeeId: { type: String, required: true, index: true },
  date: { type: String, required: true, index: true },
  adminUsername: { type: String, default: 'admin' },
  reason: { type: String, default: '' },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

attendanceAuditSchema.index({ date: 1, createdAt: -1 });
export default mongoose.model('AttendanceAudit', attendanceAuditSchema);
