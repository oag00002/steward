// Steward — Cloudflare Worker entry point. Static files in /public are served by Cloudflare
// directly; this code only answers /api/* and /healthz.
import { HttpError, boolify, first } from './lib.js';
import { currentUser, requireRole, register as registerAuth } from './auth.js';
import membership from './routes/membership.js';
import contributions from './routes/contributions.js';
import attendance from './routes/attendance.js';
import reports from './routes/reports.js';
import imports from './routes/imports.js';
import admin from './routes/admin.js';
import { MIGRATIONS, splitStatements } from './schema.js';

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, role, fn) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, role, fn });
  }
  get(p, role, fn) { this.add('GET', p, role, fn); }
  post(p, role, fn) { this.add('POST', p, role, fn); }
  put(p, role, fn) { this.add('PUT', p, role, fn); }
  delete(p, role, fn) { this.add('DELETE', p, role, fn); }
  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re);
      if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
}

// Bring the database up to date (runs once per Worker instance; cheap after the first time).
let schemaReady = null;
async function currentVersion(db) {
  try { return (await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').first()).v; }
  catch (e) {
    if (/no such table/i.test(String(e.message))) return 0;
    throw e;
  }
}
async function migrate(db) {
  let v = await currentVersion(db);
  if (v >= MIGRATIONS.length) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)').run();
  for (; v < MIGRATIONS.length; v++) {
    const steps = splitStatements(MIGRATIONS[v]).map(sql => db.prepare(sql));
    steps.push(db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').bind(v + 1, new Date().toISOString()));
    try {
      await db.batch(steps); // all or nothing
      console.log(`Applied database step ${v + 1}`);
    } catch (e) {
      // Another request may have applied it at the same moment.
      if ((await currentVersion(db)) > v) continue;
      throw e;
    }
  }
}
function ensureSchema(db) {
  if (!schemaReady) schemaReady = migrate(db).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

const router = new Router();
registerAuth(router);
for (const mod of [membership, contributions, attendance, reports, imports, admin]) mod(router);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(boolify(data)), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let res;
    const c = { req, env, db: env.DB, url, query: url.searchParams, user: null, setCookie: null };
    let bodyCache;
    c.body = async () => {
      if (bodyCache === undefined) {
        const text = await req.text();
        if (text.length > 15 * 1024 * 1024) throw new HttpError(413, 'That file is too large.');
        try { bodyCache = text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, 'The request was not valid JSON.'); }
      }
      return bodyCache;
    };
    try {
      await ensureSchema(env.DB);
      if (url.pathname === '/healthz') {
        await first(env.DB, 'SELECT 1 AS ok');
        res = json({ ok: true });
      } else {
        // CSRF defence: state-changing calls must come from the app's own scripts.
        if (!['GET', 'HEAD'].includes(req.method) && req.headers.get('X-Steward') !== '1') throw new HttpError(403, 'Request blocked.');
        const hit = router.match(req.method, url.pathname);
        if (!hit) throw new HttpError(404, 'Not found');
        c.params = hit.params;
        c.user = await currentUser(c);
        if (hit.route.role) requireRole(c, hit.route.role);
        const out = await hit.route.fn(c);
        res = out instanceof Response ? out : json(out ?? { ok: true });
      }
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e.stack || e);
      res = json({ error: status >= 500 ? 'Something went wrong on the server. Check the Worker logs in the Cloudflare dashboard.' : e.message }, status);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    if (c.setCookie) out.headers.append('Set-Cookie', c.setCookie);
    return out;
  },
};
