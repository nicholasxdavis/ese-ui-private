/**
 * Cookie session auth for admin.
 * Secrets: ADMIN_USER, ADMIN_PASSWORD, SESSION_SECRET
 */

const COOKIE = 'ese_admin';
const DAY = 24 * 60 * 60;

function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const s = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sign(payload, secret) {
  const key = await hmacKey(secret);
  const data = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return b64url(new Uint8Array(sig));
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export async function createSessionToken(env, { remember = false } = {}) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  const user = env.ADMIN_USER || 'admin';
  const ttl = remember ? 30 * DAY : 12 * 60 * 60;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${user}|${exp}|${remember ? 1 : 0}`;
  const sig = await sign(payload, secret);
  return { token: `${b64url(new TextEncoder().encode(payload))}.${sig}`, maxAge: ttl };
}

export async function verifySessionToken(env, token) {
  if (!token || !env.SESSION_SECRET) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  let payload;
  try {
    payload = new TextDecoder().decode(b64urlDecode(body));
  } catch {
    return null;
  }
  const expect = await sign(payload, env.SESSION_SECRET);
  if (!(await timingSafeEqual(expect, sig))) return null;
  const [user, expStr] = payload.split('|');
  const exp = parseInt(expStr, 10);
  if (!user || !exp || exp * 1000 < Date.now()) return null;
  if (env.ADMIN_USER && !(await timingSafeEqual(user, env.ADMIN_USER))) return null;
  return { user, exp };
}

export async function validateCredentials(env, username, password) {
  const u = env.ADMIN_USER;
  const p = env.ADMIN_PASSWORD;
  if (!u || !p) return false;
  const userOk = await timingSafeEqual(String(username || ''), u);
  const passOk = await timingSafeEqual(String(password || ''), p);
  return userOk && passOk;
}

export function sessionCookieHeader(token, maxAge) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  return parts.join('; ');
}

export function clearSessionCookieHeader() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function getSession(request, env) {
  const cookies = parseCookies(request);
  return verifySessionToken(env, cookies[COOKIE]);
}

/** Admin UI / mutating APIs: session cookie OR Bearer ADMIN / ingest secret. */
export async function isAdminRequest(request, env) {
  const session = await getSession(request, env);
  if (session) return true;

  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const ingest = request.headers.get('X-Ingest-Secret') || '';
  const alt = request.headers.get('X-Admin-Token') || '';

  if (env.INGEST_SECRET && (ingest === env.INGEST_SECRET || bearer === env.INGEST_SECRET)) {
    return true;
  }
  if (env.ADMIN_PASSWORD && (bearer === env.ADMIN_PASSWORD || alt === env.ADMIN_PASSWORD)) {
    return true;
  }
  return false;
}

export { COOKIE };
