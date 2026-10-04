import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as faceapi from 'face-api.js';
import './styles.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';

async function loadModels() {
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
}

async function getDescriptor(video) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.20 });
  return await faceapi.detectSingleFace(video, options).withFaceLandmarks().withFaceDescriptor();
}

async function getDescriptorWithRetry(video, attempts = 2, delayMs = 70) {
  for (let i = 0; i < attempts; i += 1) {
    const descriptor = await getDescriptor(video);
    if (descriptor) return descriptor;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function api(path, options = {}) {
  const { authTokenKey, ...fetchOptions } = options;
  const defaultTokenKey = location.pathname.startsWith('/admin') || location.pathname === '/enroll' ? 'fa_admin_token' : 'fa_attendance_token';
  const token = authTokenKey === '' ? null : localStorage.getItem(authTokenKey || defaultTokenKey);
  const response = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(fetchOptions.headers || {}) },
    ...fetchOptions,
  });
  let data = {};
  try { data = await response.json(); } catch { /* ignore empty responses */ }
  if (!response.ok) {
    const error = new Error(data.message || 'Request failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function formatTime(value = new Date()) {
  return new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

function speakNotification(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text || 'Notification').toUpperCase());
    utterance.rate = 0.86;
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  } catch { /* optional */ }
}

async function unlockAttendanceAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    const ctx = window.__factoryAttendanceAudioContext || (window.__factoryAttendanceAudioContext = new AudioContext());
    if (ctx.state === 'suspended') await ctx.resume();
    // A silent buffer makes the browser treat subsequent WebAudio playback as user-unlocked.
    if (ctx.state === 'running') {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    }
    window.__factoryAttendanceAudioUnlocked = ctx.state === 'running';
    return window.__factoryAttendanceAudioUnlocked;
  } catch {
    return false;
  }
}

async function playTone(kind = 'success') {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = window.__factoryAttendanceAudioContext || (window.__factoryAttendanceAudioContext = new AudioContext());
    if (ctx.state === 'suspended') await ctx.resume();
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime + 0.02;
    const isSuccess = kind === 'success';
    const frequencies = isSuccess ? [660, 880, 1046, 1320] : [330, 247, 196];
    const step = isSuccess ? 0.13 : 0.12;
    const duration = isSuccess ? 0.30 : 0.24;
    const total = frequencies.length * step + duration;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(isSuccess ? 0.88 : 0.72, now + 0.025);
    master.gain.setValueAtTime(isSuccess ? 0.72 : 0.58, now + total - 0.12);
    master.gain.exponentialRampToValueAtTime(0.0001, now + total);
    master.connect(ctx.destination);

    frequencies.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = isSuccess ? 'sine' : 'square';
      oscillator.frequency.setValueAtTime(frequency, now + index * step);
      gain.gain.setValueAtTime(0.0001, now + index * step);
      gain.gain.exponentialRampToValueAtTime(0.9, now + index * step + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * step + duration);
      oscillator.connect(gain);
      gain.connect(master);
      oscillator.start(now + index * step);
      oscillator.stop(now + index * step + duration + 0.02);
    });
    window.navigator?.vibrate?.(isSuccess ? [120, 70, 180] : [180, 90, 180]);
  } catch { /* audio is optional */ }
}


function Camera({ onReady, compact = false, fullscreen = false }) {
  const videoRef = useRef(null);
  const [cameraError, setCameraError] = useState('');
  const [facingMode, setFacingMode] = useState('user');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let stream;
    let active = true;
    setCameraError('');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode }, width: { ideal: 720, max: 1280 }, height: { ideal: 540, max: 720 }, frameRate: { ideal: 24, max: 30 } },
          audio: false,
        });
        if (!active || !videoRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const video = videoRef.current;
        video.srcObject = stream;
        if (video.readyState < 2) {
          await new Promise((resolve) => {
            const done = () => { video.removeEventListener('loadedmetadata', done); resolve(); };
            video.addEventListener('loadedmetadata', done, { once: true });
          });
        }
        await video.play();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (active) onReady(video);
      } catch (error) {
        setCameraError(error?.message || 'Camera access failed');
        onReady(null, error);
      } finally {
        setSwitching(false);
      }
    })();
    return () => {
      active = false;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [facingMode, onReady]);

  const switchCamera = () => {
    setSwitching(true);
    setFacingMode((current) => current === 'user' ? 'environment' : 'user');
  };

  return (
    <div className={`camera-shell ${compact ? 'camera-compact' : ''} ${fullscreen ? 'camera-fullscreen' : ''}`}>
      <video ref={videoRef} muted playsInline autoPlay className="video" />
      <div className="camera-vignette" />
      <div className="face-frame" aria-hidden="true">
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />
      </div>
      <div className="camera-label"><span className="live-dot" /> {facingMode === 'user' ? 'Front camera' : 'Back camera'}</div>
      <button type="button" className="camera-switch" onClick={switchCamera} disabled={switching} aria-label="Switch camera">
        {switching ? 'Switching…' : `↻ ${facingMode === 'user' ? 'Back' : 'Front'}`}
      </button>
      {cameraError && <div className="camera-error">📷 {cameraError}</div>}
    </div>
  );
}

// Notification audio is intentionally rate-limited so a noisy kiosk cannot keep
// beeping/speaking when repeated scans or rapid state changes occur. A notification
// is audible once, then the next audible notification is allowed after 25 seconds.
const NOTIFICATION_AUDIO_COOLDOWN_MS = 25_000;
let lastNotificationAudioAt = 0;
let lastNotificationAudioKey = '';

function playNotificationAudioOnce(toast) {
  const now = Date.now();
  const key = `${toast?.type || 'info'}|${toast?.title || ''}|${toast?.message || ''}`;

  // Ignore duplicate audio for the same notification even if React remounts the toast.
  if (key === lastNotificationAudioKey && now - lastNotificationAudioAt < NOTIFICATION_AUDIO_COOLDOWN_MS) return;
  // After any notification sound, keep the kiosk quiet for ~25 seconds.
  if (now - lastNotificationAudioAt < NOTIFICATION_AUDIO_COOLDOWN_MS) return;

  lastNotificationAudioAt = now;
  lastNotificationAudioKey = key;
  const kind = toast?.type === 'success' ? 'success' : 'warning';
  void playTone(kind);
  const spoken = [toast?.title, toast?.message].filter(Boolean).join('. ');
  speakNotification(spoken || 'Notification');
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    playNotificationAudioOnce(toast);
    const timer = setTimeout(onClose, 4200);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;
  const icon = toast.type === 'success' ? '✓' : toast.type === 'warning' ? '!' : '×';
  return (
    <div className={`toast toast-${toast.type}`} role="status">
      <div className="toast-icon">{icon}</div>
      <div className="toast-copy">
        <strong>{toast.title}</strong>
        <span>{toast.message}</span>
      </div>
      <button className="toast-close" onClick={onClose} aria-label="Close notification">×</button>
    </div>
  );
}

function Kiosk() {
  const [loaded, setLoaded] = useState(false);
  const [video, setVideo] = useState(null);
  const [scannerState, setScannerState] = useState('loading');
  const [toast, setToast] = useState(null);
  const scanningRef = useRef(false);
  const cooldownRef = useRef(false);
  const scanGateRef = useRef(new Map());
  const wakeLockRef = useRef(null);

  useEffect(() => {
    document.body.classList.add('kiosk-active');
    const enterFullscreen = async () => {
      try {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      } catch { /* browsers may require a user gesture */ }
    };
    enterFullscreen();
    return () => {
      document.body.classList.remove('kiosk-active');
      try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch { /* ignore */ }
    };
  }, []);

  useEffect(() => {
    const unlockAudio = () => {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = window.__factoryAttendanceAudioContext || (window.__factoryAttendanceAudioContext = new AudioContext());
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      } catch { /* optional */ }
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch { /* optional */ }
    };
    const handleVisibility = () => { if (document.visibilityState === 'visible' && active) requestWakeLock(); };
    requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      wakeLockRef.current?.release?.().catch?.(() => {});
      wakeLockRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await loadModels();
        if (!active) return;
        setLoaded(true);
        setScannerState('ready');
      } catch (error) {
        if (active) setScannerState('error');
      }
    })();
    return () => { active = false; };
  }, []);

  const handleCamera = useCallback((stream, error) => {
    if (error) setScannerState('error');
    else if (stream) { setVideo(stream); setScannerState('ready'); }
  }, []);

  const scanOnce = useCallback(async () => {
    if (!loaded || !video || scanningRef.current || cooldownRef.current) return;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    scanningRef.current = true;
    setScannerState('scanning');

    try {
      // Stable scanner path used by the earlier working kiosk: TinyFaceDetector
      // 224 / 0.20, one detection per scan, then server-side face matching.
      const descriptor = await getDescriptorWithRetry(video, 5, 140, 'enrollment');
      if (!descriptor) {
        setScannerState('ready');
        return;
      }

      const match = await api('/employees/identify-face', {
        authTokenKey: 'fa_attendance_token',
        method: 'POST',
        body: JSON.stringify({ descriptor: Array.from(descriptor.descriptor) }),
      });

      const employee = match.employee;
      const gateUntil = scanGateRef.current.get(employee.employeeId) || 0;
      if (Date.now() < gateUntil) { setScannerState('ready'); return; }

      const payload = {
        employeeId: employee.employeeId,
        verificationMethod: 'face',
        verificationScore: match.verificationScore,
      };

      let action;
      try {
        action = await api('/attendance/check-in', {
          authTokenKey: 'fa_attendance_token',
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (error.status === 409 && /already checked in/i.test(error.message)) {
          try {
            action = await api('/attendance/check-out', {
              authTokenKey: 'fa_attendance_token',
              method: 'POST',
              body: JSON.stringify(payload),
            });
          } catch (checkoutError) {
            if (checkoutError.status === 409 && checkoutError.data?.code === 'CHECKOUT_TOO_SOON') {
              const remaining = Math.max(Number(checkoutError.data.remainingMinutes || 30), 1);
              scanGateRef.current.set(employee.employeeId, Date.now() + remaining * 60000);
              setToast({ type:'warning', title:'CHECK-OUT NOT AVAILABLE YET', message:`Check-out available in ${remaining} minute${remaining === 1 ? '' : 's'}.` });
              setScannerState('warning');
              setTimeout(() => setScannerState('ready'), 1800);
              return;
            }
            throw checkoutError;
          }
        } else throw error;
      }

      const isCheckout = /check-out/i.test(action.message || '');
      const employeeInfo = action.employee || employee;
      setToast({
        type:'success',
        title:isCheckout ? 'CHECK-OUT SUCCESSFUL' : 'CHECK-IN SUCCESSFUL',
        message:`${employeeInfo.name} • ${isCheckout ? 'Checkout' : 'Check-in'} recorded successfully.`,
      });
      setScannerState(isCheckout ? 'checkout-success' : 'checkin-success');
      // Keep the same employee from immediately retriggering after a successful scan.
      scanGateRef.current.set(employeeInfo.employeeId, Date.now() + (isCheckout ? 2 * 60 * 1000 : 30 * 60 * 1000));
      cooldownRef.current = true;
      setTimeout(() => { cooldownRef.current = false; setScannerState('ready'); }, 2800);
    } catch (error) {
      if (error.status === 404 && /face not recognized/i.test(error.message)) {
        setToast({ type:'warning', title:'FACE NOT RECOGNIZED', message:'Please face the camera clearly and try again.' });
        setScannerState('warning');
        setTimeout(() => setScannerState('ready'), 1600);
      } else if (error.status === 401) {
        localStorage.removeItem('fa_attendance_token');
        window.location.href='/attendance/login';
      } else {
        setToast({ type:'warning', title:'ATTENDANCE FAILED', message:error.message || 'Please try again.' });
        setScannerState('warning');
        setTimeout(() => setScannerState('ready'), 1600);
      }
      setScannerState('ready');
    } finally {
      scanningRef.current = false;
    }
  }, [loaded, video]);

  useEffect(() => {
    const timer = setInterval(scanOnce, 300);
    return () => clearInterval(timer);
  }, [scanOnce]);

  return (
    <main className="kiosk-page kiosk-fullscreen-page">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="kiosk-camera-only">
        <Camera onReady={handleCamera} fullscreen />
        <div className={`kiosk-status-overlay ${scannerState === 'error' ? 'kiosk-error-overlay' : ''}`}>
          {scannerState === 'loading' && 'STARTING CAMERA'}
          {scannerState === 'ready' && 'LOOK AT THE CAMERA'}
          {scannerState === 'scanning' && 'CHECKING ATTENDANCE'}
          {scannerState === 'checkin-success' && 'CHECK-IN SUCCESSFUL'}
          {scannerState === 'checkout-success' && 'CHECK-OUT SUCCESSFUL'}
          {scannerState === 'warning' && 'PLEASE TRY AGAIN'}
          {scannerState === 'error' && 'CAMERA PERMISSION REQUIRED'}
        </div>
      </div>
    </main>
  );
}

function Enroll() {
  const initialForm = { employeeId: '', name: '', department: '', designation: '', shift:{start:'09:00',end:'18:00'}, salary:{monthlySalary:'',overtimeRatePerHour:'',halfDayDeduction:'',absentDeduction:'',lateDeduction:'',unpaidLeaveDeduction:''} };
  const [step, setStep] = useState(1);
  const [video, setVideo] = useState(null);
  const [form, setForm] = useState(initialForm);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [faceStatus, setFaceStatus] = useState('Position your face inside the frame');
  const wakeLockRef = useRef(null);

  useEffect(() => {
    document.body.classList.add('enroll-active');
    return () => document.body.classList.remove('enroll-active');
  }, []);

  useEffect(() => {
    if (step !== 2) return undefined;
    let active = true;
    loadModels().then(() => setLoaded(true)).catch((error) => setToast({ type: 'warning', title: 'Face scanner unavailable', message: error.message }));
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLockRef.current = await navigator.wakeLock.request('screen');
      } catch { /* optional */ }
    };
    requestWakeLock();
    const handleVisibility = () => { if (document.visibilityState === 'visible' && active) requestWakeLock(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      wakeLockRef.current?.release?.().catch?.(() => {});
      wakeLockRef.current = null;
      try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch { /* ignore */ }
    };
  }, [step]);

  useEffect(() => {
    if (step !== 2 || !video || !loaded) return undefined;
    let active = true;
    const timer = setInterval(async () => {
      if (!active || saving) return;
      try {
        const descriptor = await getDescriptor(video);
        if (active) setFaceStatus(descriptor ? 'Face detected — ready to capture' : 'Looking for a clear face…');
      } catch {
        if (active) setFaceStatus('Adjust your position and lighting');
      }
    }, 300);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [video, loaded, saving, step]);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const updateShift = (patch) => setForm((current) => ({ ...current, shift: { ...current.shift, ...patch } }));
  const updateSalary = (patch) => setForm((current) => ({ ...current, salary: { ...current.salary, ...patch } }));

  const continueToFace = () => {
    if (!form.employeeId.trim() || !form.name.trim()) {
      setToast({ type: 'warning', title: 'DETAILS REQUIRED', message: 'Employee ID and full name are required before face capture.' });
      return;
    }
    setToast(null);
    setFaceStatus('Position your face inside the frame');
    try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch { /* browser may require/deny fullscreen */ }
    setStep(2);
  };

  const capture = async () => {
    if (!video || saving) return;
    setSaving(true);
    try {
      const descriptor = await getDescriptorWithRetry(video, 5, 140);
      if (!descriptor) throw new Error('No clear face detected. Move closer, center your face in the frame, and make sure your face is well lit.');
      await api('/employees', {
        method: 'POST',
        body: JSON.stringify({ ...form, faceEmbedding: Array.from(descriptor.descriptor) }),
      });
      setToast({ type: 'success', title: 'EMPLOYEE REGISTERED SUCCESSFULLY', message: `${form.name} (${form.employeeId}) is ready for attendance.` });
      setForm(initialForm);
      setVideo(null);
      setStep(1);
    } catch (error) {
      setToast({ type: 'warning', title: error.status === 409 ? 'EMPLOYEE ID ALREADY EXISTS' : 'REGISTRATION FAILED', message: error.message });
    } finally {
      setSaving(false);
    }
  };

  if (step === 2) {
    return (
      <main className="enroll-capture-page">
        <Toast toast={toast} onClose={() => setToast(null)} />
        <Camera onReady={setVideo} fullscreen />
        <div className="enroll-capture-top">
          <div><span className="admin-kicker">STEP 2 OF 2 · FACE CAPTURE</span><strong>{form.name}</strong><small>{form.employeeId} · {form.department || 'No department'}</small></div>
          <button type="button" className="capture-back-button" onClick={() => { setVideo(null); setStep(1); }}>← Edit details</button>
        </div>
        <div className="enroll-capture-guide">
          <div className={`enroll-face-status ${faceStatus.startsWith('Face detected') ? 'ready' : ''}`}><span className="tip-dot" />{faceStatus}</div>
          <strong>Look straight at the camera</strong>
          <small>Keep one face inside the frame · Good lighting · Remove anything covering the face</small>
          <button className="primary-button capture-face-button" disabled={!loaded || !video || saving || !faceStatus.startsWith('Face detected')} onClick={capture}>{saving ? 'Saving employee…' : 'Capture & register employee'}</button>
        </div>
      </main>
    );
  }

  return (
    <main className="enroll-page">
      <Toast toast={toast} onClose={() => setToast(null)} />
      <div className="enroll-shell">
        <div className="enroll-heading"><div className="brand-mark">FA</div><div><span>ADMIN · STEP 1 OF 2</span><h1>Employee details</h1><p>Enter all employee information first. Face capture comes next.</p></div></div>
        <section className="form-card enroll-details-card">
          <div className="section-title"><span>01</span><div><strong>Employee details</strong><small>Complete all information before opening the camera</small></div></div>
          <div className="enroll-form-grid">
            <label>Employee ID<input value={form.employeeId} onChange={(e) => update({ employeeId: e.target.value })} placeholder="e.g. EMP001" autoComplete="off" /></label>
            <label>Full name<input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="Employee name" autoComplete="name" /></label>
            <label>Department<input value={form.department} onChange={(e) => update({ department: e.target.value })} placeholder="Production" /></label>
            <label>Designation<input value={form.designation} onChange={(e) => update({ designation: e.target.value })} placeholder="Operator" /></label>
            <label>Shift start<input type="time" value={form.shift.start} onChange={e=>updateShift({start:e.target.value})}/></label>
            <label>Shift end<input type="time" value={form.shift.end} onChange={e=>updateShift({end:e.target.value})}/></label>
          </div>
          <div className="salary-section">
            <div className="section-title"><span>02</span><div><strong>Salary & deductions</strong><small>Used for attendance status and monthly final salary</small></div></div>
            <div className="enroll-form-grid salary-enroll-grid">
              <label>Monthly salary (₹)<input type="number" min="0" step="0.01" value={form.salary.monthlySalary} onChange={e=>updateSalary({monthlySalary:e.target.value})} placeholder="30000"/></label>
              <label>Overtime / hour (₹)<input type="number" min="0" step="0.01" value={form.salary.overtimeRatePerHour} onChange={e=>updateSalary({overtimeRatePerHour:e.target.value})} placeholder="150"/></label>
              <label>Half-day deduction (₹)<input type="number" min="0" step="0.01" value={form.salary.halfDayDeduction} onChange={e=>updateSalary({halfDayDeduction:e.target.value})} placeholder="Auto: half daily rate"/></label>
              <label>Absent deduction (₹)<input type="number" min="0" step="0.01" value={form.salary.absentDeduction} onChange={e=>updateSalary({absentDeduction:e.target.value})} placeholder="Auto: daily rate"/></label>
              <label>Late deduction (₹)<input type="number" min="0" step="0.01" value={form.salary.lateDeduction} onChange={e=>updateSalary({lateDeduction:e.target.value})} placeholder="0"/></label>
              <label>Unpaid leave deduction (₹)<input type="number" min="0" step="0.01" value={form.salary.unpaidLeaveDeduction} onChange={e=>updateSalary({unpaidLeaveDeduction:e.target.value})} placeholder="Auto: daily rate"/></label>
            </div>
          </div>
          <div className="enroll-step-actions">
            <button type="button" className="secondary-button" onClick={()=>window.location.href='/admin'}>← Back to dashboard</button>
            <button type="button" className="primary-button" onClick={continueToFace}>Continue to face capture →</button>
          </div>
        </section>
      </div>
    </main>
  );
}

function EntryPage() {
  return <main className="entry-page">
    <section className="entry-shell">
      <div className="entry-brand"><div className="brand-mark">FA</div><div><strong>Factory Attendance</strong><span>Secure attendance management</span></div></div>
      <div className="entry-heading"><div className="admin-kicker">WELCOME</div><h1>Choose how you want to continue</h1><p>Attendance and administration are separated for secure factory use.</p></div>
      <div className="entry-options">
        <button className="entry-card attendance-entry" onClick={()=>window.location.href='/attendance/login'}>
          <div className="entry-icon">✓</div><div><span className="entry-kicker">EMPLOYEE ATTENDANCE</span><h2>Attendance Login</h2><p>Sign in with the attendance ID and password, then use the face scanner to mark IN / OUT.</p><strong>Login for attendance →</strong></div>
        </button>
        <button className="entry-card admin-entry" onClick={()=>window.location.href='/admin/login'}>
          <div className="entry-icon">⚙</div><div><span className="entry-kicker">ADMINISTRATION</span><h2>Admin Login</h2><p>Manage employees, attendance, reports, leaves, holidays and factory settings.</p><strong>Login for admin →</strong></div>
        </button>
      </div>
      <p className="entry-security">🔒 Both areas use separate credentials and separate access permissions.</p>
    </section>
  </main>;
}

function PasswordReset({ accountType, onBack }) {
  const [step, setStep] = useState('request');
  const [username, setUsername] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [toast, setToast] = useState(null);

  const requestOtp = async (e) => {
    e.preventDefault(); setLoading(true); setMessage('');
    try {
      const data = await api('/auth/forgot-password/request-otp', { method:'POST', authTokenKey:'', body:JSON.stringify({ accountType, username }) });
      setMessage(data.message); setStep('verify');
    } catch (error) { setToast({type:'warning',title:'Could not send OTP',message:error.message}); }
    finally { setLoading(false); }
  };
  const reset = async (e) => {
    e.preventDefault(); setLoading(true);
    try {
      const data = await api('/auth/forgot-password/reset', { method:'POST', authTokenKey:'', body:JSON.stringify({accountType,username,otp,newPassword}) });
      setToast({type:'success',title:'Password updated',message:data.message});
      setTimeout(onBack, 1200);
    } catch (error) { setToast({type:'warning',title:'Password reset failed',message:error.message}); }
    finally { setLoading(false); }
  };
  return <main className="admin-page"><Toast toast={toast} onClose={()=>setToast(null)} /><div className="login-card">
    <div className="brand-mark">FA</div><div className="admin-kicker">PASSWORD RECOVERY</div><h1>Reset {accountType === 'admin' ? 'admin' : 'attendance'} password</h1>
    <p>{step==='request' ? 'We will send a one-time code to the registered recovery email.' : message || 'Enter the OTP and choose a new password.'}</p>
    {step==='request' ? <form onSubmit={requestOtp}><label>{accountType==='admin'?'Admin username':'Attendance ID'}<input autoFocus value={username} onChange={e=>setUsername(e.target.value)} placeholder="Enter username" autoComplete="username" /></label><button className="primary-button" disabled={loading||!username}>{loading?'Sending OTP…':'Send OTP →'}</button></form> : <form onSubmit={reset}><label>6-digit OTP<input autoFocus inputMode="numeric" maxLength="6" value={otp} onChange={e=>setOtp(e.target.value.replace(/\D/g,''))} placeholder="123456" /></label><label>New password<input type="password" minLength="6" value={newPassword} onChange={e=>setNewPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" /></label><button className="primary-button" disabled={loading||otp.length!==6||newPassword.length<6}>{loading?'Updating…':'Update password →'}</button><button type="button" className="login-switch" onClick={()=>{setStep('request');setOtp('');setNewPassword('');}}>Request a new OTP</button></form>}
    <button className="login-back" onClick={onBack}>← Back to login</button>
  </div></main>;
}

function AttendanceLogin() {
  const [form, setForm] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [forgot, setForgot] = useState(false);
  if (forgot) return <PasswordReset accountType="attendance" onBack={()=>setForgot(false)} />;
  const submit = async (e) => {
    e.preventDefault(); setLoading(true);
    try {
      const data = await api('/auth/attendance-login', { method:'POST', body:JSON.stringify(form), authTokenKey:'' });
      localStorage.setItem('fa_attendance_token', data.token); localStorage.removeItem('fa_admin_token'); window.location.href='/attendance';
    } catch (error) { setToast({type:'warning',title:'Attendance login failed',message:error.message}); }
    finally { setLoading(false); }
  };
  return <main className="admin-page"><Toast toast={toast} onClose={()=>setToast(null)} /><div className="login-card"><div className="brand-mark">FA</div><div className="admin-kicker">EMPLOYEE ATTENDANCE</div><h1>Attendance login</h1><p>Sign in to open the factory face-attendance scanner.</p><form onSubmit={submit}><label>Attendance ID<input autoFocus value={form.username} onChange={e=>setForm({...form,username:e.target.value})} placeholder="Enter attendance ID" autoComplete="username" /></label><label>Password<input type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} placeholder="Enter attendance password" autoComplete="current-password" /></label><button className="primary-button" disabled={loading||!form.username||!form.password}>{loading?'Signing in…':'Open attendance scanner →'}</button></form><button className="login-switch" onClick={()=>setForgot(true)}>Forgot password?</button><button className="login-switch" onClick={()=>window.location.href='/admin/login'}>Go to Admin Login</button><button className="login-back" onClick={()=>window.location.href='/'}>← Back to main page</button></div></main>;
}

function AdminLogin() {
  const [mode, setMode] = useState('loading');
  const [form, setForm] = useState({ username:'', email:'', password:'', confirmPassword:'' });
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [forgot, setForgot] = useState(false);

  useEffect(() => { api('/auth/setup-status').then(data=>setMode(data.setupRequired?'setup':'login')).catch(()=>setMode('login')); }, []);
  if (forgot) return <PasswordReset accountType="admin" onBack={()=>setForgot(false)} />;

  const submitLogin = async (e) => { e.preventDefault(); setLoading(true); try { const data=await api('/auth/login',{method:'POST',body:JSON.stringify({username:form.username,password:form.password})}); localStorage.setItem('fa_admin_token',data.token); window.location.href='/admin'; } catch(error){setToast({type:'warning',title:'Login failed',message:error.message});} finally{setLoading(false);} };
  const submitSetup = async (e) => { e.preventDefault(); if(form.password!==form.confirmPassword){setToast({type:'warning',title:'Passwords do not match',message:'Enter the same password in both fields.'});return;} setLoading(true); try { await api('/auth/setup',{method:'POST',body:JSON.stringify({username:form.username,email:form.email,password:form.password})}); setToast({type:'success',title:'Admin account created',message:'Your account is ready. You can sign in now.'}); setMode('login'); setForm({username:form.username,email:form.email,password:'',confirmPassword:''}); } catch(error){setToast({type:'warning',title:'Account creation failed',message:error.message});} finally{setLoading(false);} };
  if(mode==='loading') return <main className="admin-page"><div className="login-card"><div className="brand-mark">FA</div><div className="admin-kicker">FACTORY ATTENDANCE</div><h1>Checking setup…</h1><p>Preparing your administrator access.</p></div></main>;
  const isSetup=mode==='setup';
  return <main className="admin-page"><Toast toast={toast} onClose={()=>setToast(null)} /><div className="login-card"><div className="brand-mark">FA</div><div className="admin-kicker">FACTORY ATTENDANCE</div><h1>{isSetup?'Create your admin account':'Admin sign in'}</h1><p>{isSetup?'Create the administrator account and recovery email for OTP password resets.':'Manage employees, attendance and reports.'}</p><form onSubmit={isSetup?submitSetup:submitLogin}><label>Username<input autoFocus value={form.username} onChange={e=>setForm({...form,username:e.target.value})} placeholder="e.g. factoryadmin" autoComplete="username" /></label>{isSetup&&<label>Recovery email<input type="email" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="admin@example.com" autoComplete="email" /></label>}<label>Password<input type="password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} placeholder="At least 6 characters" autoComplete={isSetup?'new-password':'current-password'} /></label>{isSetup&&<label>Confirm password<input type="password" value={form.confirmPassword} onChange={e=>setForm({...form,confirmPassword:e.target.value})} placeholder="Enter password again" autoComplete="new-password" /></label>}<button className="primary-button" disabled={loading||!form.username||!form.password||(isSetup&&(!form.email||!form.confirmPassword))}>{loading?(isSetup?'Creating account…':'Signing in…'):(isSetup?'Create admin account →':'Sign in →')}</button></form>{!isSetup&&<button className="login-switch" onClick={()=>setForgot(true)}>Forgot password?</button>}{isSetup&&<div className="setup-note"><span>🔒</span><div><strong>One-time setup</strong><small>Keep this recovery email accessible. OTP password reset uses it.</small></div></div>}<button className="login-back" onClick={()=>window.location.href='/'}>← Back to main page</button></div></main>;
}

function AdminTopbar({ subtitle, logout, onExport = null }) {
  const [open, setOpen] = useState(false);
  const navigate = (path) => { setOpen(false); window.location.href = path; };
  const items = [
    ['/admin', 'Dashboard'],
    ['/admin/employees', 'Employees'],
    ['/admin/attendance', 'Attendance'],
    ['/admin/reports', 'Monthly report'],
    ['/admin/settings', 'Settings'],
    ['/admin/leave', 'Leave & holidays'],
    ['/enroll', '+ Register employee'],
  ];
  return (
    <header className="admin-topbar">
      <div className="brand"><div className="brand-mark">FA</div><div><strong>Factory Attendance</strong><span>{subtitle}</span></div></div>
      <button type="button" className="mobile-menu-button" onClick={() => setOpen(v => !v)} aria-label="Open navigation menu" aria-expanded={open}>☰</button>
      <div className={`admin-actions ${open ? 'mobile-open' : ''}`}>
        {items.map(([path, label]) => <button key={path} onClick={() => navigate(path)}>{label}</button>)}
        {onExport && <button onClick={() => { setOpen(false); onExport(); }}>Export CSV</button>}
        <button className="ghost" onClick={() => { setOpen(false); logout(); }}>Logout</button>
      </div>
    </header>
  );
}

function AdminDashboard() {
  const [data, setData] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [summary, emp] = await Promise.all([api('/dashboard/summary'), api('/dashboard/employees')]);
      setData(summary); setEmployees(emp.employees);
    } catch (error) {
      if (error.status === 401) { localStorage.removeItem('fa_admin_token'); window.location.href='/admin/login'; return; }
      setToast({ type:'warning', title:'Could not load dashboard', message:error.message });
    } finally { setLoading(false); }
  }, []);
  useEffect(()=>{ load(); }, [load]);
  const logout=()=>{ localStorage.removeItem('fa_admin_token'); window.location.href='/admin/login'; };
  const csv=()=>{
    const rows=[['Employee ID','Name','Department','Date','Check In','Check Out','Status','Verification']];
    (data?.attendance||[]).forEach(r=>rows.push([r.employeeId,r.employee?.name||'',r.employee?.department||'',r.date,r.checkIn?new Date(r.checkIn).toLocaleTimeString('en-IN'): '',r.checkOut?new Date(r.checkOut).toLocaleTimeString('en-IN'):'',r.status,r.verificationMethod||'']));
    const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;
    const blob=new Blob([rows.map(r=>r.map(esc).join(',')).join('\n')],{type:'text/csv;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`attendance-${data?.date||'today'}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  return <main className="admin-dashboard"><Toast toast={toast} onClose={()=>setToast(null)} /><AdminTopbar subtitle="Admin dashboard" logout={logout} onExport={csv} />
    <section className="dashboard-shell"><div className="dashboard-heading"><div><div className="admin-kicker">TODAY'S OVERVIEW</div><h1>Attendance at a glance</h1><p>{data?.date||'Loading…'} · Refresh anytime to see the latest scans.</p></div><button className="refresh-button" onClick={load}>↻ Refresh</button></div>
      <div className="stat-grid"><div className="stat-card"><span>Total employees</span><strong>{data?.stats.totalEmployees??'—'}</strong></div><div className="stat-card"><span>Present</span><strong>{data?.stats.present??'—'}</strong></div><div className="stat-card"><span>Late</span><strong>{data?.stats.late??'—'}</strong></div><div className="stat-card"><span>Absent</span><strong>{data?.stats.absent??'—'}</strong></div><div className="stat-card"><span>Checked out</span><strong>{data?.stats.checkedOut??'—'}</strong></div></div>
      <div className="dashboard-grid"><section className="table-card"><div className="card-heading"><div><strong>Today's attendance</strong><small>Live records from the kiosk</small></div><span>{data?.attendance?.length||0} records</span></div>{loading?<div className="empty-state">Loading attendance…</div>:data?.attendance?.length?<div className="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>IN</th><th>OUT</th><th>Status</th></tr></thead><tbody>{data.attendance.map(r=><tr key={r._id}><td><strong>{r.employee?.name||r.employeeId}</strong><small>{r.employeeId}</small></td><td>{r.employee?.department||'—'}</td><td>{r.checkIn?new Date(r.checkIn).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—'}</td><td>{r.checkOut?new Date(r.checkOut).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—'}</td><td><span className={`status-tag ${r.status}`}>{r.status}</span></td></tr>)}</tbody></table></div>:<div className="empty-state">No attendance recorded yet today.</div>}</section>
      <section className="table-card"><div className="card-heading"><div><strong>Employees</strong><small>Registered workforce</small></div><span>{employees.length}</span></div><div className="employee-list">{employees.slice(0,12).map(e=><div className="employee-row" key={e.employeeId}><div className="avatar">{e.name?.slice(0,1).toUpperCase()}</div><div><strong>{e.name}</strong><small>{e.employeeId} · {e.department||'No department'}</small></div><span className={e.status==='active'?'active-dot':'inactive-dot'}>{e.status}</span></div>)}</div>{employees.length>12&&<div className="more-note">Showing first 12 employees.</div>}</section></div>
    </section>
  </main>;
}


function MonthlyReport() {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api(`/reports/monthly/${month}`)); }
    catch (error) { if (error.status === 401) { localStorage.removeItem('fa_admin_token'); window.location.href='/admin/login'; return; } setToast({type:'warning',title:'Report failed',message:error.message}); }
    finally { setLoading(false); }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    if (!data) return;
    const rows = [['Employee ID','Name','Department','Scheduled Days','Holidays','Leave Days','Effective Days','Present','Absent','Late','Half Day','Incomplete','Total Hours','Overtime Hours','Attendance %','Base Salary','OT Pay','Deductions','Final Salary']];
    data.employees.forEach(r => rows.push([r.employeeId,r.name,r.department,r.scheduledDays,r.holidayDays,r.leave,r.effectiveScheduledDays,r.present,r.absent,r.late,r.halfDay,r.incomplete,r.totalHours,r.overtimeHours,r.attendancePercentage,r.salaryBreakdown?.monthlySalary||0,r.salaryBreakdown?.overtimePay||0,r.salaryBreakdown?.totalDeductions||0,r.salaryBreakdown?.finalSalary||0]));
    const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;
    const blob=new Blob([rows.map(r=>r.map(esc).join(',')).join('\n')],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`attendance-report-${month}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const logout=()=>{localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';};
  return <main className="report-page">
    <Toast toast={toast} onClose={()=>setToast(null)} />
    <AdminTopbar subtitle="Employee management" logout={logout} />
    <section className="report-shell">
      <div className="report-toolbar"><div className="report-title"><div className="admin-kicker">MANAGEMENT REPORT</div><h1>Monthly attendance</h1><p>Attendance, punctuality and working hours for every active employee.</p></div><div className="month-control"><label>Month<input type="month" value={month} onChange={e=>setMonth(e.target.value)} /></label><button className="report-button" onClick={exportCsv} disabled={!data}>Export CSV</button></div></div>
      {data && <div className="report-meta"><span>{data.scheduledDays} scheduled days</span><span>Sunday = weekly off</span><span>{data.employees.length} active employees</span></div>}
      <section className="report-card"><div className="report-card-head"><div><strong>{month} summary</strong><small>Calculated from recorded IN/OUT attendance</small></div><span>{loading?'Updating…':`${data?.employees.length||0} employees`}</span></div>
      {loading ? <div className="report-empty">Preparing report…</div> : data?.employees?.length ? <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Employee</th><th>Scheduled</th><th>Holiday</th><th>Leave</th><th>Effective</th><th>Present</th><th>Absent</th><th>Late</th><th>Half Day</th><th>Incomplete</th><th>Total Hours</th><th>Overtime</th><th>Attendance</th><th>Base Salary</th><th>OT Pay</th><th>Deductions</th><th>Final Salary</th></tr></thead><tbody>{data.employees.map(r=><tr key={r.employeeId}><td><strong>{r.name}</strong><small>{r.employeeId} · {r.department||'No department'}</small></td><td>{r.scheduledDays}</td><td>{r.holidayDays}</td><td>{r.leave}</td><td>{r.effectiveScheduledDays}</td><td className="metric-good">{r.present}</td><td className={r.absent>0?'metric-bad':''}>{r.absent}</td><td className={r.late>0?'metric-warn':''}>{r.late}</td><td>{r.halfDay}</td><td className={r.incomplete>0?'metric-warn':''}>{r.incomplete}</td><td>{r.totalHours.toFixed(2)}</td><td>{Number(r.overtimeHours||0).toFixed(2)}</td><td className={r.attendancePercentage<75?'metric-bad':r.attendancePercentage<90?'metric-warn':'metric-good'}>{r.attendancePercentage}%</td><td>₹{Number(r.salaryBreakdown?.monthlySalary||0).toFixed(2)}</td><td>₹{Number(r.salaryBreakdown?.overtimePay||0).toFixed(2)}</td><td>₹{Number(r.salaryBreakdown?.totalDeductions||0).toFixed(2)}</td><td><strong>₹{Number(r.salaryBreakdown?.finalSalary||0).toFixed(2)}</strong></td></tr>)}</tbody></table></div> : <div className="report-empty">No active employees found.</div>}</section>
      <p className="report-note">This report uses the factory rules configured under Settings. Working days, grace period, half-day threshold and overtime are applied to attendance calculations.</p>
    </section>
  </main>;
}



function EmployeeManagement(){
  const [employees,setEmployees]=useState([]);
  const [query,setQuery]=useState('');
  const [status,setStatus]=useState('all');
  const [department,setDepartment]=useState('all');
  const [loading,setLoading]=useState(true);
  const [toast,setToast]=useState(null);
  const [editing,setEditing]=useState(null);
  const [history,setHistory]=useState(null);
  const [historyLoading,setHistoryLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [faceUpdate,setFaceUpdate]=useState(null);
  const [faceVideo,setFaceVideo]=useState(null);
  const [faceReady,setFaceReady]=useState(false);
  const [faceSaving,setFaceSaving]=useState(false);

  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const data=await api('/employees');
      setEmployees(data.employees||[]);
    }catch(error){
      if(error.status===401){localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';return;}
      setToast({type:'warning',title:'Employees could not be loaded',message:error.message});
    }finally{setLoading(false);}
  },[]);
  useEffect(()=>{load();},[load]);

  const departments=[...new Set(employees.map(e=>e.department).filter(Boolean))].sort();
  const filtered=employees.filter(e=>{
    const text=`${e.employeeId} ${e.name} ${e.department||''} ${e.designation||''}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (status==='all'||e.status===status) && (department==='all'||e.department===department);
  });

  const save=async(e)=>{
    e.preventDefault(); setSaving(true);
    try{
      const data=await api(`/employees/${editing.employeeId}`,{method:'PUT',body:JSON.stringify({name:editing.name,department:editing.department,designation:editing.designation,status:editing.status,shift:editing.shift,salary:editing.salary})});
      setEmployees(prev=>prev.map(x=>x.employeeId===editing.employeeId?{...x,...data.employee}:x));
      setEditing(null);
      setToast({type:'success',title:'Employee updated',message:`${data.employee.name}'s details were saved successfully.`});
    }catch(error){setToast({type:'warning',title:'Could not update employee',message:error.message});}
    finally{setSaving(false);}
  };

  const toggleStatus=async(employee)=>{
    const next=employee.status==='active'?'inactive':'active';
    try{
      const data=await api(`/employees/${employee.employeeId}`,{method:'PUT',body:JSON.stringify({status:next})});
      setEmployees(prev=>prev.map(x=>x.employeeId===employee.employeeId?{...x,...data.employee}:x));
      setToast({type:'success',title:next==='active'?'Employee reactivated':'Employee deactivated',message:`${employee.name} is now ${next}.`});
    }catch(error){setToast({type:'warning',title:'Status update failed',message:error.message});}
  };

  const openHistory=async(employee)=>{
    setHistory({employee,attendance:[]});setHistoryLoading(true);
    try{const data=await api(`/employees/${employee.employeeId}/attendance?limit=60`);setHistory(data);}catch(error){setToast({type:'warning',title:'History failed',message:error.message});setHistory(null);}finally{setHistoryLoading(false);}
  };

  useEffect(()=>{
    if(!faceUpdate || !faceVideo) return undefined;
    let active=true;
    const timer=setInterval(async()=>{
      if(!active || faceSaving) return;
      try{
        const descriptor=await getDescriptor(faceVideo);
        if(active) setFaceReady(Boolean(descriptor));
      }catch{ if(active) setFaceReady(false); }
    },350);
    return()=>{active=false;clearInterval(timer);};
  },[faceUpdate,faceVideo,faceSaving]);

  const startFaceUpdate=(employee)=>{
    setFaceUpdate(employee);
    setFaceVideo(null);
    setFaceReady(false);
  };

  const closeFaceUpdate=()=>{
    setFaceUpdate(null);
    setFaceVideo(null);
    setFaceReady(false);
    setFaceSaving(false);
  };

  const updateFace=async()=>{
    if(!faceVideo || faceSaving) return;
    setFaceSaving(true);
    try{
      const result=await getDescriptorWithRetry(faceVideo,2,70);
      if(!result) throw new Error('No clear face detected. Move closer, center the face in the frame, and make sure the face is well lit.');
      const data=await api(`/employees/${faceUpdate.employeeId}`,{method:'PUT',body:JSON.stringify({faceEmbedding:Array.from(result.descriptor)})});
      setEmployees(prev=>prev.map(x=>x.employeeId===faceUpdate.employeeId?{...x,...data.employee}:x));
      setToast({type:'success',title:'Face updated successfully',message:`${faceUpdate.name}'s face has been re-enrolled.`});
      closeFaceUpdate();
    }catch(error){
      setToast({type:'warning',title:'Face update failed',message:error.message});
    }finally{setFaceSaving(false);}
  };

  const logout=()=>{localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';};

  return <main className="employee-page">
    <Toast toast={toast} onClose={()=>setToast(null)} />
    <AdminTopbar subtitle="Attendance management" logout={logout} />
    <section className="employee-shell">
      <div className="employee-heading"><div><div className="admin-kicker">WORKFORCE</div><h1>Employees</h1><p>Manage employee details, status and attendance history.</p></div><button className="primary-button compact-primary" onClick={()=>window.location.href='/enroll'}>+ Register employee</button></div>
      <section className="employee-toolbar"><div className="search-box"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search name, ID, department…" /></div><select value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All status</option><option value="active">Active</option><option value="inactive">Inactive</option></select><select value={department} onChange={e=>setDepartment(e.target.value)}><option value="all">All departments</option>{departments.map(d=><option key={d} value={d}>{d}</option>)}</select><button className="refresh-button" onClick={load}>↻ Refresh</button></section>
      <section className="employee-card"><div className="employee-card-head"><div><strong>Registered employees</strong><small>{filtered.length} of {employees.length} employees shown</small></div><div className="employee-counts"><span className="count-active">● {employees.filter(e=>e.status==='active').length} active</span><span>○ {employees.filter(e=>e.status==='inactive').length} inactive</span></div></div>
      {loading?<div className="empty-state">Loading employees…</div>:filtered.length===0?<div className="empty-state"><strong>No employees found</strong><span>Try changing your search or filters.</span></div>:<div className="employee-management-list">{filtered.map(e=><div className="managed-employee" key={e.employeeId}><div className="managed-avatar">{e.name?.slice(0,1).toUpperCase()}</div><div className="managed-main"><strong>{e.name}</strong><span>{e.employeeId} · {e.department||'No department'} · {e.designation||'No designation'}</span></div><span className={`employee-status ${e.status}`}>{e.status}</span><div className="managed-actions"><button onClick={()=>openHistory(e)}>History</button><button onClick={()=>setEditing({...e})}>Edit</button><button className="face-action" onClick={()=>startFaceUpdate(e)}>Update face</button><button className={e.status==='active'?'danger-action':'success-action'} onClick={()=>toggleStatus(e)}>{e.status==='active'?'Deactivate':'Reactivate'}</button></div></div>)}</div>}</section>
      <div className="employee-note"><span>ⓘ</span><div><strong>Deactivating an employee preserves their history.</strong><small>Inactive employees cannot mark attendance, but their previous attendance remains available in reports.</small></div></div>
    </section>

    {editing&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setEditing(null)}}><form className="modal-card" onSubmit={save}><div className="modal-head"><div><div className="admin-kicker">EDIT EMPLOYEE</div><h2>{editing.name}</h2><span>{editing.employeeId}</span></div><button type="button" className="modal-close" onClick={()=>setEditing(null)}>×</button></div><label>Employee name<input value={editing.name||''} onChange={e=>setEditing({...editing,name:e.target.value})}/></label><div className="two-col"><label>Department<input value={editing.department||''} onChange={e=>setEditing({...editing,department:e.target.value})}/></label><label>Designation<input value={editing.designation||''} onChange={e=>setEditing({...editing,designation:e.target.value})}/></label></div><div className="two-col"><label>Shift start<input type="time" value={editing.shift?.start||'09:00'} onChange={e=>setEditing({...editing,shift:{...(editing.shift||{}),start:e.target.value}})}/></label><label>Shift end<input type="time" value={editing.shift?.end||'18:00'} onChange={e=>setEditing({...editing,shift:{...(editing.shift||{}),end:e.target.value}})}/></label></div><div className="salary-grid"><label>Monthly salary (₹)<input type="number" min="0" step="0.01" value={editing.salary?.monthlySalary ?? ''} onChange={e=>setEditing({...editing,salary:{...(editing.salary||{}),monthlySalary:e.target.value}})}/></label><label>Overtime / hour (₹)<input type="number" min="0" step="0.01" value={editing.salary?.overtimeRatePerHour ?? ''} onChange={e=>setEditing({...editing,salary:{...(editing.salary||{}),overtimeRatePerHour:e.target.value}})}/></label><label>Half-day deduction (₹)<input type="number" min="0" step="0.01" value={editing.salary?.halfDayDeduction ?? ''} onChange={e=>setEditing({...editing,salary:{...(editing.salary||{}),halfDayDeduction:e.target.value}})}/></label><label>Absent deduction (₹)<input type="number" min="0" step="0.01" value={editing.salary?.absentDeduction ?? ''} onChange={e=>setEditing({...editing,salary:{...(editing.salary||{}),absentDeduction:e.target.value}})}/></label><label>Late deduction (₹)<input type="number" min="0" step="0.01" value={editing.salary?.lateDeduction ?? ''} onChange={e=>setEditing({...editing,salary:{...(editing.salary||{}),lateDeduction:e.target.value}})}/></label><label>Unpaid leave deduction (₹)<input type="number" min="0" step="0.01" value={editing.salary?.unpaidLeaveDeduction ?? ''} onChange={e=>setEditing({...editing,salary:{...(editing.salary||{}),unpaidLeaveDeduction:e.target.value}})}/></label></div><label>Status<select value={editing.status||'active'} onChange={e=>setEditing({...editing,status:e.target.value})}><option value="active">Active</option><option value="inactive">Inactive</option></select></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setEditing(null)}>Cancel</button><button className="primary-button" disabled={saving}>{saving?'Saving…':'Save changes →'}</button></div></form></div>}

    {faceUpdate&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)closeFaceUpdate()}}><div className="modal-card face-update-modal"><div className="modal-head"><div><div className="admin-kicker">BIOMETRIC UPDATE</div><h2>Update face</h2><span>{faceUpdate.name} · {faceUpdate.employeeId}</span></div><button type="button" className="modal-close" onClick={closeFaceUpdate}>×</button></div><p className="face-update-copy">Replace the existing face template with a new clear capture. The employee ID and attendance history will stay unchanged.</p><Camera onReady={setFaceVideo} compact /><div className={`face-update-status ${faceReady?'ready':''}`}><span />{faceReady?'Face detected — ready to update':'Position the employee face inside the frame'}</div><div className="face-update-tips"><span>• Look straight at the camera</span><span>• Keep only one face visible</span><span>• Use good lighting</span></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={closeFaceUpdate}>Cancel</button><button type="button" className="primary-button" disabled={!faceReady||faceSaving} onClick={updateFace}>{faceSaving?'Updating face…':'Capture & update face →'}</button></div></div></div>}

    {history&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setHistory(null)}}><div className="modal-card history-modal"><div className="modal-head"><div><div className="admin-kicker">ATTENDANCE HISTORY</div><h2>{history.employee.name}</h2><span>{history.employee.employeeId} · {history.employee.department||'No department'}</span></div><button className="modal-close" onClick={()=>setHistory(null)}>×</button></div>{historyLoading?<div className="empty-state">Loading history…</div>:history.attendance?.length?<div className="history-table-wrap"><table><thead><tr><th>Date</th><th>IN</th><th>OUT</th><th>Status</th><th>Overtime</th><th>Method</th></tr></thead><tbody>{history.attendance.map(r=><tr key={r._id}><td>{r.date}</td><td>{r.checkIn?new Date(r.checkIn).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—'}</td><td>{r.checkOut?new Date(r.checkOut).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—'}</td><td><span className={`status-tag ${r.status}`}>{r.status}</span></td><td>{Number(r.overtimeHours||0).toFixed(2)}h</td><td>{r.verificationMethod||'—'}</td></tr>)}</tbody></table></div>:<div className="empty-state">No attendance records found.</div>}</div></div>}
  </main>;
}

function AttendanceManagement(){
  const todayValue=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
  const toInput=(value)=>value?new Date(value).toLocaleString('sv-SE',{timeZone:'Asia/Kolkata'}).replace(' ','T').slice(0,16):'';
  const [date,setDate]=useState(todayValue());
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(true);
  const [query,setQuery]=useState('');
  const [department,setDepartment]=useState('all');
  const [statusFilter,setStatusFilter]=useState('all');
  const [editing,setEditing]=useState(null);
  const [saving,setSaving]=useState(false);
  const [toast,setToast]=useState(null);
  const [auditOpen,setAuditOpen]=useState(false);
  const [audits,setAudits]=useState([]);
  const [auditLoading,setAuditLoading]=useState(false);

  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const data=await api(`/attendance-management/manage?date=${date}`);
      setRows(data.rows||[]);
    }catch(error){
      if(error.status===401){localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';return;}
      setToast({type:'warning',title:'Attendance could not be loaded',message:error.message});
    }finally{setLoading(false);}
  },[date]);
  useEffect(()=>{load();},[load]);

  const departments=[...new Set(rows.map(r=>r.department).filter(Boolean))].sort();
  const filtered=rows.filter(r=>{
    const text=`${r.name} ${r.employeeId} ${r.department} ${r.designation}`.toLowerCase();
    const status=r.attendance?.status || r.specialStatus || 'absent';
    return text.includes(query.toLowerCase()) && (department==='all'||r.department===department) && (statusFilter==='all'||status===statusFilter);
  });
  const counts={present:rows.filter(r=>['present','late'].includes(r.attendance?.status)).length,late:rows.filter(r=>r.attendance?.status==='late').length,half:rows.filter(r=>r.attendance?.status==='half-day').length,leave:rows.filter(r=>!r.attendance&&r.specialStatus==='leave').length,holiday:rows.filter(r=>!r.attendance&&r.specialStatus==='holiday').length,absent:rows.filter(r=>!r.attendance&&!r.specialStatus||(!r.attendance&&r.specialStatus==='absent')).length,incomplete:rows.filter(r=>r.attendance?.status==='incomplete'||(r.attendance?.checkIn&&!r.attendance?.checkOut)).length};

  const openEdit=(row)=>setEditing({
    employeeId:row.employeeId,name:row.name,date,checkIn:toInput(row.attendance?.checkIn),checkOut:toInput(row.attendance?.checkOut),status:'auto',reason:''
  });
  const save=async(e)=>{
    e.preventDefault(); if(!editing||saving)return;
    setSaving(true);
    try{
      const payload={employeeId:editing.employeeId,date,checkIn:editing.checkIn?new Date(editing.checkIn).toISOString():null,checkOut:editing.checkOut?new Date(editing.checkOut).toISOString():null,status:editing.status,reason:editing.reason};
      const data=await api(`/attendance-management/manage/${editing.employeeId}`,{method:'PUT',body:JSON.stringify(payload)});
      setToast({type:'success',title:data.message,message:`${editing.name} · ${date}`}); setEditing(null); await load();
    }catch(error){setToast({type:'warning',title:'Could not save attendance',message:error.message});}
    finally{setSaving(false);}
  };
  const exportCsv=()=>{
    const rowsOut=[['Employee ID','Name','Department','Date','Check In','Check Out','Hours','Overtime','Status','Verification']];
    filtered.forEach(r=>{
      const a=r.attendance; const hours=a?.checkIn&&a?.checkOut?((new Date(a.checkOut)-new Date(a.checkIn))/3600000):0;
      rowsOut.push([r.employeeId,r.name,r.department,date,a?.checkIn?new Date(a.checkIn).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'',a?.checkOut?new Date(a.checkOut).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'',hours.toFixed(2),Number(a?.overtimeHours||0).toFixed(2),a?.status||r.specialStatus||'absent',a?.verificationMethod||'']);
    });
    const esc=v=>`"${String(v??'').replaceAll('"','""')}"`; const blob=new Blob([rowsOut.map(r=>r.map(esc).join(',')).join('\n')],{type:'text/csv;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`attendance-${date}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const loadAudit=async()=>{
    setAuditLoading(true); setAuditOpen(true);
    try{const data=await api(`/attendance-management/audit?date=${date}`);setAudits(data.audits||[]);}catch(error){setToast({type:'warning',title:'Audit history failed',message:error.message});}finally{setAuditLoading(false);}
  };
  const logout=()=>{localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';};
  const statusLabel=(row)=>row?.attendance?.status||row?.specialStatus||'absent';
  const time=(v)=>v?new Date(v).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'—';
  const hours=(a)=>a?.checkIn&&a?.checkOut?((new Date(a.checkOut)-new Date(a.checkIn))/3600000).toFixed(2):'—';
  return <main className="attendance-page">
    <Toast toast={toast} onClose={()=>setToast(null)} />
    <AdminTopbar subtitle="Leave & holidays" logout={logout} />
    <section className="attendance-shell">
      <div className="attendance-heading"><div><div className="admin-kicker">DAILY OPERATIONS</div><h1>Attendance</h1><p>Review, correct and manually mark attendance without changing the original employee record.</p></div><div className="attendance-heading-actions"><button className="secondary-button" onClick={loadAudit}>Audit history</button><button className="primary-button" onClick={exportCsv}>Export CSV</button></div></div>
      <div className="attendance-toolbar"><label>Date<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><div className="search-box"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search employee, ID, department…"/></div><select value={department} onChange={e=>setDepartment(e.target.value)}><option value="all">All departments</option>{departments.map(d=><option key={d} value={d}>{d}</option>)}</select><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="all">All attendance</option><option value="present">Present</option><option value="late">Late</option><option value="half-day">Half-day</option><option value="incomplete">Incomplete</option><option value="absent">Absent</option></select><button className="refresh-button" onClick={load}>↻ Refresh</button></div>
      <div className="attendance-stat-grid"><div><span>Present</span><strong>{counts.present}</strong></div><div><span>Late</span><strong>{counts.late}</strong></div><div><span>Half-day</span><strong>{counts.half}</strong></div><div><span>Incomplete</span><strong>{counts.incomplete}</strong></div><div><span>Absent</span><strong>{counts.absent}</strong></div></div>
      <section className="attendance-card"><div className="attendance-card-head"><div><strong>{date}</strong><small>{filtered.length} employees shown · {rows.length} total</small></div><span>Manual corrections are logged</span></div>{loading?<div className="empty-state">Loading attendance…</div>:filtered.length===0?<div className="empty-state"><strong>No employees found</strong><span>Try changing the search or filters.</span></div>:<div className="attendance-table-wrap"><table className="attendance-management-table"><thead><tr><th>Employee</th><th>Department</th><th>IN</th><th>OUT</th><th>Hours</th><th>OT</th><th>Status</th><th>Method</th><th></th></tr></thead><tbody>{filtered.map(r=>{const a=r.attendance;return <tr key={r.employeeId}><td><strong>{r.name}</strong><small>{r.employeeId}{r.status==='inactive'?' · Inactive':''}</small></td><td>{r.department||'—'}</td><td>{time(a?.checkIn)}</td><td>{time(a?.checkOut)}</td><td>{hours(a)}{hours(a)!=='—'?'h':''}</td><td>{Number(a?.overtimeHours||0).toFixed(2)}h</td><td><span className={`status-tag ${statusLabel(r)}`}>{statusLabel(r)}</span></td><td>{a?.verificationMethod||r.specialStatus||'—'}</td><td><button className="table-edit-button" onClick={()=>openEdit(r)}>{a?'Edit':'Mark attendance'}</button></td></tr>})}</tbody></table></div>}</section>
      <div className="attendance-note"><span>✓</span><div><strong>Every manual change is recorded.</strong><small>The audit log stores the previous values, new values, administrator and reason, so attendance corrections remain traceable.</small></div></div>
    </section>
    {editing&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setEditing(null)}}><form className="modal-card attendance-edit-modal" onSubmit={save}><div className="modal-head"><div><div className="admin-kicker">ATTENDANCE CORRECTION</div><h2>{editing.name}</h2><span>{editing.employeeId} · {date}</span></div><button type="button" className="modal-close" onClick={()=>setEditing(null)}>×</button></div><div className="attendance-edit-banner">Use this form when an employee forgot to scan, needs a correction, or attendance must be entered manually.</div><div className="two-col"><label>Check-in<input type="datetime-local" value={editing.checkIn||''} onChange={e=>setEditing({...editing,checkIn:e.target.value,status:'auto'})}/></label><label>Check-out<input type="datetime-local" value={editing.checkOut||''} onChange={e=>setEditing({...editing,checkOut:e.target.value,status:'auto'})}/></label></div><label>Status<select value={editing.status} onChange={e=>setEditing({...editing,status:e.target.value})}><option value="auto">Auto-calculate from time</option><option value="present">Present</option><option value="late">Late</option><option value="half-day">Half-day</option><option value="incomplete">Incomplete</option><option value="absent">Absent</option></select><span className="field-hint">Auto mode uses the employee shift, grace period, half-day rule and total hours.</span></label><label>Reason <span className="field-hint">(recommended)</span><textarea value={editing.reason||''} onChange={e=>setEditing({...editing,reason:e.target.value})} placeholder="e.g. Forgot to scan out at the kiosk" rows="3"/></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setEditing(null)}>Cancel</button><button className="primary-button" disabled={saving}>{saving?'Saving…':'Save attendance →'}</button></div></form></div>}
    {auditOpen&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setAuditOpen(false)}}><div className="modal-card audit-modal"><div className="modal-head"><div><div className="admin-kicker">AUDIT TRAIL</div><h2>Attendance changes</h2><span>{date} · Manual corrections and marks</span></div><button className="modal-close" onClick={()=>setAuditOpen(false)}>×</button></div>{auditLoading?<div className="empty-state">Loading audit history…</div>:audits.length?<div className="audit-list">{audits.map(a=><div className="audit-item" key={a._id}><div className="audit-icon">↻</div><div className="audit-main"><strong>{a.action==='created'?'Attendance marked':'Attendance updated'} · {a.employeeId}</strong><span>{new Date(a.createdAt).toLocaleString('en-IN')} · by {a.adminUsername||'admin'}</span>{a.reason&&<p>Reason: {a.reason}</p>}<div className="audit-values"><div><small>Before</small><code>{a.before?`${a.before.status} · ${a.before.checkIn?'IN '+time(a.before.checkIn):'no IN'} · ${a.before.checkOut?'OUT '+time(a.before.checkOut):'no OUT'}`:'No record'}</code></div><div><small>After</small><code>{a.after?`${a.after.status} · ${a.after.checkIn?'IN '+time(a.after.checkIn):'no IN'} · ${a.after.checkOut?'OUT '+time(a.after.checkOut):'no OUT'}`:'No record'}</code></div></div></div></div>)}</div>:<div className="empty-state">No manual changes recorded for this date.</div>}</div></div>}
  </main>;
}


function LeaveManagement(){
  const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
  const monthNow=today().slice(0,7);
  const [month,setMonth]=useState(monthNow);
  const [leaves,setLeaves]=useState([]);
  const [holidays,setHolidays]=useState([]);
  const [employees,setEmployees]=useState([]);
  const [loading,setLoading]=useState(true);
  const [toast,setToast]=useState(null);
  const [leaveOpen,setLeaveOpen]=useState(false);
  const [holidayOpen,setHolidayOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [tab,setTab]=useState('leaves');
  const [statusFilter,setStatusFilter]=useState('all');
  const [form,setForm]=useState({employeeId:'',type:'casual',startDate:`${monthNow}-01`,endDate:`${monthNow}-01`,reason:''});
  const [holidayForm,setHolidayForm]=useState({date:`${monthNow}-01`,name:'',description:''});

  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const [leaveData,holidayData,employeeData]=await Promise.all([
        api(`/leave-management/leaves?month=${month}`),
        api(`/leave-management/holidays?year=${month.slice(0,4)}`),
        api('/employees')
      ]);
      setLeaves(leaveData.leaves||[]); setHolidays(holidayData.holidays||[]); setEmployees(employeeData.employees||[]);
    }catch(error){
      if(error.status===401){localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';return;}
      setToast({type:'warning',title:'Leave data could not be loaded',message:error.message});
    }finally{setLoading(false);}
  },[month]);
  useEffect(()=>{load();},[load]);
  useEffect(()=>{setForm(f=>({...f,startDate:`${month}-01`,endDate:`${month}-01`}));setHolidayForm(f=>({...f,date:`${month}-01`}));},[month]);

  const filteredLeaves=leaves.filter(l=>statusFilter==='all'||l.status===statusFilter);
  const pending=leaves.filter(l=>l.status==='pending').length;
  const approved=leaves.filter(l=>l.status==='approved').length;
  const approvedDays=leaves.filter(l=>l.status==='approved').reduce((sum,l)=>sum+Number(l.days||0),0);

  const createLeave=async(e)=>{
    e.preventDefault(); if(saving)return; setSaving(true);
    try{
      const data=await api('/leave-management/leaves',{method:'POST',body:JSON.stringify(form)});
      setToast({type:'success',title:'Leave request created',message:data.message});
      setLeaveOpen(false); setForm(f=>({...f,reason:''})); await load();
    }catch(error){setToast({type:'warning',title:'Could not create leave',message:error.message});}
    finally{setSaving(false);}
  };
  const decideLeave=async(leave,status)=>{
    const note=status==='rejected'?'Rejected by admin':'Approved by admin';
    try{
      const data=await api(`/leave-management/leaves/${leave._id}`,{method:'PUT',body:JSON.stringify({status,decisionNote:note})});
      setToast({type:'success',title:`Leave ${status}`,message:`${leave.employee?.name||leave.employeeId} · ${leave.startDate} to ${leave.endDate}`});
      await load();
    }catch(error){setToast({type:'warning',title:'Leave update failed',message:error.message});}
  };
  const removeLeave=async(leave)=>{
    if(!window.confirm(`Delete the ${leave.type} leave request for ${leave.employee?.name||leave.employeeId}?`))return;
    try{await api(`/leave-management/leaves/${leave._id}`,{method:'DELETE'});setToast({type:'success',title:'Leave request deleted',message:'The request was removed.'});await load();}
    catch(error){setToast({type:'warning',title:'Could not delete leave',message:error.message});}
  };
  const createHoliday=async(e)=>{
    e.preventDefault(); if(saving)return; setSaving(true);
    try{const data=await api('/leave-management/holidays',{method:'POST',body:JSON.stringify(holidayForm)});setToast({type:'success',title:'Holiday added',message:data.holiday?.name||data.message});setHolidayOpen(false);setHolidayForm(f=>({...f,name:'',description:''}));await load();}
    catch(error){setToast({type:'warning',title:'Could not add holiday',message:error.message});}
    finally{setSaving(false);}
  };
  const removeHoliday=async(h)=>{
    if(!window.confirm(`Delete holiday “${h.name}” on ${h.date}?`))return;
    try{await api(`/leave-management/holidays/${h._id}`,{method:'DELETE'});setToast({type:'success',title:'Holiday deleted',message:h.name});await load();}
    catch(error){setToast({type:'warning',title:'Could not delete holiday',message:error.message});}
  };
  const logout=()=>{localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';};
  const formatType=t=>String(t||'').replace('-', ' ').replace(/\b\w/g,c=>c.toUpperCase());
  return <main className="leave-page">
    <Toast toast={toast} onClose={()=>setToast(null)} />
    <AdminTopbar subtitle="Leave & holidays" logout={logout} />
    <section className="leave-shell">
      <div className="leave-heading"><div><div className="admin-kicker">TIME OFF</div><h1>Leave & holidays</h1><p>Record leave requests and factory holidays so attendance reports distinguish leave from absence.</p></div><div className="leave-heading-actions"><button className="secondary-button" onClick={()=>setHolidayOpen(true)}>+ Add holiday</button><button className="primary-button" onClick={()=>setLeaveOpen(true)}>+ Record leave</button></div></div>
      <div className="leave-toolbar"><label>Month<input type="month" value={month} onChange={e=>setMonth(e.target.value)} /></label><button className={`tab-button ${tab==='leaves'?'active':''}`} onClick={()=>setTab('leaves')}>Leave requests</button><button className={`tab-button ${tab==='holidays'?'active':''}`} onClick={()=>setTab('holidays')}>Factory holidays</button><button className="refresh-button" onClick={load}>↻ Refresh</button></div>
      {tab==='leaves'?<>
        <div className="leave-stat-grid"><div><span>Total requests</span><strong>{leaves.length}</strong></div><div><span>Pending</span><strong>{pending}</strong></div><div><span>Approved requests</span><strong>{approved}</strong></div><div><span>Approved days</span><strong>{approvedDays}</strong></div></div>
        <section className="leave-card"><div className="leave-card-head"><div><strong>Leave requests</strong><small>Requests overlapping {month}</small></div><select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="all">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></div>
        {loading?<div className="empty-state">Loading leave requests…</div>:filteredLeaves.length===0?<div className="empty-state"><strong>No leave requests</strong><span>Record a leave request for this month when needed.</span></div>:<div className="leave-table-wrap"><table className="leave-table"><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>{filteredLeaves.map(l=><tr key={l._id}><td><strong>{l.employee?.name||l.employeeId}</strong><small>{l.employeeId} · {l.employee?.department||'No department'}</small></td><td>{formatType(l.type)}</td><td>{l.startDate} → {l.endDate}</td><td>{l.days}</td><td className="reason-cell">{l.reason||'—'}</td><td><span className={`leave-status ${l.status}`}>{l.status}</span></td><td><div className="leave-actions">{l.status==='pending'&&<><button className="approve-button" onClick={()=>decideLeave(l,'approved')}>Approve</button><button className="reject-button" onClick={()=>decideLeave(l,'rejected')}>Reject</button></>}{l.status!=='approved'&&<button className="delete-button" onClick={()=>removeLeave(l)}>Delete</button>}</div></td></tr>)}</tbody></table></div>}
        </section>
      </>:<section className="leave-card"><div className="leave-card-head"><div><strong>Factory holidays</strong><small>Holidays reduce scheduled attendance days in monthly reports.</small></div><button className="primary-button compact-primary" onClick={()=>setHolidayOpen(true)}>+ Add holiday</button></div>{loading?<div className="empty-state">Loading holidays…</div>:holidays.length===0?<div className="empty-state"><strong>No holidays configured</strong><span>Add factory holidays for the selected year.</span></div>:<div className="holiday-grid">{holidays.map(h=><div className="holiday-card" key={h._id}><div className="holiday-date">{h.date.slice(-2)}</div><div><strong>{h.name}</strong><span>{new Date(`${h.date}T00:00:00Z`).toLocaleDateString('en-IN',{weekday:'short',month:'short',year:'numeric',timeZone:'UTC'})}</span>{h.description&&<small>{h.description}</small>}</div><button className="delete-button" onClick={()=>removeHoliday(h)}>Delete</button></div>)}</div>}</section>}
      <div className="leave-note"><span>ⓘ</span><div><strong>No leave allowance is assumed.</strong><small>The system records approved leave days by type. If your factory has fixed yearly leave quotas, those can be added later without changing attendance history.</small></div></div>
    </section>
    {leaveOpen&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setLeaveOpen(false)}}><form className="modal-card leave-modal" onSubmit={createLeave}><div className="modal-head"><div><div className="admin-kicker">LEAVE ENTRY</div><h2>Record leave</h2><span>Create a new pending request</span></div><button type="button" className="modal-close" onClick={()=>setLeaveOpen(false)}>×</button></div><label>Employee<select value={form.employeeId} onChange={e=>setForm({...form,employeeId:e.target.value})} required><option value="">Select employee</option>{employees.filter(e=>e.status==='active').map(e=><option key={e.employeeId} value={e.employeeId}>{e.name} · {e.employeeId}</option>)}</select></label><label>Leave type<select value={form.type} onChange={e=>setForm({...form,type:e.target.value})}><option value="casual">Casual</option><option value="sick">Sick</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option><option value="other">Other</option></select></label><div className="two-col"><label>Start date<input type="date" value={form.startDate} onChange={e=>setForm({...form,startDate:e.target.value})} required /></label><label>End date<input type="date" value={form.endDate} onChange={e=>setForm({...form,endDate:e.target.value})} required /></label></div><label>Reason <span className="field-hint">(optional)</span><textarea value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})} rows="3" placeholder="Reason for leave" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setLeaveOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving?'Saving…':'Create leave request →'}</button></div></form></div>}
    {holidayOpen&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setHolidayOpen(false)}}><form className="modal-card leave-modal" onSubmit={createHoliday}><div className="modal-head"><div><div className="admin-kicker">FACTORY CALENDAR</div><h2>Add holiday</h2><span>This holiday applies to the whole factory.</span></div><button type="button" className="modal-close" onClick={()=>setHolidayOpen(false)}>×</button></div><label>Date<input type="date" value={holidayForm.date} onChange={e=>setHolidayForm({...holidayForm,date:e.target.value})} required /></label><label>Holiday name<input value={holidayForm.name} onChange={e=>setHolidayForm({...holidayForm,name:e.target.value})} placeholder="e.g. Diwali" required /></label><label>Description <span className="field-hint">(optional)</span><textarea value={holidayForm.description} onChange={e=>setHolidayForm({...holidayForm,description:e.target.value})} rows="3" placeholder="Optional note" /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={()=>setHolidayOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving?'Saving…':'Add holiday →'}</button></div></form></div>}
  </main>;
}

function FactorySettingsPage() {
  const [form, setForm] = useState({ shiftStart:'09:00', shiftEnd:'18:00', graceMinutes:15, halfDayAfter:'13:00', minimumFullDayHours:8, workingDays:[1,2,3,4,5,6], overtimeEnabled:true, overtimeAfter:'18:00', minimumCheckoutGapMinutes:30 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const days = [['Monday',1],['Tuesday',2],['Wednesday',3],['Thursday',4],['Friday',5],['Saturday',6],['Sunday',0]];

  const load = useCallback(async () => {
    try {
      const data = await api('/settings');
      setForm(prev => ({...prev, ...data.settings, workingDays:data.settings.workingDays || prev.workingDays}));
    } catch (error) {
      if (error.status === 401) { localStorage.removeItem('fa_admin_token'); window.location.href='/admin/login'; return; }
      setToast({type:'warning',title:'Settings could not be loaded',message:error.message});
    } finally { setLoading(false); }
  }, []);
  useEffect(()=>{ load(); },[load]);

  const toggleDay = (day) => setForm(prev => {
    const exists = prev.workingDays.includes(day);
    if (exists && prev.workingDays.length === 1) return prev;
    return {...prev, workingDays: exists ? prev.workingDays.filter(d=>d!==day) : [...prev.workingDays,day].sort((a,b)=>a-b)};
  });

  const save = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      const data = await api('/settings',{method:'PUT',body:JSON.stringify({...form,graceMinutes:Number(form.graceMinutes),minimumFullDayHours:Number(form.minimumFullDayHours),minimumCheckoutGapMinutes:Number(form.minimumCheckoutGapMinutes)})});
      setForm(prev=>({...prev,...data.settings}));
      setToast({type:'success',title:'Factory settings saved',message:'Attendance rules will apply to new check-ins and check-outs.'});
    } catch(error) { setToast({type:'warning',title:'Could not save settings',message:error.message}); }
    finally { setSaving(false); }
  };
  const logout=()=>{localStorage.removeItem('fa_admin_token');window.location.href='/admin/login';};
  if (loading) return <main className="settings-page"><div className="settings-loading">Loading factory settings…</div></main>;
  return <main className="settings-page">
    <Toast toast={toast} onClose={()=>setToast(null)} />
    <AdminTopbar subtitle="Factory rules & settings" logout={logout} />
    <section className="settings-shell">
      <div className="settings-heading"><div><div className="admin-kicker">FACTORY RULES</div><h1>Attendance settings</h1><p>Configure the rules used to calculate present, late, half-day and overtime.</p></div><button className="refresh-button" onClick={load}>↻ Reload</button></div>
      <form onSubmit={save} className="settings-grid">
        <section className="settings-card"><div className="settings-card-head"><div><strong>Working shift</strong><small>Default schedule for the factory</small></div><span>01</span></div><div className="settings-fields"><label>Shift starts<input type="time" value={form.shiftStart} onChange={e=>setForm({...form,shiftStart:e.target.value})}/></label><label>Shift ends<input type="time" value={form.shiftEnd} onChange={e=>setForm({...form,shiftEnd:e.target.value})}/></label><label>Late grace period (minutes)<input type="number" min="0" max="180" value={form.graceMinutes} onChange={e=>setForm({...form,graceMinutes:e.target.value})}/></label><label>Half-day after<input type="time" value={form.halfDayAfter} onChange={e=>setForm({...form,halfDayAfter:e.target.value})}/></label><label>Minimum full-day hours<input type="number" min="0" max="24" step="0.5" value={form.minimumFullDayHours} onChange={e=>setForm({...form,minimumFullDayHours:e.target.value})}/></label><label>Minimum gap before check-out (minutes)<input type="number" min="1" max="1440" value={form.minimumCheckoutGapMinutes} onChange={e=>setForm({...form,minimumCheckoutGapMinutes:e.target.value})}/></label></div></section>
        <section className="settings-card"><div className="settings-card-head"><div><strong>Working days</strong><small>Select the days counted as scheduled work</small></div><span>02</span></div><div className="day-grid">{days.map(([name,value])=><button type="button" key={value} className={`day-toggle ${form.workingDays.includes(value)?'selected':''}`} onClick={()=>toggleDay(value)}><span>{form.workingDays.includes(value)?'✓':'○'}</span>{name}</button>)}</div></section>
        <section className="settings-card"><div className="settings-card-head"><div><strong>Overtime</strong><small>Automatically calculate extra working time</small></div><span>03</span></div><div className="settings-switch-row"><div><strong>Enable overtime</strong><small>Count time after the overtime threshold.</small></div><button type="button" className={`switch ${form.overtimeEnabled?'on':''}`} onClick={()=>setForm({...form,overtimeEnabled:!form.overtimeEnabled})} aria-label="Toggle overtime"><span /></button></div><label className="overtime-time">Overtime starts after<input type="time" disabled={!form.overtimeEnabled} value={form.overtimeAfter} onChange={e=>setForm({...form,overtimeAfter:e.target.value})}/></label></section>
        <section className="settings-preview"><div><div className="admin-kicker">HOW IT WILL WORK</div><h2>Example</h2><p><strong>{form.shiftStart}</strong> → on time &nbsp;·&nbsp; <strong>{form.shiftStart}</strong> + {form.graceMinutes} min → still on time &nbsp;·&nbsp; after <strong>{form.halfDayAfter}</strong> → half-day</p><p>Full-day requires at least <strong>{form.minimumFullDayHours} hours</strong>. Overtime begins after <strong>{form.overtimeAfter}</strong> when enabled.</p></div><button className="primary-button settings-save" disabled={saving}>{saving?'Saving settings…':'Save factory settings →'}</button></section>
      </form>
    </section>
  </main>;
}

function App() {
  useEffect(() => {
    const unlock = async () => {
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = window.__factoryAttendanceAudioContext || (window.__factoryAttendanceAudioContext = new AudioContext());
        if (ctx.state === 'suspended') await ctx.resume();
      } catch { /* browser audio may remain unavailable */ }
    };
    window.addEventListener('pointerdown', unlock, { passive:true });
    window.addEventListener('touchstart', unlock, { passive:true });
    window.addEventListener('keydown', unlock, { passive:true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchstart', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const path = location.pathname;
  // Two clearly separated entry points:
  // /attendance (and /) is the employee face-attendance kiosk.
  // /admin/login is the protected administrator area.
  if (path === '/') return <EntryPage />;
  if (path === '/attendance/login') return <AttendanceLogin />;
  if (path === '/attendance' || path === '/kiosk') return localStorage.getItem('fa_attendance_token') ? <Kiosk /> : <AttendanceLogin />;
  if (path === '/enroll') return localStorage.getItem('fa_admin_token') ? <Enroll /> : <AdminLogin />;
  if (path === '/admin/login') return <AdminLogin />;
  if (path === '/admin') return localStorage.getItem('fa_admin_token') ? <AdminDashboard /> : <AdminLogin />;
  if (path === '/admin/employees') return localStorage.getItem('fa_admin_token') ? <EmployeeManagement /> : <AdminLogin />;
  if (path === '/admin/attendance') return localStorage.getItem('fa_admin_token') ? <AttendanceManagement /> : <AdminLogin />;
  if (path === '/admin/reports') return localStorage.getItem('fa_admin_token') ? <MonthlyReport /> : <AdminLogin />;
  if (path === '/admin/settings') return localStorage.getItem('fa_admin_token') ? <FactorySettingsPage /> : <AdminLogin />;
  if (path === '/admin/leave') return localStorage.getItem('fa_admin_token') ? <LeaveManagement /> : <AdminLogin />;
  return <Kiosk />;
}

createRoot(document.getElementById('root')).render(<App />);
