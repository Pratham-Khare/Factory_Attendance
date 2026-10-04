import FactorySettings from '../models/FactorySettings.js';

const DEFAULTS = {
  shiftStart: '09:00',
  shiftEnd: '18:00',
  graceMinutes: 15,
  halfDayAfter: '13:00',
  minimumFullDayHours: 8,
  workingDays: [1, 2, 3, 4, 5, 6],
  overtimeEnabled: true,
  overtimeAfter: '18:00',
  minimumCheckoutGapMinutes: 30,
};

function clean(input = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (out.graceMinutes !== undefined) out.graceMinutes = Number(out.graceMinutes);
  if (out.minimumFullDayHours !== undefined) out.minimumFullDayHours = Number(out.minimumFullDayHours);
  if (out.minimumCheckoutGapMinutes !== undefined) out.minimumCheckoutGapMinutes = Number(out.minimumCheckoutGapMinutes);
  if (out.workingDays !== undefined) out.workingDays = [...new Set(out.workingDays.map(Number).filter(n => n >= 0 && n <= 6))];
  if (out.overtimeEnabled !== undefined) out.overtimeEnabled = Boolean(out.overtimeEnabled);
  return out;
}

export async function getSettings(req, res, next) {
  try {
    let settings = await FactorySettings.findOne({ key: 'default' }).lean();
    if (!settings) settings = await FactorySettings.create({ key: 'default', ...DEFAULTS });
    res.json({ settings });
  } catch (e) { next(e); }
}

export async function updateSettings(req, res, next) {
  try {
    const patch = clean(req.body);
    if (patch.shiftStart && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.shiftStart)) return res.status(400).json({ message: 'Invalid shift start time' });
    if (patch.shiftEnd && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.shiftEnd)) return res.status(400).json({ message: 'Invalid shift end time' });
    if (patch.halfDayAfter && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.halfDayAfter)) return res.status(400).json({ message: 'Invalid half-day time' });
    if (patch.overtimeAfter && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.overtimeAfter)) return res.status(400).json({ message: 'Invalid overtime time' });
    if (patch.graceMinutes !== undefined && (!Number.isFinite(patch.graceMinutes) || patch.graceMinutes < 0 || patch.graceMinutes > 180)) return res.status(400).json({ message: 'Grace period must be between 0 and 180 minutes' });
    if (patch.minimumFullDayHours !== undefined && (!Number.isFinite(patch.minimumFullDayHours) || patch.minimumFullDayHours < 0 || patch.minimumFullDayHours > 24)) return res.status(400).json({ message: 'Minimum full-day hours must be between 0 and 24' });
    if (patch.minimumCheckoutGapMinutes !== undefined && (!Number.isFinite(patch.minimumCheckoutGapMinutes) || patch.minimumCheckoutGapMinutes < 30 || patch.minimumCheckoutGapMinutes > 1440)) return res.status(400).json({ message: 'Minimum check-in/check-out gap must be between 30 and 1440 minutes' });
    if (patch.workingDays && patch.workingDays.length === 0) return res.status(400).json({ message: 'Select at least one working day' });

    const existing = await FactorySettings.findOne({ key: 'default' });
    let settings;
    if (existing) {
      Object.assign(existing, patch);
      settings = await existing.save();
    } else {
      settings = await FactorySettings.create({ key: 'default', ...DEFAULTS, ...patch });
    }
    settings = settings.toObject ? settings.toObject() : settings;
    res.json({ message: 'Factory settings saved', settings });
  } catch (e) { next(e); }
}
