import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Admin from '../models/Admin.js';
import AttendanceCredential from '../models/AttendanceCredential.js';
import PasswordOtp from '../models/PasswordOtp.js';
import { sendPasswordOtp } from '../services/emailService.js';

export async function setupStatus(req, res, next) {
  try {
    const count = await Admin.countDocuments();
    res.json({ setupRequired: count === 0 });
  } catch (e) { next(e); }
}

export async function createFirstAdmin(req, res, next) {
  try {
    const count = await Admin.countDocuments();
    if (count > 0) return res.status(409).json({ message: 'An admin account already exists. Please sign in.' });
    const { username, password, email } = req.body;
    const cleanUsername = String(username || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanUsername || !password || !cleanEmail) return res.status(400).json({ message: 'Username, email and password are required' });
    if (cleanUsername.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters' });
    if (String(password).length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) return res.status(400).json({ message: 'Enter a valid email address' });
    const passwordHash = await bcrypt.hash(password, 12);
    const admin = await Admin.create({ username: cleanUsername, email: cleanEmail, passwordHash });
    res.status(201).json({ message: 'Admin account created successfully', admin: { username: admin.username, email: admin.email, role: 'admin' } });
  } catch (e) { next(e); }
}

async function getOrCreateAttendanceCredential() {
  const username = String(process.env.ATTENDANCE_USERNAME || '').trim();
  const password = String(process.env.ATTENDANCE_PASSWORD || '');
  const recoveryEmail = String(process.env.ATTENDANCE_RESET_EMAIL || process.env.SMTP_USER || '').trim().toLowerCase();

  let account = await AttendanceCredential.findOne().sort({ createdAt: 1 });

  if (!account) {
    if (!username || !password) return null;
    const passwordHash = await bcrypt.hash(password, 12);
    return AttendanceCredential.create({
      username,
      passwordHash,
      email: recoveryEmail,
      credentialSource: 'environment',
    });
  }

  // Existing V18/V19 records may have been created from an older set of
  // environment credentials. Until the password is explicitly reset by OTP,
  // the server environment remains the source of truth. This prevents a stale
  // MongoDB credential from causing an unexplained 401 after deployment.
  if (account.credentialSource !== 'otp' && username && password) {
    const passwordMatches = await bcrypt.compare(password, account.passwordHash);
    if (account.username !== username || !passwordMatches) {
      account.username = username;
      account.passwordHash = await bcrypt.hash(password, 12);
    }
    account.credentialSource = 'environment';
  }

  // Allow SMTP_USER to act as the recovery-email fallback for local testing
  // when ATTENDANCE_RESET_EMAIL was not explicitly configured.
  if (!account.email && recoveryEmail) account.email = recoveryEmail;
  await account.save();
  return account;
}

export async function attendanceLogin(req, res, next) {
  try {
    const { username, password } = req.body;
    const account = await getOrCreateAttendanceCredential();
    if (!account) return res.status(503).json({ message: 'Attendance login is not configured. Set ATTENDANCE_USERNAME, ATTENDANCE_PASSWORD and ATTENDANCE_RESET_EMAIL on the server.' });
    if (!username || !password || String(username).trim() !== account.username || !(await bcrypt.compare(String(password), account.passwordHash))) {
      return res.status(401).json({ message: 'Invalid attendance ID or password' });
    }
    const token = jwt.sign({ username: account.username, role: 'attendance' }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, account: { username: account.username, email: account.email, role: 'attendance' } });
  } catch (e) { next(e); }
}

export async function login(req, res, next) {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password are required' });
    const admin = await Admin.findOne({ username: username.trim() });
    if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) return res.status(401).json({ message: 'Invalid username or password' });
    const token = jwt.sign({ id: admin._id.toString(), username: admin.username, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, admin: { username: admin.username, email: admin.email || '', role: 'admin' } });
  } catch (e) { next(e); }
}

function normalizeType(value) {
  return value === 'attendance' ? 'attendance' : 'admin';
}

async function findResetAccount(accountType, identifier) {
  const clean = String(identifier || '').trim();
  if (accountType === 'attendance') {
    const account = await getOrCreateAttendanceCredential();
    if (!account || account.username !== clean) return null;
    return { account, email: account.email };
  }
  const account = await Admin.findOne({ username: clean });
  if (!account) return null;
  const email = account.email || String(process.env.ADMIN_RESET_EMAIL || '').trim().toLowerCase();
  return { account, email };
}

export async function requestPasswordOtp(req, res, next) {
  try {
    const accountType = normalizeType(req.body?.accountType);
    const identifier = String(req.body?.username || '').trim();
    if (!identifier) return res.status(400).json({ message: 'Username is required' });
    const found = await findResetAccount(accountType, identifier);
    if (!found?.email) return res.status(400).json({ message: 'No reset email is configured for this account. Configure the account reset email on the server first.' });
    const otp = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHash('sha256').update(otp).digest('hex');
    await PasswordOtp.deleteMany({ accountType, identifier });
    await PasswordOtp.create({ accountType, identifier, email: found.email, codeHash, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    await sendPasswordOtp({ to: found.email, otp, accountType });
    res.json({ message: `OTP sent to ${found.email.replace(/(^.).*(@.*$)/, '$1••••$2')}` });
  } catch (e) { next(e); }
}

export async function resetPasswordWithOtp(req, res, next) {
  try {
    const accountType = normalizeType(req.body?.accountType);
    const identifier = String(req.body?.username || '').trim();
    const otp = String(req.body?.otp || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!identifier || !/^\d{6}$/.test(otp) || newPassword.length < 6) return res.status(400).json({ message: 'Username, 6-digit OTP and a password of at least 6 characters are required' });
    const record = await PasswordOtp.findOne({ accountType, identifier }).sort({ createdAt: -1 });
    if (!record || record.usedAt || record.expiresAt < new Date()) return res.status(400).json({ message: 'OTP is invalid or expired. Request a new OTP.' });
    if (record.attempts >= 5) return res.status(429).json({ message: 'Too many incorrect OTP attempts. Request a new OTP.' });
    const hash = crypto.createHash('sha256').update(otp).digest('hex');
    if (hash !== record.codeHash) { record.attempts += 1; await record.save(); return res.status(400).json({ message: 'Incorrect OTP' }); }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    if (accountType === 'attendance') {
      const account = await getOrCreateAttendanceCredential();
      if (!account || account.username !== identifier) return res.status(404).json({ message: 'Attendance account not found' });
      account.passwordHash = passwordHash;
      account.credentialSource = 'otp';
      account.updatedAt = new Date();
      await account.save();
    } else {
      const account = await Admin.findOne({ username: identifier });
      if (!account) return res.status(404).json({ message: 'Admin account not found' });
      account.passwordHash = passwordHash;
      await account.save();
    }
    record.usedAt = new Date();
    await record.save();
    res.json({ message: 'Password updated successfully. You can now sign in with the new password.' });
  } catch (e) { next(e); }
}
