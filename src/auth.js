// Sign-in, sessions (stored in D1), roles.
import { HttpError, bad, first, run, audit, blank } from './lib.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from './password.js';

export const RANK = { counter: 1, finance: 2, admin: 3 };
const COOKIE = 'steward_sid';
const SESSION_DAYS = 14;              // sliding: renewed while the app is in use
const MAX_FAILURES = 8;
const FAILURE_WINDOW = 15 * 60;       // seconds

const now = () => Math.floor(Date.now() / 1000);
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function readCookie(req, name) {
  const h = req.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const cookieHeader = (value, maxAge) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

// Look up the signed-in user for a request (or null). Renews the session when it is half used.
export async function currentUser(c) {
  const token = readCookie(c.req, COOKIE);
  if (!token || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const row = await first(c.db, `SELECT u.id, u.username, u.full_name, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, hash, now());
  if (!row) return null;
  if (row.expires_at - now() < (SESSION_DAYS * 86400) / 2) {
    const exp = now() + SESSION_DAYS * 86400;
    await run(c.db, 'UPDATE sessions SET expires_at = ? WHERE token_hash = ?', exp, hash);
    c.setCookie = cookieHeader(token, SESSION_DAYS * 86400);
  }
  return { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
}

export function requireRole(c, min) {
  if (!c.user) throw new HttpError(401, 'Please sign in.');
  if (RANK[c.user.role] < RANK[min]) throw new HttpError(403, 'Your account does not have access to this.');
}

export function register(r) {
  r.post('/api/auth/login', null, async c => {
    const body = await c.body();
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const ip = c.req.headers.get('CF-Connecting-IP') || 'local';
    const key = `${username}|${ip}`;
    const f = await first(c.db, 'SELECT first_at, count FROM login_failures WHERE key = ?', key);
    if (f && now() - f.first_at < FAILURE_WINDOW && f.count >= MAX_FAILURES) {
      throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
    }
    const u = await first(c.db, 'SELECT * FROM users WHERE username = ? AND active = 1', username);
    const ok = await verifyPassword(password, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) {
      if (!f || now() - f.first_at >= FAILURE_WINDOW) {
        await run(c.db, 'INSERT INTO login_failures (key, first_at, count) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET first_at = excluded.first_at, count = 1', key, now());
      } else {
        await run(c.db, 'UPDATE login_failures SET count = count + 1 WHERE key = ?', key);
      }
      throw new HttpError(401, 'That username and password do not match.');
    }
    if (f) await run(c.db, 'DELETE FROM login_failures WHERE key = ?', key);
    const token = newToken();
    await run(c.db, 'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)',
      await sha256Hex(token), u.id, now() + SESSION_DAYS * 86400, now());
    // Housekeeping: drop expired sessions and stale failure counters.
    await run(c.db, 'DELETE FROM sessions WHERE expires_at < ?', now());
    c.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
    c.setCookie = cookieHeader(token, SESSION_DAYS * 86400);
    await audit(c, 'login', u.username);
    return { user: c.user };
  });

  r.post('/api/auth/logout', null, async c => {
    const token = readCookie(c.req, COOKIE);
    if (token) await run(c.db, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
    c.setCookie = cookieHeader('', 0);
    return { ok: true };
  });

  r.get('/api/auth/me', null, async c => {
    if (c.user) return { user: c.user };
    const n = (await first(c.db, 'SELECT count(*) AS n FROM users')).n;
    return n ? { user: null } : { user: null, needs_setup: true, setup_code_set: !!c.env.SETUP_CODE };
  });

  // First run only: create the first administrator. Needs the SETUP_CODE secret set on the Worker,
  // so nobody who stumbles on a brand-new site can claim it.
  r.post('/api/auth/setup', null, async c => {
    if ((await first(c.db, 'SELECT count(*) AS n FROM users')).n) throw new HttpError(409, 'This site is already set up. Sign in instead.');
    const expected = String(c.env.SETUP_CODE || '');
    if (expected.length < 8) throw bad('Add a SETUP_CODE secret (8+ characters) to this Worker in the Cloudflare dashboard first.');
    const body = await c.body();
    const ip = c.req.headers.get('CF-Connecting-IP') || 'local';
    const key = `setup|${ip}`;
    const f = await first(c.db, 'SELECT first_at, count FROM login_failures WHERE key = ?', key);
    if (f && now() - f.first_at < FAILURE_WINDOW && f.count >= MAX_FAILURES) throw new HttpError(429, 'Too many wrong setup codes. Wait 15 minutes and try again.');
    const given = String(body.setup_code || '');
    const a = await sha256Hex(given), b = await sha256Hex(expected);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    if (diff !== 0) {
      await run(c.db, `INSERT INTO login_failures (key, first_at, count) VALUES (?,?,1)
        ON CONFLICT(key) DO UPDATE SET count = CASE WHEN ? - first_at >= ? THEN 1 ELSE count + 1 END,
          first_at = CASE WHEN ? - first_at >= ? THEN excluded.first_at ELSE first_at END`, key, now(), now(), FAILURE_WINDOW, now(), FAILURE_WINDOW);
      throw new HttpError(401, 'That setup code is not right.');
    }
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[a-z0-9._@-]{2,60}$/.test(username)) throw bad('Usernames use letters, numbers, dots, dashes or underscores.');
    if (password.length < 10) throw bad('Passwords must be at least 10 characters.');
    // INSERT ... WHERE NOT EXISTS keeps two simultaneous setups from both succeeding.
    const m = await run(c.db, `INSERT INTO users (username, full_name, password_hash, role)
      SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`, username, blank(body.full_name), await hashPassword(password));
    if (!m.changes) throw new HttpError(409, 'This site is already set up. Sign in instead.');
    const token = newToken();
    await run(c.db, 'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)',
      await sha256Hex(token), m.last_row_id, now() + SESSION_DAYS * 86400, now());
    c.user = { id: m.last_row_id, username, full_name: blank(body.full_name), role: 'admin' };
    c.setCookie = cookieHeader(token, SESSION_DAYS * 86400);
    await audit(c, 'setup', username);
    return { user: c.user };
  });

  r.post('/api/auth/password', 'counter', async c => {
    const { current, next } = await c.body();
    if (!next || String(next).length < 10) throw bad('New password must be at least 10 characters.');
    const u = await first(c.db, 'SELECT password_hash FROM users WHERE id = ?', c.user.id);
    if (!(await verifyPassword(String(current || ''), u.password_hash))) throw bad('Current password is wrong.');
    await run(c.db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(String(next)), c.user.id);
    await audit(c, 'password_change', c.user.username);
    return { ok: true };
  });
}

export { blank };
