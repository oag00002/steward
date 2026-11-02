// Restore a whole database from a file: a Steward "Full backup", or a file converted from
// Shepherd's Staff. Only works on a Steward that has no records yet, so nothing can be overwritten.
// The browser sends the file one table-piece at a time (start → chunk… → finish) to stay inside
// the free plan's per-request limits. Sign-ins (users) are never touched.
import { HttpError, bad, all, first, run, stmt, batch, audit } from '../lib.js';

// Tables in the order they must be loaded (parents before children), and the columns we accept.
// Columns that point at sign-ins (created_by, posted_by, entered_by) are left out on purpose:
// those people don't exist in the new copy.
export const RESTORE_TABLES = {
  settings: ['key', 'value'],
  households: ['id', 'name', 'mailing_name', 'address1', 'address2', 'city', 'state', 'zip',
    'alt_address1', 'alt_address2', 'alt_city', 'alt_state', 'alt_zip', 'alt_begin', 'alt_end',
    'phone', 'email', 'notes', 'active', 'created_at', 'updated_at'],
  people: ['id', 'household_id', 'first_name', 'last_name', 'suffix', 'nickname', 'relationship', 'gender',
    'birth_date', 'email', 'phone', 'status', 'membership_code', 'received_by', 'date_received',
    'baptism_date', 'confirmation_date', 'wedding_date', 'death_date', 'notes', 'created_at', 'updated_at'],
  funds: ['id', 'code', 'name', 'deductible', 'active'],
  events: ['id', 'name', 'attendance_type', 'active'],
  contributors: ['id', 'envelope_no', 'upcoming_envelope_no', 'prior_envelope_no', 'person_id', 'joint_person_id',
    'custom_name', 'other_name', 'other_address1', 'other_address2', 'other_city', 'other_state', 'other_zip',
    'other_email', 'statement_method', 'uses_envelopes', 'skip_renumber', 'active', 'notes', 'created_at'],
  batches: ['id', 'batch_date', 'description', 'status', 'counted_cash_cents', 'counted_checks_cents',
    'deposit_date', 'created_at', 'posted_at'],
  offerings: ['id', 'batch_id', 'contributor_id', 'fund_id', 'amount_cents', 'check_no', 'memo', 'client_id', 'created_at'],
  attendance_sessions: ['id', 'event_id', 'session_date', 'headcount', 'notes', 'created_at'],
  attendance_records: ['session_id', 'person_id'],
};
const DATA_TABLES = ['households', 'people', 'contributors', 'batches', 'offerings', 'attendance_sessions', 'attendance_records'];
const FLAG = 'restore_in_progress';
const MAX_JSON = 1_500_000; // bytes per piece; D1 allows 2 MB per value

async function hasRecords(db) {
  const row = await first(db, `SELECT ${DATA_TABLES.map(t => `(SELECT count(*) FROM ${t})`).join(' + ')} AS n`);
  return row.n > 0;
}
async function inProgress(db) {
  return !!(await first(db, 'SELECT 1 AS x FROM settings WHERE key = ? AND value = ?', FLAG, '1'));
}
// Children before parents, so foreign keys never block the wipe.
const wipeStatements = db => [...DATA_TABLES].reverse().concat(['funds', 'events']).map(t => stmt(db, `DELETE FROM ${t}`));

export default function (r) {
  r.get('/api/restore/status', 'admin', async c => ({ empty: !(await hasRecords(c.db)), in_progress: await inProgress(c.db) }));

  r.post('/api/restore/start', 'admin', async c => {
    if (!(await inProgress(c.db)) && await hasRecords(c.db)) {
      throw bad('This Steward already has records. A restore can only go into an empty Steward, so nothing gets overwritten.');
    }
    // Clear anything left from an earlier attempt, plus the starter funds and event (the file brings its own).
    await batch(c.db, [
      ...wipeStatements(c.db),
      stmt(c.db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', FLAG, '1'),
    ]);
    await audit(c, 'restore_start', '');
    return { ok: true };
  });

  // Body: { table, columns: [...], rows_json: "[[...],[...]]" }  (rows as a JSON string, so the Worker
  // never has to unpack them — the database reads them directly).
  r.post('/api/restore/chunk', 'admin', async c => {
    if (!(await inProgress(c.db))) throw bad('Start the restore first.');
    const body = await c.body();
    const allowed = RESTORE_TABLES[body.table];
    if (!allowed) throw bad(`Unknown table: ${body.table}`);
    if (!Array.isArray(body.columns) || typeof body.rows_json !== 'string') throw bad('Malformed piece.');
    if (body.rows_json.length > MAX_JSON) throw bad('That piece is too large.');
    const picks = body.columns.map((col, i) => [col, i]).filter(([col]) => allowed.includes(col));
    if (!picks.length) throw bad(`No usable columns for ${body.table}.`);
    const cols = picks.map(([col]) => col);
    const exprs = picks.map(([, i]) => `json_extract(value, '$[${i}]')`);
    const sql = body.table === 'settings'
      ? `INSERT INTO settings (key, value) SELECT ${exprs.join(', ')} FROM json_each(?) WHERE json_extract(value, '$[${picks[0][1]}]') <> '${FLAG}'
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      : `INSERT INTO ${body.table} (${cols.join(', ')}) SELECT ${exprs.join(', ')} FROM json_each(?)`;
    try {
      const meta = await run(c.db, sql, body.rows_json);
      return { ok: true, inserted: meta.changes };
    } catch (e) {
      const msg = String(e.message || e);
      if (/FOREIGN KEY|UNIQUE|NOT NULL|CHECK/i.test(msg)) throw bad(`Some ${body.table.replace('_', ' ')} rows don't fit: ${msg.replace(/^.*?: /, '')}`);
      if (/malformed JSON/i.test(msg)) throw bad('That file is damaged (bad JSON).');
      throw e;
    }
  });

  r.post('/api/restore/finish', 'admin', async c => {
    if (!(await inProgress(c.db))) throw bad('No restore is in progress.');
    await run(c.db, 'DELETE FROM settings WHERE key = ?', FLAG);
    // Make sure at least one fund and event exist so offerings and attendance can be entered.
    if (!(await first(c.db, 'SELECT 1 AS x FROM funds LIMIT 1'))) await run(c.db, `INSERT INTO funds (code, name) VALUES (1, 'General Offering')`);
    if (!(await first(c.db, 'SELECT 1 AS x FROM events LIMIT 1'))) await run(c.db, `INSERT INTO events (name, attendance_type) VALUES ('Sunday Worship', 'Worship')`);
    const counts = Object.fromEntries((await all(c.db, `SELECT 'households' AS t, count(*) AS n FROM households
      UNION ALL SELECT 'people', count(*) FROM people UNION ALL SELECT 'contributors', count(*) FROM contributors
      UNION ALL SELECT 'offerings', count(*) FROM offerings UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records`)).map(x => [x.t, x.n]));
    await audit(c, 'restore_finish', JSON.stringify(counts));
    return { ok: true, counts };
  });

  // Undo a half-finished restore.
  r.post('/api/restore/abort', 'admin', async c => {
    if (!(await inProgress(c.db))) throw new HttpError(409, 'No restore is in progress.');
    await batch(c.db, [
      ...wipeStatements(c.db),
      stmt(c.db, `INSERT INTO funds (code, name) VALUES (1, 'General Offering')`),
      stmt(c.db, `INSERT INTO events (name, attendance_type) VALUES ('Sunday Worship', 'Worship')`),
      stmt(c.db, 'DELETE FROM settings WHERE key = ?', FLAG),
    ]);
    await audit(c, 'restore_abort', '');
    return { ok: true };
  });
}
