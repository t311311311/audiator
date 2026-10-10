// The user's account: sign-in by a code sent to the email, the plan and the
// minutes left today (server side: auth-server/accounts.py, step 4 of
// docs/PRODUCT-PLAN.md).
//
// The session (token, email, the last profile the server sent) is kept in the
// app data, so the app starts signed in and works offline: minutes used are
// counted here and sent to the server when it can be reached. The computer is
// identified by a hash of its Windows MachineGuid — never the id itself.
//
// The token is stored encrypted for this Windows user (DPAPI, through
// Electron's safeStorage): the file copied to another computer or read by
// another user signs no one in — there it just means "sign in again".
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const SERVER = process.env.AUDIATOR_ACCOUNTS_URL || 'http://127.0.0.1:3000';
// The rules shown in the sign-in window (src/terms/); ticking them accepts
// this version, and the server lets no one in without it.
const TERMS_VERSION = '2026-10-04';
// The free plan's allowance is per 24 hours of the account's own, from its
// first use (auth-server/accounts.py, WINDOW).
const WINDOW_MS = 24 * 3600 * 1000;
const FILE = () => path.join(app.getPath('userData'), 'account.json');
const DEVICE_SALT = 'audiator-device-v1';

let state = null; // in memory: { token, email, profile, pending: { day, seconds } }
const listeners = new Set();

function load() {
  if (state) return state;
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch (e) { /* none yet */ }
  const { tokenEnc, ...rest } = disk;
  state = rest;
  if (tokenEnc) {
    try {
      state.token = safeStorage.decryptString(Buffer.from(tokenEnc, 'base64'));
    } catch (e) {
      console.error('[account] the saved session is not readable here; sign in again');
      delete state.profile;
    }
  } else if (state.token) {
    writeDisk(); // a session saved before it was encrypted: encrypt it now
  }
  return state;
}

/** The file: everything as it is, except the token, which is encrypted. */
function writeDisk() {
  const { token, ...disk } = state;
  if (token) {
    if (safeStorage.isEncryptionAvailable()) disk.tokenEnc = safeStorage.encryptString(token).toString('base64');
    else disk.token = token; // no protected storage on this system: as before
  }
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(disk, null, 1));
  } catch (e) {
    console.error('[account] could not save:', e.message);
  }
}

function save() {
  writeDisk();
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

const tz = () => new Date().getTimezoneOffset(); // as the server expects (for its per-day history)

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
  return res.ok ? { ok: true } : { ok: false, ...errorOf(res) };
}

/** Sign in (or up) with the code. Starts a fresh session on success. */
async function verify(email, code) {
  const res = await request('/api/v2/auth/verify', {
    method: 'POST', body: { email, code, device: deviceHash(), tz: tz(), terms: TERMS_VERSION },
  });
  if (!res.ok) return { ok: false, ...errorOf(res) };
  state = { token: res.data.token, email: res.data.profile.email, profile: res.data.profile,
            pending: { since: 0, seconds: 0 }, fallbackId: load().fallbackId };
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
  if (!s.pending || !s.pending.seconds) s.pending = { since: Date.now(), seconds: 0 };
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

// The server counts at most an hour per report (auth-server/accounts.py,
// report_usage): a recording longer than that, or minutes piled up offline,
// go in pieces. Sent whole, everything over the hour was lost (found
// 2026-10-06: a 1 h 23 min recording counted as 1 h). The 24 hours then start
// an hour before the first piece, not at the very start of a longer recording.
const REPORT_MAX_SECONDS = 3600;

async function sendUsage() {
  const s = load();
  while (s.token && s.pending && s.pending.seconds > 0) {
    // Minutes counted offline in 24 hours that are over by now are not charged
    // to new ones.
    if (!(s.pending.since > Date.now() - WINDOW_MS)) { s.pending = { since: 0, seconds: 0 }; save(); return; }
    const seconds = Math.min(s.pending.seconds, REPORT_MAX_SECONDS);
    const res = await request('/api/v2/usage', { method: 'POST', auth: true, body: { seconds, tz: tz() } });
    if (!res.ok) return; // offline: the rest goes next time
    s.pending.seconds = Math.max(0, s.pending.seconds - seconds);
    s.profile = res.data;
    save();
  }
}

/** A message to support: { ok, id, answerWithin ('48h' | '2wd' | '5wd' | null),
 *  replyTo } or { ok: false, error }. */
async function sendSupport(category, text, appVersion, os) {
  const res = await request('/api/v2/support', {
    method: 'POST', auth: true, body: { category, text, app_version: appVersion, os },
  });
  if (!res.ok) return { ok: false, ...errorOf(res) };
  return { ok: true, id: res.data.id, answerWithin: res.data.answer_within, replyTo: res.data.reply_to };
}

/** An xRocket invoice for the plan (period: 'month' | 'year'), to be paid in
 *  Telegram: { ok, id, url, price, expiresAt (ms) } or { ok: false, error }. */
async function payInvoice(period, lang) {
  const res = await request('/api/v2/pay/xrocket', { method: 'POST', auth: true, body: { period, lang } });
  if (!res.ok) return { ok: false, ...errorOf(res) };
  return { ok: true, id: res.data.id, url: res.data.url, price: res.data.price,
           expiresAt: res.data.expires_at ? Date.parse(res.data.expires_at) : null };
}

/** Where a payment is: { ok, status ('pending' | 'paid' | 'expired' | 'failed'),
 *  credited } — the plan and balance the server sent come along. */
async function paymentStatus(id) {
  const res = await request(`/api/v2/pay/${encodeURIComponent(id)}`, { auth: true });
  if (!res.ok) return { ok: false, ...errorOf(res) };
  const s = load();
  if (res.data.profile && s.token) { s.profile = res.data.profile; save(); }
  return { ok: true, status: res.data.status, credited: res.data.credited };
}

/** The buyer changed their mind: the invoice is cancelled at xRocket and can
 *  no longer be paid. { ok, status } — 'cancelled'; 'paid' if the money had
 *  come first (credited); 'pending' if it could not be cancelled — the invoice
 *  is still payable, and the window says so. */
async function cancelPayment(id) {
  const res = await request(`/api/v2/pay/${encodeURIComponent(id)}/cancel`, { method: 'POST', auth: true });
  if (!res.ok) return { ok: false, ...errorOf(res) };
  const s = load();
  if (res.data.profile && s.token) { s.profile = res.data.profile; save(); }
  return { ok: true, status: res.data.status, credited: res.data.credited };
}

/** reason: 'user' (signed out in Settings) or what the server said
 *  (session_expired, blocked). The sign-in window offers the last email again. */
function signOut(reason) {
  const s = load();
  state = { fallbackId: s.fallbackId, signedOutReason: reason || null,
            lastEmail: s.email || s.lastEmail || null };
  save();
}

// --- what the windows see --------------------------------------------------------------

/** Signed in: { signedIn, email, plan, limited, remaining (seconds, free plan
 *  only), limit, resetsAt (ms: when the account's 24 hours end; null while
 *  none are running — the next use starts them), paidUntil }; signed out:
 *  { signedIn: false, reason, lastEmail }. */
function view() {
  const s = load();
  if (!s.token || !s.profile) {
    return { signedIn: false, reason: s.signedOutReason || null, lastEmail: s.lastEmail || null };
  }
  const p = s.profile;
  const limited = p.plan === 'free';
  let remaining = null, resetsAt = null;
  if (limited) {
    // The server's count for the account's 24 hours, less what has not
    // reached it yet. 24 hours that have ended since it said so are over.
    resetsAt = p.resets_at ? Date.parse(p.resets_at) : null;
    let used = p.used || 0;
    if (resetsAt && Date.now() >= resetsAt) { resetsAt = null; used = 0; }
    const pending = s.pending && s.pending.seconds > 0 ? s.pending : null;
    if (pending && !resetsAt) resetsAt = pending.since + WINDOW_MS; // started here, offline
    remaining = Math.max(0, p.limit_seconds - used - (pending ? pending.seconds : 0));
  }
  return { signedIn: true, email: s.email, plan: p.plan, limited, remaining, resetsAt,
           limit: p.limit_seconds, paidUntil: p.paid_until, balance: p.balance || 0,
           prices: p.prices || null }; // what the server asks for a month / a year, USDT
}

function signedIn() { return !!load().token; }

/** Whether a recording may be transcribed now. */
function canTranscribe() {
  const v = view();
  return v.signedIn && (!v.limited || v.remaining > 0);
}

module.exports = {
  TERMS_VERSION, deviceHash, sendSupport, payInvoice, paymentStatus, cancelPayment, requestCode, verify, refresh,
  addUsage, signOut,
  view, signedIn, canTranscribe, onChange,
};
