// The user's account: sign-in by a code sent to the email, the plan and the
// minutes left today (server side: auth-server/accounts.py, step 4 of
// docs/PRODUCT-PLAN.md).
//
// The session (token, email, the last profile the server sent) is kept in the
// app data, so the app starts signed in and works offline: minutes used are
// counted here and sent to the server when it can be reached. The computer is
// identified by a hash of its Windows MachineGuid — never the id itself.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SERVER = process.env.AUDIATOR_ACCOUNTS_URL || 'http://127.0.0.1:3000';
const FILE = () => path.join(app.getPath('userData'), 'account.json');
const DEVICE_SALT = 'audiator-device-v1';

let state = null; // { token, email, profile, pending: { day, seconds } }
const listeners = new Set();

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { state = {}; }
  return state;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(state, null, 1));
  } catch (e) {
    console.error('[account] could not save:', e.message);
  }
  for (const cb of listeners) cb(view());
}

/** Call cb with every change: what view() returns. */
function onChange(cb) { listeners.add(cb); }

// --- this computer ---------------------------------------------------------------

let device = null;
/** A hash of the Windows MachineGuid (a random id made when Windows was
 *  installed); elsewhere, or if it cannot be read, a random id kept here. */
function deviceHash() {
  if (device) return device;
  let guid = null;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', windowsHide: true });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (m) guid = m[1].toLowerCase();
    } catch (e) {
      console.error('[account] MachineGuid not readable:', e.message);
    }
  }
  if (!guid) {
    const s = load();
    if (!s.fallbackId) { s.fallbackId = crypto.randomUUID(); save(); }
    guid = s.fallbackId;
  }
  device = crypto.createHash('sha256').update(`${DEVICE_SALT}:${guid}`).digest('hex');
  return device;
}

// --- talking to the server ------------------------------------------------------------

const tz = () => new Date().getTimezoneOffset(); // as the server expects
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** { ok, status, data } — status 0 when the server could not be reached. */
async function request(urlPath, { method = 'GET', body, auth } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && load().token) headers.Authorization = `Bearer ${load().token}`;
  try {
    const r = await fetch(SERVER + urlPath, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    let data = null;
    try { data = await r.json(); } catch (e) { /* no body */ }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { detail: { error: 'network' } } };
  }
}

const errorOf = (res) => (res.data && res.data.detail && typeof res.data.detail === 'object')
  ? res.data.detail : { error: res.status === 0 ? 'network' : 'server' };

/** Mail a sign-in code. Resolves { ok } or { ok: false, error, ... }. */
async function requestCode(email, lang) {
  const res = await request('/api/v2/auth/code', { method: 'POST', body: { email, lang } });
  return res.ok ? { ok: true, isNew: !!(res.data && res.data.new) } : { ok: false, ...errorOf(res) };
}

/** Sign in (or up) with the code. Starts a fresh session on success. */
async function verify(email, code) {
  const res = await request('/api/v2/auth/verify', {
    method: 'POST', body: { email, code, device: deviceHash(), tz: tz() },
  });
  if (!res.ok) return { ok: false, ...errorOf(res) };
  state = { token: res.data.token, email: res.data.profile.email, profile: res.data.profile,
            pending: { day: today(), seconds: 0 }, fallbackId: load().fallbackId };
  save();
  return { ok: true };
}

/** Ask the server for the plan and minutes left (sending any minutes counted
 *  offline first). Offline the last known profile stays. */
async function refresh() {
  const s = load();
  if (!s.token) return view();
  await flushUsage();
  const res = await request(`/api/v2/me?tz=${tz()}`, { auth: true });
  if (res.ok) {
    s.profile = res.data;
    save();
  } else if (res.status === 401 || res.status === 403) {
    signOut(errorOf(res).error); // session expired or account blocked
  }
  return view();
}

/** Seconds of speech recognised: counted now, sent when the server answers. */
async function addUsage(seconds) {
  const s = load();
  if (!s.token || !(seconds > 0)) return;
  if (!s.pending || s.pending.day !== today()) s.pending = { day: today(), seconds: 0 };
  s.pending.seconds += Math.ceil(seconds);
  save();
  await flushUsage();
}

// One report at a time: two transcriptions finishing together would otherwise
// both send what is pending, and the server would count the first one twice.
let flushing = Promise.resolve();
function flushUsage() {
  flushing = flushing.then(sendUsage, sendUsage);
  return flushing;
}

async function sendUsage() {
  const s = load();
  if (!s.token || !s.pending || !s.pending.seconds) return;
  // Minutes counted offline on an earlier day do not count against today.
  if (s.pending.day !== today()) { s.pending = { day: today(), seconds: 0 }; save(); return; }
  const seconds = s.pending.seconds;
  const res = await request('/api/v2/usage', { method: 'POST', auth: true, body: { seconds, tz: tz() } });
  if (res.ok) {
    s.pending.seconds = Math.max(0, s.pending.seconds - seconds);
    s.profile = res.data;
    save();
  }
}

/** reason: 'user' (signed out), 'switch' (to another account), or what the
 *  server said (session_expired, blocked). The sign-in window offers the last
 *  email again, except when the user is switching to another one. */
function signOut(reason) {
  const s = load();
  state = { fallbackId: s.fallbackId, signedOutReason: reason || null,
            lastEmail: reason === 'switch' ? null : (s.email || s.lastEmail || null) };
  save();
}

// --- what the windows see --------------------------------------------------------------

/** Signed in: { signedIn, email, plan, limited, remaining (seconds, free plan
 *  only), limit, paidUntil }; signed out: { signedIn: false, reason, lastEmail }. */
function view() {
  const s = load();
  if (!s.token || !s.profile) {
    return { signedIn: false, reason: s.signedOutReason || null, lastEmail: s.lastEmail || null };
  }
  const p = s.profile;
  const limited = p.plan === 'free';
  // The server's count for its day, less what has not reached it yet.
  const sameDay = p.day === today();
  const pending = s.pending && s.pending.day === today() ? s.pending.seconds : 0;
  const remaining = limited
    ? Math.max(0, (sameDay ? p.remaining_today : p.limit_seconds) - pending)
    : null;
  return { signedIn: true, email: s.email, plan: p.plan, limited, remaining,
           limit: p.limit_seconds, paidUntil: p.paid_until };
}

function signedIn() { return !!load().token; }

/** Whether a recording may be transcribed now. */
function canTranscribe() {
  const v = view();
  return v.signedIn && (!v.limited || v.remaining > 0);
}

module.exports = {
  deviceHash, requestCode, verify, refresh, addUsage, signOut, view, signedIn, canTranscribe, onChange,
};
