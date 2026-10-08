/**
 * BandhanJodi — Real-time OTP verification server
 * -------------------------------------------------
 * Endpoints (match the front-end in index.html):
 *   GET  /api/health          -> { ok: true }
 *   POST /api/send-otp        -> { type: 'mobile'|'email', destination }
 *   POST /api/verify-otp      -> { destination, otp }
 *
 * The OTP is generated on the server, stored HASHED with a short expiry,
 * rate-limited, and never returned to the browser. Delivery is done by a
 * pluggable provider chosen through environment variables.
 *
 * No secrets are hard-coded here. Put every credential in a .env file
 * (see .env.example) or in your hosting provider's environment settings.
 */

'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */
const PORT = process.env.PORT || 5000;
const OTP_TTL_MS = Number(process.env.OTP_TTL_MS || 5 * 60 * 1000); // 5 min
const RESEND_COOLDOWN_MS = Number(process.env.RESEND_COOLDOWN_MS || 30 * 1000); // 30 s
const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS || 5);
const MAX_SENDS_PER_HOUR = Number(process.env.MAX_SENDS_PER_HOUR || 5); // per destination
const OTP_SECRET = process.env.OTP_SECRET || crypto.randomBytes(32).toString('hex');

// Comma-separated list of allowed browser origins (your GitHub Pages / GoDaddy site).
// Example: https://bandhanjodi.com,https://www.bandhanjodi.com,https://<user>.github.io
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(express.json({ limit: '4mb' }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
  })
);

/* ------------------------------------------------------------------ *
 * In-memory store
 * NOTE: fine for a single instance. For multiple instances / restarts,
 * swap this Map for Redis (e.g. ioredis) using the same keys.
 * ------------------------------------------------------------------ */
const otpStore = new Map(); // destination -> record
const ipLog = new Map(); // ip -> [timestamps]

function hashOtp(otp, destination) {
  return crypto
    .createHmac('sha256', OTP_SECRET)
    .update(`${destination}:${otp}`)
    .digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function prune() {
  const now = Date.now();
  for (const [key, rec] of otpStore) {
    if (rec.expiresAt < now) otpStore.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */
const MOBILE_RE = /^[6-9]\d{9}$/; // Indian 10-digit mobile
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeDestination(type, raw) {
  const value = String(raw || '').trim();
  if (type === 'mobile') {
    const digits = value.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    return MOBILE_RE.test(digits) ? digits : null;
  }
  if (type === 'email') {
    const email = value.toLowerCase();
    return EMAIL_RE.test(email) ? email : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Delivery providers
 * ------------------------------------------------------------------ */
async function deliverSms(to, message, otp) {
  const provider = (process.env.SMS_PROVIDER || 'console').toLowerCase();

  if (provider === 'console') {
    console.log(`[SMS:console] to=${to} :: ${message}`);
    return;
  }

  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM_NUMBER;
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: `+91${to}`, From: from, Body: message }),
    });
    if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
    return;
  }

  if (provider === 'msg91') {
    // MSG91 Flow API. Requires a DLT-approved template (flow) for India.
    // MSG91_VAR_NAME must match the variable name used inside your template.
    const varName = process.env.MSG91_VAR_NAME || 'OTP';
    const recipient = { mobiles: `91${to}` };
    recipient[varName] = otp;
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        authkey: process.env.MSG91_AUTH_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: process.env.MSG91_TEMPLATE_ID,
        short_url: '0',
        recipients: [recipient],
      }),
    });
    const body = await res.text();
    if (!res.ok || /"type"\s*:\s*"error"/i.test(body)) {
      throw new Error(`MSG91 ${res.status}: ${body}`);
    }
    return;
  }

  if (provider === 'fast2sms') {
    const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: {
        authorization: process.env.FAST2SMS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        route: 'q',
        message: message,
        numbers: to,
        flash: 0,
      }),
    });
    if (!res.ok) throw new Error(`Fast2SMS ${res.status}: ${await res.text()}`);
    return;
  }

  throw new Error(`Unknown SMS_PROVIDER: ${provider}`);
}

async function deliverEmail(to, subject, message) {
  const provider = (process.env.EMAIL_PROVIDER || 'console').toLowerCase();

  if (provider === 'console') {
    console.log(`[EMAIL:console] to=${to} subject="${subject}" :: ${message}`);
    return;
  }

  if (provider === 'sendgrid') {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'BandhanJodi' },
        subject,
        content: [{ type: 'text/plain', value: message }],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`);
    return;
  }

  if (provider === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        subject,
        text: message,
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
    return;
  }

  if (provider === 'smtp') {
    // Optional dependency: `npm i nodemailer`
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text: message,
    });
    return;
  }

  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}

/* ------------------------------------------------------------------ *
 * Rate limiting (per destination and per IP)
 * ------------------------------------------------------------------ */
function checkIpLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const arr = (ipLog.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  ipLog.set(ip, arr);
  return arr.length <= Number(process.env.MAX_SENDS_PER_IP_HOUR || 20);
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Account storage  (saved profiles / login records)
 * Uses PostgreSQL when DATABASE_URL is set, otherwise a local JSON file.
 * ------------------------------------------------------------------ */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');
let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } catch (e) {
    console.warn('pg not installed - falling back to file storage');
  }
}

async function initStore() {
  if (pgPool) {
    await pgPool.query('CREATE TABLE IF NOT EXISTS accounts (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())');
    console.log('account store: PostgreSQL');
    return;
  }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  console.log('account store: JSON file at ' + DATA_FILE);
}

function readFileAccounts() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeFileAccounts(o) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(o, null, 2)); }
  catch (e) { console.error('account write failed:', e.message); }
}

async function upsertAccount(key, data) {
  key = String(key || '').toLowerCase().trim();
  if (!key) return false;
  if (pgPool) {
    await pgPool.query(
      'INSERT INTO accounts (key, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
      [key, data]
    );
    return true;
  }
  const all = readFileAccounts(); all[key] = data; writeFileAccounts(all); return true;
}

async function getAccount(key) {
  key = String(key || '').toLowerCase().trim();
  if (!key) return null;
  if (pgPool) {
    const r = await pgPool.query('SELECT data FROM accounts WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  const all = readFileAccounts();
  return all[key] || null;
}

async function listAccounts() {
  if (pgPool) {
    const r = await pgPool.query('SELECT key, data, updated_at FROM accounts ORDER BY updated_at DESC');
    return r.rows.map(function (x) { return Object.assign({ _key: x.key, _updated: x.updated_at }, x.data); });
  }
  const all = readFileAccounts();
  return Object.keys(all).map(function (k) { return Object.assign({ _key: k }, all[k]); });
}

function requireAdmin(req, res, next) {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY) return res.status(503).json({ message: 'Admin key not configured on the server.' });
  if (key !== process.env.ADMIN_KEY) return res.status(401).json({ message: 'Unauthorized' });
  next();
}

const CSV_COLS = ['_key','id','firstName','lastName','gender','dob','phone','email','religion','community','subCommunity','motherTongue','country','state','city','education','profession','income','maritalStatus','height','diet','complexion','ethnicity','drink','smoke','familyStatus','fatherName','fatherOccupation','motherName','motherOccupation','brotherName','sisterName','about','prefMarital','prefReligion','prefEducation','prefCountry','prefDrinking','prefSmoking','ageFrom','ageTo','accountType','plan','verified','_updated'];

app.get('/api/ip', async (_req, res) => {
  const services = [
    ['checkip', 'https://checkip.amazonaws.com'],
    ['icanhazip', 'https://icanhazip.com'],
    ['ipify', 'https://api.ipify.org'],
  ];
  const checks = {};
  let ip = null;
  for (const [name, url] of services) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const text = (await r.text()).trim();
      checks[name] = { status: r.status, text: text.slice(0, 120) };
      if (!ip && /^[0-9a-fA-F:.]+$/.test(text)) ip = text;
    } catch (err) {
      checks[name] = { error: String((err && err.message) || err) };
    }
  }
  res.json({ outbound_ip: ip, checks });
});

app.get('/api/health', async (_req, res) => {
  const out = {
    ok: true,
    ts: Date.now(),
    adminKeySet: !!process.env.ADMIN_KEY,
    dbConfigured: !!process.env.DATABASE_URL,
    store: pgPool ? 'postgres' : 'file',
    dbReachable: null,
    accounts: null,
    accountsTable: null,
    database: null,
    schema: null,
    dbError: null
  };
  if (pgPool) {
    try {
      const d = await pgPool.query('SELECT current_database() AS db, current_schema() AS sch');
      out.database = d.rows[0].db;
      out.schema = d.rows[0].sch;
      const t = await pgPool.query("SELECT to_regclass('public.accounts') IS NOT NULL AS ok");
      out.accountsTable = t.rows[0].ok;
      if (out.accountsTable) {
        const r = await pgPool.query('SELECT count(*)::int AS n FROM accounts');
        out.accounts = r.rows[0].n;
      }
      out.dbReachable = true;
    } catch (e) {
      out.dbReachable = false;
      out.dbError = String((e && e.message) || e).slice(0, 200);
    }
  }
  res.json(out);
});

app.post('/api/send-otp', async (req, res) => {
  try {
    prune();
    const { type, destination } = req.body || {};
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';

    if (!checkIpLimit(ip)) {
      return res.status(429).json({ message: 'Too many requests. Please try again later.' });
    }

    const normalized = normalizeDestination(type, destination);
    if (!normalized) {
      const msg =
        type === 'mobile'
          ? 'Please enter a valid 10-digit Indian mobile number.'
          : 'Please enter a valid email address.';
      return res.status(400).json({ message: msg });
    }

    const now = Date.now();
    const existing = otpStore.get(normalized);

    if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
      return res.status(429).json({ message: `Please wait ${wait}s before requesting a new code.` });
    }

    // Hourly cap per destination
    const sendTimes = (existing && existing.sendTimes ? existing.sendTimes : []).filter(
      (t) => now - t < 60 * 60 * 1000
    );
    if (sendTimes.length >= MAX_SENDS_PER_HOUR) {
      return res.status(429).json({ message: 'Too many codes requested for this number/email.' });
    }
    sendTimes.push(now);

    const otp = String(crypto.randomInt(100000, 1000000)); // 6 digits
    otpStore.set(normalized, {
      otpHash: hashOtp(otp, normalized),
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      lastSentAt: now,
      sendTimes,
      type,
    });

    const message = `Your BandhanJodi verification code is ${otp}. It is valid for ${Math.round(
      OTP_TTL_MS / 60000
    )} minutes. Do not share it with anyone.`;

    if (type === 'mobile') {
      await deliverSms(normalized, message, otp);
    } else {
      await deliverEmail(normalized, 'Your BandhanJodi verification code', message);
    }

    return res.json({ message: 'OTP sent successfully.' });
  } catch (err) {
    console.error('send-otp error:', err.message);
    return res.status(502).json({ message: 'Could not send the code right now. Please try again.' });
  }
});

app.post('/api/verify-otp', (req, res) => {
  try {
    prune();
    const { destination, otp } = req.body || {};
    const key = String(destination || '').trim().toLowerCase();
    const record = otpStore.get(key);

    if (!record) {
      return res.status(400).json({ message: 'No active code for this request. Please request a new one.' });
    }
    if (Date.now() > record.expiresAt) {
      otpStore.delete(key);
      return res.status(400).json({ message: 'This code has expired. Please request a new one.' });
    }
    if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
      otpStore.delete(key);
      return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
    }

    record.attempts += 1;
    const submitted = String(otp || '').trim();
    const ok = safeEqual(record.otpHash, hashOtp(submitted, key));

    if (!ok) {
      return res.status(400).json({ message: 'Invalid code. Please check and try again.' });
    }

    otpStore.delete(key); // one-time use

    // TODO: create a real session / JWT here and return it.
    // e.g. const token = jwt.sign({ sub: key }, JWT_SECRET, { expiresIn: '7d' });
    //      return res.json({ message: 'Verified', token });
    return res.json({ message: 'Verified successfully.', verified: true });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    return res.status(500).json({ message: 'Verification failed. Please try again.' });
  }
});


// ---- save a profile / account record ----
app.post('/api/save-profile', async (req, res) => {
  try {
    const profile = (req.body || {}).profile;
    if (!profile || typeof profile !== 'object') return res.status(400).json({ message: 'profile required' });
    const key = (profile.email || profile.phone || '').toLowerCase().trim();
    if (!key) return res.status(400).json({ message: 'profile needs an email or phone' });
    // never let a client-side save wipe admin-controlled state
    const prev = (await getAccount(key)) || {};
    if (prev.chatUnlocked) profile.chatUnlocked = true;
    if (prev.paidChats) profile.paidChats = prev.paidChats;
    if (prev.plan && !profile.plan) profile.plan = prev.plan;
    if (prev.verified) profile.verified = true;
    if (prev.accountType === 'premium') profile.accountType = 'premium';
    await upsertAccount(key, profile);
    return res.json({ ok: true });
  } catch (err) {
    console.error('save-profile error:', err.message);
    return res.status(500).json({ message: 'Could not save profile.' });
  }
});

// ---- admin: list all accounts ----
app.get('/api/admin/accounts', cors(), requireAdmin, async (req, res) => {
  try {
    const list = await listAccounts();
    return res.json({ count: list.length, accounts: list });
  } catch (err) {
    console.error('admin accounts error:', err.message);
    return res.status(500).json({ message: 'Could not load accounts.' });
  }
});

// ---- admin: download CSV ----
app.get('/api/admin/export.csv', cors(), requireAdmin, async (req, res) => {
  try {
    const list = await listAccounts();
    const esc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    let csv = CSV_COLS.join(',') + '\n';
    list.forEach(function (a) { csv += CSV_COLS.map(function (c) { return esc(a[c]); }).join(',') + '\n'; });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bandhanjodi-accounts.csv"');
    return res.send(csv);
  } catch (err) {
    return res.status(500).json({ message: 'Could not export.' });
  }
});


// ---- public: list profiles for the matches deck (no email/phone exposed) ----
app.get('/api/profiles', cors(), async (_req, res) => {
  try {
    const list = await listAccounts();
    const ageFromDob = function (dob) {
      if (!dob) return null;
      const parts = String(dob).split(/[\/\-.]/).map(function (x) { return parseInt(x, 10); });
      let d = null, m = null, y = null;
      if (parts.length === 3 && parts.every(function (n) { return !isNaN(n); })) {
        if (parts[0] > 1900) { y = parts[0]; m = parts[1]; d = parts[2]; }
        else { d = parts[0]; m = parts[1]; y = parts[2]; }
      }
      if (!y || !m || !d) return null;
      const now = new Date();
      let a = now.getFullYear() - y;
      if (((now.getMonth() + 1) * 100 + now.getDate()) < (m * 100 + d)) a--;
      return (a > 0 && a < 100) ? a : null;
    };
    const profiles = list
      .filter(function (a) { return a && (a.firstName || a.lastName); })
      .map(function (a) {
        const name = [a.firstName, a.lastName].filter(Boolean).join(' ') || 'Member';
        const badges = [];
        if (a.verified) badges.push('Verified');
        if (a.accountType === 'premium') badges.push('Premium');
        if (a.plan) badges.push(a.plan);
        return {
          id: a.id || name,
          name: name,
          age: ageFromDob(a.dob),
          height: a.height || '',
          location: [a.city, a.state, a.country].filter(Boolean).join(', '),
          caste: [a.community, a.subCommunity].filter(Boolean).join(' - '),
          profession: a.profession || '',
          income: a.income || '',
          education: a.education || '',
          maritalStatus: a.maritalStatus || '',
          managedBy: a.profileFor || 'Self',
          diet: a.diet || '', drink: a.drink || '', smoke: a.smoke || '',
          family: a.familyStatus || '',
          about: a.about || '',
          lastActive: a.accountType === 'premium' ? 'Active today' : 'Recently',
          verified: !!a.verified,
          premium: a.accountType === 'premium',
          photosCount: a.photo ? 1 : 0,
          image: a.photo || '',
          badges: badges.length ? badges : ['Member']
        };
      })
      .sort(function (x, y) {
        return ((y.verified ? 1 : 0) - (x.verified ? 1 : 0)) || ((y.premium ? 1 : 0) - (x.premium ? 1 : 0));
      })
      .slice(0, 60);
    res.json({ count: profiles.length, profiles: profiles });
  } catch (err) {
    console.error('profiles error:', err.message);
    res.status(500).json({ message: 'Could not load profiles.' });
  }
});


// ---- admin: unlock / lock chat access for a client ----
app.post('/api/admin/unlock-chat', cors(), requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const key = String(body.key || '').toLowerCase().trim();
    if (!key) return res.status(400).json({ message: 'key required' });
    const rec = (await getAccount(key)) || {};
    rec.chatUnlocked = (body.unlocked === false) ? false : true;
    await upsertAccount(key, rec);
    return res.json({ ok: true, key: key, chatUnlocked: rec.chatUnlocked });
  } catch (err) {
    console.error('unlock-chat error:', err.message);
    return res.status(500).json({ message: 'Could not update chat access.' });
  }
});

// ---- public: does this client have chat access? ----
app.get('/api/chat-status', cors(), async (req, res) => {
  try {
    const key = String(req.query.key || '').toLowerCase().trim();
    if (!key) return res.json({ unlocked: false });
    const rec = (await getAccount(key)) || {};
    return res.json({ unlocked: !!rec.chatUnlocked, paidChats: rec.paidChats || [] });
  } catch (err) {
    return res.json({ unlocked: false });
  }
});


// ---- admin: activate / deactivate premium membership for a client ----
app.post('/api/admin/set-premium', cors(), requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const key = String(body.key || '').toLowerCase().trim();
    if (!key) return res.status(400).json({ message: 'key required' });
    const rec = (await getAccount(key)) || {};
    const on = (body.premium !== false);
    rec.accountType = on ? 'premium' : 'local';
    rec.verified = on ? true : false;
    if (on && !rec.plan) rec.plan = 'Admin Activated';
    await upsertAccount(key, rec);
    return res.json({ ok: true, key: key, accountType: rec.accountType, verified: rec.verified });
  } catch (err) {
    console.error('set-premium error:', err.message);
    return res.status(500).json({ message: 'Could not update membership.' });
  }
});

app.use((_req, res) => res.status(404).json({ message: 'Not found' }));

initStore().catch(function (e) { console.warn('store init failed:', e.message); });

app.listen(PORT, () => {
  console.log(`BandhanJodi OTP server listening on port ${PORT}`);
  console.log(`SMS provider: ${process.env.SMS_PROVIDER || 'console'}`);
  console.log(`Email provider: ${process.env.EMAIL_PROVIDER || 'console'}`);
});
