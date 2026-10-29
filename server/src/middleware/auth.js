import jwt from 'jsonwebtoken';

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Admin login required' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
}

export function requireAttendance(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Attendance login required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'attendance') return res.status(403).json({ message: 'Attendance login required' });
    req.attendance = payload;
    next();
  } catch {
    return res.status(401).json({ message: 'Attendance session expired. Please log in again.' });
  }
}


// Public kiosk access does not require a password. Attendance writes require a short-lived
// signed proof issued only after the server matches a submitted face descriptor.
export function requireFaceMatchProof(req, res, next) {
  const proofToken = req.body?.proofToken;
  if (!proofToken) return res.status(401).json({ message: 'Face verification required. Please scan again.' });
  try {
    const payload = jwt.verify(proofToken, process.env.JWT_SECRET);
    if (payload.purpose !== 'face-attendance' || payload.employeeId !== String(req.body?.employeeId || '')) {
      return res.status(403).json({ message: 'Face verification does not match this employee. Please scan again.' });
    }
    req.faceMatch = payload;
    next();
  } catch {
    return res.status(401).json({ message: 'Face verification expired. Please scan again.' });
  }
}
