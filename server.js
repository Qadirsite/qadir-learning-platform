'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const net = require('node:net');
const db = require('./db');
const chatAI = require('./llm');
const adminApi = require('./admin-api');
const adminData = require('./admin-db');

const HOST = '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SITE_ROOT = path.resolve(__dirname, 'site');
const SESSION_COOKIE = 'qadir_session';
const SESSION_DAYS = 30;
const CSRF_TTL_SECONDS = 2 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CHAT_BODY_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const MAX_CHAT_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BODY_BYTES = 11 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();
const chatRateBuckets = new Map();
let lastChatCleanup = 0;
let maintenanceCache = { until: 0, enabled: false, message: '' };

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm'
};

function intEnv(name, fallback, min = 1, max = 1_000_000) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
// TRUST_PROXY: "auto" (default) trusts X-Forwarded-For only when the direct peer is a private/loopback
// address (a reverse proxy on the internal network); "false" never trusts it; a number N trusts N proxy hops.
const TRUST_PROXY = String(process.env.TRUST_PROXY ?? 'auto').trim().toLowerCase();
const DAY_MS = 24 * 60 * 60 * 1000;
const CHAT_LIMITS = {
  globalMinute: intEnv('CHAT_GLOBAL_PER_MINUTE', 500),
  globalDay: intEnv('CHAT_GLOBAL_PER_DAY', 10000),
  ipMinute: intEnv('CHAT_IP_PER_MINUTE', 60),
  ipDay: intEnv('CHAT_IP_PER_DAY', 1200),
  deviceMinute: intEnv('CHAT_DEVICE_PER_MINUTE', 8),
  deviceDay: intEnv('CHAT_DEVICE_PER_DAY', 80),
  maxConcurrent: intEnv('CHAT_MAX_CONCURRENT', 250)
};
let chatInFlight = 0;

const FRAME_ANCESTORS = String(process.env.FRAME_ANCESTORS || "'self'").trim();
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${FRAME_ANCESTORS}`
].join('; ');
function securityHeaders() {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=()'
  };
  if (FRAME_ANCESTORS === "'self'") headers['X-Frame-Options'] = 'SAMEORIGIN';
  if (cookieSecure()) headers['Strict-Transport-Security'] = 'max-age=15552000';
  return headers;
}

function normalizeIp(value) {
  let ip = String(value || '').trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (withPort) ip = withPort[1];
  ip = ip.replace(/%.+$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  return net.isIP(ip) ? ip.toLowerCase() : '';
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}
function clientIp(req, mode = TRUST_PROXY) {
  const peer = normalizeIp(req.socket?.remoteAddress) || 'unknown';
  if (mode === 'false' || mode === 'off') return peer;
  const header = req.headers?.['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : String(header || '')).split(',').map(normalizeIp).filter(Boolean);
  if (!forwarded.length) return peer;
  const chain = peer === 'unknown' ? forwarded : [...forwarded, peer];
  if (/^\d+$/.test(mode)) return chain[Math.max(0, chain.length - 1 - Number(mode))];
  if (!isPrivateIp(peer)) return peer;
  for (let index = chain.length - 1; index >= 0; index -= 1) if (!isPrivateIp(chain[index])) return chain[index];
  return chain[0];
}
function expandIpv6(ip) {
  const [head, tail] = ip.split('::');
  const first = head ? head.split(':') : [];
  if (tail === undefined) return first.map(part => part.padStart(4, '0'));
  const last = tail ? tail.split(':') : [];
  return [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill('0'), ...last].map(part => part.padStart(4, '0'));
}
// IPv6 clients usually own a whole /64, so rate limits are keyed by that prefix instead of the single address.
function ipBucket(ip) {
  if (net.isIPv6(ip) && !ip.includes('.')) return `${expandIpv6(ip).slice(0, 4).join(':')}::/64`;
  return ip;
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
function fail(res, status, message = 'تعذر إتمام الطلب.') {
  json(res, status, { error: message });
}
function cookieSecure() { return process.env.COOKIE_SECURE !== 'false'; }
function cookieSameSite() {
  const value = String(process.env.COOKIE_SAMESITE || 'None').trim().toLowerCase();
  if (value === 'none' && cookieSecure()) return 'None';
  return value === 'strict' ? 'Strict' : 'Lax';
}
function cookieHeader(token, maxAge) {
  const flags = [`${SESSION_COOKIE}=${token || ''}`, 'Path=/', 'HttpOnly', `Max-Age=${maxAge}`, 'SameSite=' + cookieSameSite()];
  if (cookieSecure()) flags.push('Secure');
  return flags.join('; ');
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
function normalizedUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function publicUser(user) {
  if (!user) return null;
  return { username: user.username, role: user.role, roleLabel: user.role_label || user.role, rolePriority: Number(user.role_priority) || 0, permissions: Array.isArray(user.permissions) ? user.permissions : [] };
}
function validUsername(username) { return /^[a-z0-9_]{3,24}$/.test(username); }
function validPassword(password) { return typeof password === 'string' && password.length >= 8 && password.length <= 128; }
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) return reject(err);
      resolve({ hash: key, salt });
    });
  });
}
function verifyPassword(password, salt, expected) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
    if (err) return reject(err);
    resolve(expected.length === key.length && crypto.timingSafeEqual(expected, key));
  }));
}
async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw Object.assign(new Error('invalid content type'), { status: 415 });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid json'), { status: 400 }); }
}
// The CSRF token is bound to the session cookie (via its SHA-256), so a token issued
// for one session is rejected on another. Requests without a session cookie use ''.
function csrfKeyFor(rawToken) {
  return typeof rawToken === 'string' && /^[A-Za-z0-9_-]{40,60}$/.test(rawToken)
    ? crypto.createHash('sha256').update(rawToken).digest('base64url') : '';
}
function csrfSessionKey(req) { return csrfKeyFor(readCookie(req, SESSION_COOKIE)); }
function csrfToken(secret, sessionKey = '') {
  const issued = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${issued}.${nonce}`;
  const signature = crypto.createHmac('sha256', secret).update(`${payload}.${sessionKey}`).digest('base64url');
  return `${payload}.${signature}`;
}
function validCsrf(token, secret, sessionKey = '') {
  if (typeof token !== 'string' || token.length > 256) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d{10}$/.test(parts[0]) || !/^[a-f0-9]{32}$/.test(parts[1])) return false;
  const issued = Number(parts[0]);
  const now = Math.floor(Date.now() / 1000);
  if (issued > now + 60 || now - issued > CSRF_TTL_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}.${sessionKey}`).digest();
  let supplied;
  try { supplied = Buffer.from(parts[2], 'base64url'); } catch { return false; }
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}
function rateKey(req, username) {
  return `${username}\0${ipBucket(clientIp(req))}`;
}
// Progressive lockout: after LOGIN_MAX_ATTEMPTS the key is blocked, and each repeated
// lockout within 24h doubles the block time (15m, 30m, 1h ... capped at 4h).
// State is per process (see README: with several containers each keeps its own counters).
const LOGIN_LOCK_MAX_MS = 4 * 60 * 60 * 1000;
const LOGIN_STRIKE_MEMORY_MS = 24 * 60 * 60 * 1000;
function consumeLoginAttempt(req, username) {
  const now = Date.now();
  for (const [key, value] of loginAttempts) if (value.until <= now && value.strikeUntil <= now) loginAttempts.delete(key);
  const key = rateKey(req, username);
  let state = loginAttempts.get(key) || { count: 0, until: now + LOGIN_WINDOW_MS, strikes: 0, strikeUntil: 0, blocked: false };
  if (state.until <= now) {
    state = { count: 0, until: now + LOGIN_WINDOW_MS, strikes: state.strikeUntil > now ? state.strikes : 0, strikeUntil: state.strikeUntil, blocked: false };
  }
  if (state.blocked) { loginAttempts.set(key, state); return false; }
  if (state.count >= LOGIN_MAX_ATTEMPTS) {
    state.blocked = true;
    state.until = now + Math.min(LOGIN_WINDOW_MS * 2 ** state.strikes, LOGIN_LOCK_MAX_MS);
    state.strikes += 1;
    state.strikeUntil = now + LOGIN_STRIKE_MEMORY_MS;
    loginAttempts.set(key, state);
    return false;
  }
  state.count += 1;
  loginAttempts.set(key, state);
  if (loginAttempts.size > 5000) loginAttempts.delete(loginAttempts.keys().next().value);
  return true;
}
function clearLoginAttempts(req, username) { loginAttempts.delete(rateKey(req, username)); }
function consumeChatRate(req, clientId, now = Date.now()) {
  if (now - lastChatCleanup > 60_000) {
    for (const [key, bucket] of chatRateBuckets) {
      const fresh = bucket.filter(timestamp => timestamp > now - DAY_MS);
      if (fresh.length) chatRateBuckets.set(key, fresh);
      else chatRateBuckets.delete(key);
    }
    lastChatCleanup = now;
  }
  const bucketId = ipBucket(clientIp(req));
  const addressHash = crypto.createHash('sha256').update(bucketId).digest('hex');
  const deviceHash = crypto.createHash('sha256').update(`${bucketId}\0${clientId}`).digest('hex');
  const specs = [
    [`device-minute:${deviceHash}`, CHAT_LIMITS.deviceMinute, 60_000, 'device'],
    [`device-day:${deviceHash}`, CHAT_LIMITS.deviceDay, DAY_MS, 'device'],
    [`ip-minute:${addressHash}`, CHAT_LIMITS.ipMinute, 60_000, 'ip'],
    [`ip-day:${addressHash}`, CHAT_LIMITS.ipDay, DAY_MS, 'ip'],
    ['global-minute', CHAT_LIMITS.globalMinute, 60_000, 'global'],
    ['global-day', CHAT_LIMITS.globalDay, DAY_MS, 'global']
  ];
  const pending = [];
  for (const [key, limit, windowMs, scope] of specs) {
    const bucket = (chatRateBuckets.get(key) || []).filter(timestamp => timestamp > now - windowMs);
    if (bucket.length >= limit) return { allowed: false, scope, retryAfter: Math.max(1, Math.ceil((windowMs - (now - bucket[0])) / 1000)) };
    pending.push([key, bucket]);
  }
  // Commit only when every limit has room, so a rejected request never consumes quota.
  for (const [key, bucket] of pending) { bucket.push(now); chatRateBuckets.set(key, bucket); }
  return { allowed: true, scope: null, retryAfter: 0 };
}
function chatLimitMessage(quota) {
  if (quota.scope === 'global') return quota.retryAfter > 3600
    ? 'بلغ المساعد حده اليومي على مستوى المنصة. حاول مجددًا لاحقًا.'
    : 'المساعد عليه ضغط كبير الآن. حاول مجددًا بعد قليل.';
  return 'وصلت إلى حد الاستخدام المؤقت للمساعد. انتظر قليلًا ثم حاول مجددًا.';
}
function validateChatImage(dataUrl) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_CHAT_BODY_BYTES) return false;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 24 || bytes.length > MAX_CHAT_IMAGE_BYTES || bytes.toString('base64') !== match[2]) return false;
  const mime = match[1];
  if (mime === 'image/png') {
    if (bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12,16).toString('ascii') !== 'IHDR') return false;
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width > 12000 || height > 12000) return false;
  } else if (mime === 'image/jpeg') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes[bytes.length-2] !== 0xff || bytes[bytes.length-1] !== 0xd9) return false;
  } else if (mime === 'image/webp') {
    if (bytes.subarray(0,4).toString('ascii') !== 'RIFF' || bytes.subarray(8,12).toString('ascii') !== 'WEBP') return false;
  }
  return dataUrl;
}
function validateAudioData(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_AUDIO_BODY_BYTES) return null;
  const match = /^data:(audio\/(?:webm|ogg|wav|x-wav|mpeg|mp4|m4a))(?:;[^;,]*)?;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES || bytes.toString('base64') !== match[2]) return null;
  const mime = match[1].toLowerCase() === 'audio/x-wav' ? 'audio/wav' : match[1].toLowerCase();
  const extension = mime === 'audio/webm' ? 'webm' : mime === 'audio/ogg' ? 'ogg' : mime === 'audio/wav' ? 'wav' : mime === 'audio/mpeg' ? 'mp3' : 'm4a';
  return { bytes, mime, filename: `qadir-voice-${crypto.randomUUID()}.${extension}` };
}
async function issueSession(req, res, userId) {
  const previous = readCookie(req, SESSION_COOKIE);
  if (previous && /^[A-Za-z0-9_-]{40,60}$/.test(previous)) await db.deleteSession(crypto.createHash('sha256').update(previous).digest());
  const token = crypto.randomBytes(32).toString('base64url');
  const digest = crypto.createHash('sha256').update(token).digest();
  const secret = await db.getCsrfSecret();
  const ipHash = crypto.createHmac('sha256', secret).update(clientIp(req)).digest();
  await db.createSession(digest, userId, SESSION_DAYS, { userAgent: req.headers['user-agent'], ipHash });
  res.setHeader('Set-Cookie', cookieHeader(token, SESSION_DAYS * 24 * 60 * 60));
  return token;
}
async function requireCsrf(req, res, secret) {
  if (!validCsrf(req.headers['x-csrf-token'], secret, csrfSessionKey(req))) {
    fail(res, 403, 'تعذر التحقق من الطلب. حدّث الصفحة وحاول مجددًا.');
    return false;
  }
  return true;
}
async function sessionUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  const digest = crypto.createHash('sha256').update(token).digest();
  return db.getSessionUser(digest);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;
  if (pathname === '/api/health' && method === 'GET') {
    try {
      await db.healthCheck();
      return json(res, 200, { status: 'ok' });
    } catch {
      return fail(res, 503, 'الخدمة غير جاهزة حاليًا.');
    }
  }

  if (pathname === '/api/auth/session' && method === 'GET') {
    try {
      const [user, secret] = await Promise.all([sessionUser(req), db.getCsrfSecret()]);
      return json(res, 200, { user: publicUser(user), csrfToken: csrfToken(secret, csrfSessionKey(req)) });
    } catch { return fail(res, 503, 'تعذر تحميل الجلسة.'); }
  }

  const adminHandled = await adminApi.handle(req, res, url, { sessionUser, readJson, json, fail, requireCsrf });
  if (adminHandled || res.writableEnded) return;

  if (pathname === '/api/storage/upload' && method === 'PUT') {
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'خدمة التخزين غير متاحة الآن.'); }
    if (!await requireCsrf(req, res, secret)) return;
    const uploadKey = String(req.headers['x-upload-key'] || '').trim();
    if (!/^qadir\/(?:contact|messages|admin|admin-ai|site-lessons)\/[A-Za-z0-9._/-]{1,512}$/.test(uploadKey)) return fail(res, 400, 'مفتاح الرفع غير صالح.');
    try {
      const uploadUrl = await adminApi.presignUpload(uploadKey);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(uploadUrl, { method:'PUT', headers:{'Content-Type':String(req.headers['content-type'] || 'application/octet-stream')}, body:Buffer.concat(chunks), signal:AbortSignal.timeout(120000) });
      if (!response.ok) return fail(res, 502, 'تعذر حفظ الملف في التخزين.');
      return json(res, 200, { uploaded:true });
    } catch { return fail(res, 502, 'تعذر حفظ الملف في التخزين.'); }
  }

  if (pathname === '/api/chat/transcribe' && method === 'POST') {
    let body;
    try { body = await readJson(req, MAX_AUDIO_BODY_BYTES); } catch (error) { return fail(res, error.status || 400, 'التسجيل غير صالح أو يتجاوز 8 ميغابايت.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'خدمة الصوت غير متاحة الآن.'); }
    if (!await requireCsrf(req, res, secret)) return;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.clientId !== 'string' || !/^[a-f0-9-]{32,36}$/i.test(body.clientId)) return fail(res, 400, 'تعذر التحقق من جلسة المحادثة. حدّث الصفحة وحاول مجددًا.');
    const audio = validateAudioData(body.audio);
    if (!audio) return fail(res, 400, 'التسجيل غير صالح. استخدم WebM أو OGG أو WAV أو MP3 أو M4A حتى 8 ميغابايت.');
    const quota = consumeChatRate(req, body.clientId);
    if (!quota.allowed) { res.setHeader('Retry-After', String(quota.retryAfter)); return fail(res, 429, chatLimitMessage(quota)); }
    try {
      const text = await chatAI.transcribeAudio(audio.bytes, audio.filename, audio.mime);
      return json(res, 200, { text });
    } catch { return fail(res, 503, 'تعذر فهم التسجيل الآن. جرّب تسجيلًا أوضح ثم حاول مجددًا.'); }
  }

  if (pathname === '/api/chat' && method === 'POST') {
    let body;
    try { body = await readJson(req, MAX_CHAT_BODY_BYTES); } catch (error) { return fail(res, error.status || 400, 'الطلب غير صالح أو يتجاوز الحجم المسموح.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'خدمة المحادثة غير متاحة الآن.'); }
    if (!await requireCsrf(req, res, secret)) return;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'الطلب غير صالح.');
    const image = validateChatImage(body.image);
    if (image === false) return fail(res, 400, 'الصورة غير صالحة؛ أرفق PNG أو JPEG أو WebP لا يتجاوز 3 ميغابايت بعد الضغط.');
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const effectiveMessage = message || (image ? 'اشرح السؤال الظاهر في الصورة ضمن القدرات أو التحصيلي.' : '');
    const messageLength = Array.from(effectiveMessage).length;
    if (!messageLength || messageLength > 1500) return fail(res, 400, 'اكتب سؤالًا من 1 إلى 1500 حرف.');
    if (typeof body.clientId !== 'string' || !/^[a-f0-9-]{32,36}$/i.test(body.clientId)) return fail(res, 400, 'تعذر التحقق من جلسة المحادثة. حدّث الصفحة وحاول مجددًا.');
    if (body.history !== undefined && (!Array.isArray(body.history) || body.history.length > 8)) return fail(res, 400, 'سياق المحادثة غير صالح.');
    const history = [];
    for (const item of body.history || []) {
      if (!item || typeof item !== 'object' || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || Array.from(item.content).length > 1500) return fail(res, 400, 'سياق المحادثة غير صالح.');
      history.push({ role: item.role, content: item.content });
    }
    if (chatInFlight >= CHAT_LIMITS.maxConcurrent) {
      res.setHeader('Retry-After', '5');
      return fail(res, 503, 'المساعد مشغول الآن. حاول مجددًا بعد لحظات.');
    }
    const quota = consumeChatRate(req, body.clientId);
    if (!quota.allowed) {
      res.setHeader('Retry-After', String(quota.retryAfter));
      return fail(res, 429, chatLimitMessage(quota));
    }
    chatInFlight += 1;
    try {
      const answer = await chatAI.completeChat([
        { role: 'system', content: chatAI.SYSTEM_PROMPT },
        ...history.slice(-8),
        { role: 'user', content: image ? [
          { type: 'text', text: effectiveMessage },
          { type: 'image_url', image_url: { url: image, detail: 'auto' } }
        ] : effectiveMessage }
      ]);
      return json(res, 200, { answer });
    } catch {
      return fail(res, 503, 'تعذر الحصول على إجابة الآن. احتفظ بسؤالك وحاول مجددًا بعد قليل.');
    } finally {
      chatInFlight -= 1;
    }
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر إتمام الطلب.'); }
    if (!await requireCsrf(req, res, secret)) return;
    const username = normalizedUsername(body.username);
    if (!validUsername(username) || !validPassword(body.password)) return fail(res, 400, 'اسم المستخدم أو كلمة المرور غير صالحة.');
    if (username === 'ak9') return fail(res, 409, 'اسم المستخدم غير متاح.');
    try {
      const credentials = await hashPassword(body.password);
      const user = await db.createStudent(username, credentials.hash, credentials.salt);
      const newSession = await issueSession(req, res, user.id);
      return json(res, 201, { user: publicUser(user), csrfToken: csrfToken(secret, csrfKeyFor(newSession)) });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return fail(res, 409, 'اسم المستخدم غير متاح.');
      return fail(res, 503, 'تعذر إتمام التسجيل.');
    }
  }

  if (pathname === '/api/admin/login' && method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر تسجيل الدخول.'); }
    if (!await requireCsrf(req, res, secret)) return;
    const username = normalizedUsername(body.username);
    if (!validUsername(username) || !validPassword(body.password)) return fail(res, 401, 'بيانات الدخول أو صلاحية الإدارة غير صحيحة.');
    if (!consumeLoginAttempt(req, username)) return fail(res, 429, 'محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجددًا.');
    try {
      const user = await db.getUserForLogin(username);
      const salt = user ? user.password_salt : db.DUMMY_SALT;
      const hash = user ? user.password_hash : db.DUMMY_HASH;
      const matched = await verifyPassword(body.password, salt, hash);
      if (!user || !matched || Number(user.is_active) === 0 || !await db.hasPermission(user.id, 'users.view')) {
        return fail(res, 401, 'بيانات الدخول أو صلاحية الإدارة غير صحيحة.');
      }
      clearLoginAttempts(req, username);
      const newSession = await issueSession(req, res, user.id);
      return json(res, 200, { user: publicUser(user), csrfToken: csrfToken(secret, csrfKeyFor(newSession)) });
    } catch { return fail(res, 503, 'تعذر تسجيل الدخول.'); }
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر تسجيل الدخول.'); }
    if (!await requireCsrf(req, res, secret)) return;
    const username = normalizedUsername(body.username);
    if (!validUsername(username) || !validPassword(body.password)) return fail(res, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
    if (!consumeLoginAttempt(req, username)) return fail(res, 429, 'محاولات كثيرة. حاول مجددًا لاحقًا.');
    try {
      const user = await db.getUserForLogin(username);
      const salt = user ? user.password_salt : db.DUMMY_SALT;
      const hash = user ? user.password_hash : db.DUMMY_HASH;
      const matched = await verifyPassword(body.password, salt, hash);
      if (!user || !matched || Number(user.is_active) === 0) return fail(res, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
      clearLoginAttempts(req, username);
      const newSession = await issueSession(req, res, user.id);
      return json(res, 200, { user: publicUser(user), csrfToken: csrfToken(secret, csrfKeyFor(newSession)) });
    } catch { return fail(res, 503, 'تعذر تسجيل الدخول.'); }
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    try { await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر إتمام الطلب.'); }
    if (!await requireCsrf(req, res, secret)) return;
    try {
      const token = readCookie(req, SESSION_COOKIE);
      if (token) await db.deleteSession(crypto.createHash('sha256').update(token).digest());
      res.setHeader('Set-Cookie', cookieHeader('', 0));
      return json(res, 200, { user: null, csrfToken: csrfToken(secret) });
    } catch { return fail(res, 503, 'تعذر تسجيل الخروج.'); }
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر إتمام الطلب.'); }
    if (!await requireCsrf(req, res, secret)) return;
    let account;
    try { account = await sessionUser(req); } catch { return fail(res, 503, 'تعذر إتمام الطلب.'); }
    if (!account) return fail(res, 401, 'سجّل الدخول أولًا.');
    if (!validPassword(body.current) || !validPassword(body.next)) return fail(res, 400, 'كلمة المرور غير صالحة (8 إلى 128 حرفًا).');
    if (body.current === body.next) return fail(res, 400, 'اختر كلمة مرور مختلفة عن الحالية.');
    if (!consumeLoginAttempt(req, account.username)) return fail(res, 429, 'محاولات كثيرة. حاول مجددًا لاحقًا.');
    try {
      const user = await db.getUserForLogin(account.username);
      const matched = user ? await verifyPassword(body.current, user.password_salt, user.password_hash) : false;
      if (!user || !matched) return fail(res, 403, 'كلمة المرور الحالية غير صحيحة.');
      const credentials = await hashPassword(body.next);
      const keep = crypto.createHash('sha256').update(readCookie(req, SESSION_COOKIE)).digest();
      await db.changePassword(user.id, credentials.hash, credentials.salt, keep);
      clearLoginAttempts(req, account.username);
      return json(res, 200, { changed: true, otherSessionsRevoked: true, csrfToken: csrfToken(secret, csrfSessionKey(req)) });
    } catch { return fail(res, 503, 'تعذر تغيير كلمة المرور الآن. حاول لاحقًا.'); }
  }

  if (pathname === '/api/auth/account/delete' && method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر إتمام الطلب.'); }
    if (!await requireCsrf(req, res, secret)) return;
    let account;
    try { account = await sessionUser(req); } catch { return fail(res, 503, 'تعذر إتمام الطلب.'); }
    if (!account) return fail(res, 401, 'سجّل الدخول أولًا.');
    if (body.confirm !== true) return fail(res, 400, 'أكّد رغبتك في حذف الحساب.');
    if (!validPassword(body.password)) return fail(res, 403, 'كلمة المرور غير صحيحة.');
    if (account.username === 'ak9') return fail(res, 403, 'الحساب الإداري الأساسي لا يمكن حذفه.');
    if (!consumeLoginAttempt(req, account.username)) return fail(res, 429, 'محاولات كثيرة. حاول مجددًا لاحقًا.');
    try {
      const user = await db.getUserForLogin(account.username);
      const matched = user ? await verifyPassword(body.password, user.password_salt, user.password_hash) : false;
      if (!user || !matched) return fail(res, 403, 'كلمة المرور غير صحيحة.');
      const result = await db.deleteAccount(user.id);
      if (result?.error === 'protected') return fail(res, 403, 'الحساب الإداري الأساسي لا يمكن حذفه.');
      if (!result?.deleted) return fail(res, 404, 'الحساب غير موجود.');
      clearLoginAttempts(req, account.username);
      res.setHeader('Set-Cookie', cookieHeader('', 0));
      return json(res, 200, { user: null, deleted: true, csrfToken: csrfToken(secret) });
    } catch { return fail(res, 503, 'تعذر حذف الحساب الآن. حاول لاحقًا.'); }
  }

  if (pathname === '/api/usage/heartbeat' && method === 'POST') {
    try { await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر تسجيل النشاط.'); }
    if (!await requireCsrf(req, res, secret)) return;
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      const token = readCookie(req, SESSION_COOKIE);
      const digest = crypto.createHash('sha256').update(token).digest();
      await db.recordHeartbeat(digest, user.id);
      return json(res, 200, { ok: true });
    } catch { return fail(res, 503, 'تعذر تسجيل النشاط.'); }
  }

  if (pathname === '/api/usage/pause' && method === 'POST') {
    try { await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر إيقاف تسجيل النشاط.'); }
    if (!await requireCsrf(req, res, secret)) return;
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      const token = readCookie(req, SESSION_COOKIE);
      const digest = crypto.createHash('sha256').update(token).digest();
      await db.pauseHeartbeat(digest, user.id);
      return json(res, 200, { ok: true });
    } catch { return fail(res, 503, 'تعذر إيقاف تسجيل النشاط.'); }
  }

  if (pathname === '/api/leaderboard' && method === 'GET') {
    try {
      const rows = await db.getLeaderboard();
      return json(res, 200, { students: rows.map((student, index) => ({ username: student.username, activeSeconds: student.active_seconds, rank: index + 1 })) });
    }
    catch { return fail(res, 503, 'تعذر تحميل لوحة المتصدرين.'); }
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      const isAdmin = await db.isCurrentAdmin(user.id);
      if (!isAdmin) return fail(res, 403, 'غير مصرح بهذا الإجراء.');
      const rawLimit = Number.parseInt(url.searchParams.get('limit') || '50', 10);
      const rawOffset = Number.parseInt(url.searchParams.get('offset') || '0', 10);
      const search = (url.searchParams.get('search') || '').trim().toLowerCase();
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
      const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.min(1000000, rawOffset)) : 0;
      if (search.length > 24 || (search && !/^[a-z0-9_]+$/.test(search))) return fail(res, 400, 'اكتب اسم مستخدم صالحًا للبحث.');
      if (search && !await db.hasPermission(user.id, 'users.search')) return fail(res, 403, 'لا تملك صلاحية البحث في الحسابات.');
      const [users, total] = await Promise.all([db.getAdminUsers(limit, offset, search), db.countAdminUsers(search)]);
      return json(res, 200, { users: users.map(user => ({ username: user.username, role: user.role, roleLabel: user.role_label, rolePriority: user.role_priority, isActive: user.is_active, activeSeconds: user.active_seconds, createdAt: user.created_at, lastActiveAt: user.last_active_at })), total, limit, offset, search });
    } catch { return fail(res, 503, 'تعذر تحميل المستخدمين.'); }
  }

  if (pathname === '/api/admin/users/role' && method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر تعديل الصلاحية.'); }
    if (!await requireCsrf(req, res, secret)) return;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'بيانات الصلاحية غير صالحة.');
    const username = normalizedUsername(body.username);
    const role = body.role;
    if (!validUsername(username) || typeof role !== 'string' || !/^[a-z0-9_]{3,32}$/.test(role)) return fail(res, 400, 'بيانات الصلاحية غير صالحة.');
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      const result = await db.changeUserRole(user.id, username, role);
      if (result.error === 'forbidden') return fail(res, 403, 'غير مصرح بهذا الإجراء.');
      if (result.error === 'self') return fail(res, 409, 'لا يمكنك تغيير صلاحية حسابك.');
      if (result.error === 'protected') return fail(res, 409, 'حساب ak9 الأساسي محمي ولا يمكن تغيير رتبته.');
      if (result.error === 'not_found') return fail(res, 404, 'الحساب غير موجود.');
      if (result.error === 'invalid_role') return fail(res, 400, 'الرتبة المحددة غير موجودة أو غير قابلة للإسناد.');
      if (result.error === 'hierarchy') return fail(res, 403, 'لا يمكنك إسناد رتبة مساوية أو أعلى من رتبتك.');
      return json(res, 200, { updatedUser: result.user });
    } catch { return fail(res, 503, 'تعذر تعديل الصلاحية.'); }
  }

  if (pathname === '/api/admin/roles' && method === 'GET') {
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      if (!await db.isCurrentAdmin(user.id)) return fail(res, 403, 'غير مصرح بهذا الإجراء.');
      const [roles, assignableRoles, canManageDefinitions] = await Promise.all([
        db.getRoleDefinitions(), db.getAssignableRoles(user.id), db.isSystemOwner(user.id)
      ]);
      return json(res, 200, { roles, assignableRoles, canManageDefinitions });
    } catch { return fail(res, 503, 'تعذر تحميل الرتب والصلاحيات.'); }
  }

  if (pathname === '/api/admin/roles' && method === 'POST') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر إنشاء الرتبة.'); }
    if (!await requireCsrf(req, res, secret)) return;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'بيانات الرتبة غير صالحة.');
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      if (!await db.isSystemOwner(user.id)) return fail(res, 403, 'تخصيص الرتب متاح لمالك النظام فقط.');
      const result = await db.createRoleDefinition(user.id, body.label, body.priority, body.permissions);
      if (result.error === 'forbidden') return fail(res, 403, 'تخصيص الرتب متاح لمالك النظام فقط.');
      if (result.error === 'invalid') return fail(res, 400, 'تحقق من اسم الرتبة ومستواها وصلاحياتها.');
      return json(res, 201, { role: result.role });
    } catch { return fail(res, 503, 'تعذر إنشاء الرتبة.'); }
  }

  const rolePath = pathname.match(/^\/api\/admin\/roles\/([a-z0-9_]{3,32})$/);
  if (rolePath && method === 'PUT') {
    let body;
    try { body = await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر تحديث الرتبة.'); }
    if (!await requireCsrf(req, res, secret)) return;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'بيانات الرتبة غير صالحة.');
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      if (!await db.isSystemOwner(user.id)) return fail(res, 403, 'تخصيص الرتب متاح لمالك النظام فقط.');
      const result = await db.updateRoleDefinition(user.id, rolePath[1], body.label, body.priority, body.permissions);
      if (result.error === 'forbidden') return fail(res, 403, 'تخصيص الرتب متاح لمالك النظام فقط.');
      if (result.error === 'invalid') return fail(res, 400, 'تحقق من اسم الرتبة ومستواها وصلاحياتها.');
      if (result.error === 'not_found') return fail(res, 404, 'الرتبة غير موجودة.');
      if (result.error === 'protected') return fail(res, 409, 'لا يمكن تعديل رتبة الطالب الأساسية أو رتبة محمية.');
      return json(res, 200, { role: result.role });
    } catch { return fail(res, 503, 'تعذر تحديث الرتبة.'); }
  }

  if (rolePath && method === 'DELETE') {
    try { await readJson(req); } catch (error) { return fail(res, error.status || 400, 'البيانات المرسلة غير صالحة.'); }
    let secret;
    try { secret = await db.getCsrfSecret(); } catch { return fail(res, 503, 'تعذر حذف الرتبة.'); }
    if (!await requireCsrf(req, res, secret)) return;
    try {
      const user = await sessionUser(req);
      if (!user) return fail(res, 401, 'يلزم تسجيل الدخول.');
      if (!await db.isSystemOwner(user.id)) return fail(res, 403, 'تخصيص الرتب متاح لمالك النظام فقط.');
      const result = await db.deleteRoleDefinition(user.id, rolePath[1]);
      if (result.error === 'forbidden') return fail(res, 403, 'تخصيص الرتب متاح لمالك النظام فقط.');
      if (result.error === 'invalid') return fail(res, 400, 'مفتاح الرتبة غير صالح.');
      if (result.error === 'not_found') return fail(res, 404, 'الرتبة غير موجودة.');
      if (result.error === 'protected') return fail(res, 409, 'لا يمكن حذف الرتب الأساسية.');
      if (result.error === 'in_use') return fail(res, 409, 'لا يمكن حذف رتبة مسندة إلى حسابات. أعد إسنادها أولًا.');
      return json(res, 200, { deleted: result.deleted });
    } catch { return fail(res, 503, 'تعذر حذف الرتبة.'); }
  }

  if (pathname.startsWith('/api/')) return fail(res, 404, 'المسار غير موجود.');
  return false;
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'الطريقة غير مدعومة.');
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'المسار غير صالح.'); }
  if (decoded.includes('\0') || decoded.includes('\\')) return fail(res, 400, 'المسار غير صالح.');
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(SITE_ROOT, relative);
  if (target !== SITE_ROOT && !target.startsWith(SITE_ROOT + path.sep)) return fail(res, 403, 'غير مصرح.');
  fs.stat(target, (statError, stat) => {
    let file = target;
    if (!statError && stat.isDirectory()) file = path.join(target, 'index.html');
    fs.stat(file, (error, info) => {
      if (error || !info.isFile() || !file.startsWith(SITE_ROOT + path.sep)) return fail(res, 404, 'الصفحة غير موجودة.');
      fs.realpath(file, (realError, realFile) => {
        if (realError || (realFile !== SITE_ROOT && !realFile.startsWith(SITE_ROOT + path.sep))) return fail(res, 404, 'الصفحة غير موجودة.');
        const extension = path.extname(file).toLowerCase();
        const contentType = MIME_TYPES[extension] || 'application/octet-stream';
        const isHtml = extension === '.html';
        const isCompressible = /^(text\/|application\/(javascript|json|xml)|image\/svg\+xml)/.test(contentType);
        const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
        const headers = {
          'Content-Type': contentType,
          'Cache-Control': isHtml ? 'no-cache, must-revalidate' : 'public, max-age=3600, stale-while-revalidate=86400',
          'ETag': etag,
          'Last-Modified': info.mtime.toUTCString(),
          ...securityHeaders()
        };
        if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === info.mtime.toUTCString()) {
          res.writeHead(304, headers);
          return res.end();
        }
        const acceptsGzip = isCompressible && info.size > 1024 && /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
        if (acceptsGzip) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
        else headers['Content-Length'] = info.size;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(realFile);
        stream.on('error', () => { if (!res.headersSent) fail(res, 500, 'تعذر تحميل الملف.'); else res.destroy(); });
        if (acceptsGzip) stream.pipe(zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })).pipe(res);
        else stream.pipe(res);
      });
    });
  });
}

async function getMaintenanceState() {
  if (Date.now() < maintenanceCache.until) return maintenanceCache;
  try {
    const settings = await adminData.getSettings();
    maintenanceCache = { until: Date.now() + 5000, enabled: settings.maintenance_mode === true, message: typeof settings.maintenance_message === 'string' ? settings.maintenance_message : 'الموقع تحت الصيانة، سنعود قريبًا.' };
  } catch { maintenanceCache = { until: Date.now() + 1000, enabled: false, message: '' }; }
  return maintenanceCache;
}
function maintenanceHtml(message) {
  return String(message).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
const SITE_ORIGIN = 'https://qadirsite-alxodqyn.manus.space';
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
async function servePublicContent(req, res, slug) {
  let item, unavailable = false;
  try { item = await adminData.getContentBySlug(slug); }
  catch { unavailable = true; }
  const notFound = !item && !unavailable;
  const title = unavailable ? 'المكتبة غير متاحة مؤقتًا' : notFound ? 'المحتوى غير موجود' : (item.seo_title_ar || item.title_ar);
  const description = unavailable ? 'تعذر تحميل المادة التعليمية مؤقتًا.' : notFound ? 'المادة التعليمية المطلوبة غير متاحة.' : (item.seo_description_ar || String(item.body_ar || '').slice(0, 155));
  const canonical = `${SITE_ORIGIN}/content/${encodeURIComponent(slug)}`;
  const cover = !notFound && item.cover_url ? new URL(item.cover_url, SITE_ORIGIN).href : `${SITE_ORIGIN}/project-logo.svg`;
  const body = unavailable ? 'تعذر جلب المادة الآن، أعد المحاولة بعد قليل.' : notFound ? 'قد تكون المادة حُذفت أو لم تُنشر بعد.' : String(item.body_ar || '').replace(/\r\n?/g, '\n').split('\n').map(line => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('');
  const status = unavailable ? 503 : notFound ? 404 : 200;
  const page = `<!doctype html><html lang="ar" dir="rtl" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${notFound || unavailable ? 'noindex,nofollow' : 'index,follow'}"><meta name="theme-color" content="#f7faf8"><title>${escapeHtml(title)} | قادر</title>${notFound || unavailable ? '' : `<link rel="canonical" href="${canonical}"><meta property="og:type" content="article"><meta property="og:title" content="${escapeHtml(title)} | قادر"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${canonical}"><meta property="og:site_name" content="قادر"><meta property="og:image" content="${escapeHtml(cover)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)} | قادر"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(cover)}">`}<link rel="stylesheet" href="/public-pages.css"><script src="/public-nav.js" defer></script><script src="/metrics.js" defer></script></head><body><header class="public-header"><a class="public-brand" href="/"><span class="public-brand-mark" aria-hidden="true">ق</span><span>قادر</span></a><nav class="public-nav" aria-label="التنقل الرئيسي"><a href="/library.html">المكتبة</a><a href="/chat.html">المساعد</a><a href="/contact.html">تواصل</a></nav></header><main class="page-shell"><article class="page-hero">${notFound || unavailable ? `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>` : `<span class="tag">${escapeHtml(item.kind || 'مادة تعليمية')}</span><h1>${escapeHtml(item.title_ar)}</h1>${item.cover_url ? `<img class="article-cover" src="${escapeHtml(item.cover_url)}" alt="${escapeHtml(item.title_ar)}" loading="eager">` : ''}<div class="article-body">${body}</div>`}<p><a class="button" href="/library.html">العودة إلى المكتبة</a></p></article></main><footer class="site-footer">قادر — منصة تعليمية مجانية للقدرات والتحصيلي</footer></body></html>`;
  res.writeHead(status, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':status===200?'public, max-age=0':'no-store', ...securityHeaders(), ...(status===200?{}:{'X-Robots-Tag':'noindex, nofollow'}) });
  return res.end(req.method === 'HEAD' ? undefined : page);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return fail(res, 400, 'الطلب غير صالح.'); }
  const maintenanceBypass = url.pathname === '/admin' || url.pathname.startsWith('/admin.') || url.pathname.startsWith('/admin/') || url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/') || ['/api/health','/api/auth/session','/api/auth/logout'].includes(url.pathname);
  if (!maintenanceBypass) {
    const maintenance = await getMaintenanceState();
    if (maintenance.enabled) {
      if (url.pathname.startsWith('/api/')) return json(res, 503, { error: maintenance.message || 'الموقع تحت الصيانة.' });
      const message = maintenanceHtml(maintenance.message || 'الموقع تحت الصيانة، سنعود قريبًا.');
      res.writeHead(503, { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'X-Robots-Tag':'noindex, nofollow', ...securityHeaders() });
      return res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>صيانة مؤقتة — قادر</title><main style="font:16px system-ui;max-width:680px;margin:15vh auto;padding:28px;text-align:center"><h1>نعود قريبًا</h1><p>${message}</p></main></html>`);
    }
  }
  if (url.pathname.startsWith('/api/')) {
    try {
      const result = await handleApi(req, res, url);
      if (result === false && !res.writableEnded) return fail(res, 404, 'المسار غير موجود.');
    } catch { if (!res.writableEnded) fail(res, 500, 'حدث خطأ غير متوقع.'); }
    return;
  }
  const contentRoute = url.pathname.match(/^\/content\/([a-z0-9]+(?:-[a-z0-9]+){0,15})$/);
  if (contentRoute) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow:'GET, HEAD', 'Cache-Control':'no-store' }); return res.end(); }
    return servePublicContent(req,res,contentRoute[1]);
  }
  if (url.pathname === '/admin' || url.pathname === '/admin/') url.pathname = '/admin.html';
  serveStatic(req, res, url);
});

// تحليل الملفات قد يحتاج وقتًا أطول من الطلبات العادية.
server.requestTimeout = 5 * 60 * 1000;
server.headersTimeout = 5 * 60 * 1000 + 5000;
server.timeout = 0;
async function start() {
  try {
    await db.initialize();
    await db.seedInitialAdmin();
    server.listen(PORT, HOST);
  } catch {
    // Keep startup failures generic; never expose environment values or database details.
    process.stderr.write('Backend initialization failed.\n');
    await db.close().catch(() => {});
    process.exitCode = 1;
  }
}

function shutdown() {
  server.close(() => db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

if (require.main === module) start();
module.exports = { server, start, clientIp, csrfToken, validCsrf, csrfKeyFor, consumeLoginAttempt, resetLoginAttempts() { loginAttempts.clear(); }, ipBucket, consumeChatRate, CHAT_LIMITS, resetChatRateLimits() { chatRateBuckets.clear(); lastChatCleanup = 0; } };
