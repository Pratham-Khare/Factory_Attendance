import nodemailer from 'nodemailer';

function getTransporter() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user, pass },
  });
}

export async function sendPasswordOtp({ to, otp, accountType }) {
  const transporter = getTransporter();
  if (!transporter) throw new Error('OTP email service is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS on the server.');
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from,
    to,
    subject: 'Factory Attendance password reset OTP',
    text: `Your ${accountType} password reset OTP is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6"><h2>Factory Attendance</h2><p>Your ${accountType} password reset OTP is:</p><p style="font-size:30px;font-weight:800;letter-spacing:8px">${otp}</p><p>This OTP expires in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p></div>`,
  });
}
