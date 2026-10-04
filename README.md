# Factory Attendance — V24

Production-ready factory attendance system with mobile-first face attendance, employee management, payroll fields, leave management, reports, and MongoDB Atlas support.

## Included
- Face registration and recognition
- Automatic check-in/check-out
- Employee management and face re-registration
- Attendance management and manual corrections
- Leave and holiday management
- Monthly reports and CSV export
- MongoDB Atlas-ready configuration
- Helmet security headers
- Authentication rate limiting
- Strict production CORS
- Production health endpoint
- Graceful shutdown
- MongoDB connection pool/timeouts

## MongoDB Atlas
1. Create a MongoDB Atlas cluster.
2. Create a database user.
3. Add the backend server's IP/network to Atlas Network Access.
4. Copy the Atlas connection string.
5. Put it in `server/.env` as `MONGO_URI`.
6. Keep the existing database name `factory_attendance` (or change it intentionally).

The application does not reset or seed the database on startup. Existing collections/data are preserved when connecting to the same database.

## Backend
```bash
cd server
npm install
npm start
```

Required production variables:
- `NODE_ENV=production`
- `MONGO_URI=...`
- `CLIENT_URL=https://your-frontend-domain`
- `JWT_SECRET=<32+ random characters>`

## Frontend
```bash
cd client
npm install
npm run dev
```

For a production build, set `VITE_API_URL` to the deployed backend URL ending in `/api`, then run `npm run build`.

## Health check
`GET /api/health` returns HTTP 200 only when MongoDB is connected and 503 otherwise.


## Production entry points
- Employee attendance kiosk: `/attendance` (face recognition automatically marks IN/OUT). `/` also opens the attendance kiosk.
- Administrator: `/admin/login` (protected admin login for employees, attendance, reports, settings, leave and holidays).

The attendance kiosk does not use employee usernames/passwords; the employee's face is the attendance identity.


## Separate entry logins
- Main page `/` shows two options: Attendance Login and Admin Login.
- Attendance Login uses `ATTENDANCE_USERNAME` and `ATTENDANCE_PASSWORD` server environment variables, then opens the face kiosk.
- Admin Login uses the MongoDB-backed admin account.
- Attendance and admin credentials must be different.

## V19 additions
- Full-screen phone attendance kiosk with front/back camera switch and notification-only scan UI.
- Minimum check-in/check-out gap (default 30 minutes) prevents standing in front of the kiosk from immediately creating checkout.
- Employee shift start/end are editable and are used for automatic late status.
- Employee salary settings: monthly salary, overtime rate/hour, half-day, absent, late and unpaid-leave deductions.
- Monthly report calculates base salary, overtime pay, deductions and final salary.
- OTP password reset for admin and attendance accounts via SMTP email.

### OTP email environment
Set these on Render for password recovery:
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` (optional)
- `ADMIN_RESET_EMAIL` (fallback for an older admin account that has no email saved)
- `ATTENDANCE_RESET_EMAIL` (recovery email for the attendance account)

For Gmail, use a Google App Password rather than your normal Gmail password.


## V21 merged release

Retains the supplied V16 face-recognition pipeline (TinyFaceDetector 224 / 0.20, single-face descriptor, server-side matching) while retaining later mobile kiosk, front/back camera, salary/payroll, employee management, attendance management, leave/holidays, OTP recovery, Atlas/production configuration, and the enforced 30-minute minimum checkout gap.


V23 restores the exact V16 face descriptor pipeline (TinyFaceDetector 224 / 0.20 + landmarks + recognition descriptor) for attendance, employee enrollment, and face update. Later mobile/fullscreen/payroll/leave/OTP/30-minute features are retained.
