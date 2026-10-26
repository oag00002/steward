// Shared helpers for the Worker: HTTP errors, D1 access, parsing, CSV.

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = msg => new HttpError(400, msg);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);

// ---------- D1 ----------
const clean = params => params.map(p => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
export const stmt = (db, sql, ...p) => db.prepare(sql).bind(...clean(p));
export const all = async (db, sql, ...p) => (await stmt(db, sql, ...p).all()).results;
export const first = (db, sql, ...p) => stmt(db, sql, ...p).first();
export const run = async (db, sql, ...p) => (await stmt(db, sql, ...p).run()).meta;
// Atomic: every statement succeeds or none do.
export const batch = (db, statements) => db.batch(statements);
// Rows as arrays (much cheaper for the Worker to handle than objects): { columns, rows }.
export async function rawRows(db, sql, ...p) {
  const [columns = [], ...rows] = await stmt(db, sql, ...p).raw({ columnNames: true });
  return { columns, rows };
}
export const isUnique = e => /UNIQUE constraint failed/i.test(String(e?.message || e));
export const nextId = async (db, table) => (await first(db, `SELECT COALESCE(MAX(id),0)+1 AS n FROM ${table}`)).n;

// SQLite stores booleans as 0/1; the app expects true/false for these columns.
const BOOL_KEYS = new Set(['active', 'deductible', 'uses_envelopes', 'skip_renumber', 'is_other_giver', 'use_alt']);
export function boolify(v) {
  if (Array.isArray(v)) return v.map(boolify);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (BOOL_KEYS.has(k) && (v[k] === 0 || v[k] === 1)) v[k] = v[k] === 1;
      else if (v[k] && typeof v[k] === 'object') boolify(v[k]);
    }
  }
  return v;
}

// ---------- parsing ----------
export function parseCents(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const s = String(input).replace(/[$,\s]/g, '');
  if (!s || !/^-?\d*(\.\d{0,2})?$/.test(s) || s === '-' || s === '.') return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole || 0) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}
export const blank = v => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
export function dateOrNull(v) {
  const s = blank(v);
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`Invalid date: ${s} (use YYYY-MM-DD)`);
  return s;
}
export function intOrNull(v) {
  const s = blank(v);
  if (s === null) return null;
  if (!/^-?\d+$/.test(s)) throw bad(`Not a whole number: ${s}`);
  return Number(s);
}
export const bool = v => v === true || v === 1 || v === 'true' || v === '1' || v === 'on';
export const thisYear = () => new Date().getUTCFullYear();
export const yearBounds = y => [`${y}-01-01`, `${y}-12-31`];

// Mailing address for a contributor_view row, honouring an active seasonal address.
export function mailAddress(r) {
  const alt = r.use_alt === 1 || r.use_alt === true;
  return {
    address1: alt ? r.alt_address1 : r.home_address1,
    address2: alt ? r.alt_address2 : r.home_address2,
    city: alt ? r.alt_city : r.home_city,
    state: alt ? r.alt_state : r.home_state,
    zip: alt ? r.alt_zip : r.home_zip,
  };
}

// ---------- CSV ----------
export function toCsv(rows, columns) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // stop spreadsheets running formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}
export function csvResponse(name, rows, cols) {
  return new Response(toCsv(rows, cols), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` },
  });
}

export async function audit(c, action, detail) {
  try {
    await run(c.db, 'INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)',
      c.user?.id ?? null, action, typeof detail === 'string' ? detail : JSON.stringify(detail));
  } catch (e) { console.error('audit failed', e.message); }
}
