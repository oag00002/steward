// Households and people.
import { bad, notFound, blank, dateOrNull, bool, all, first, run, stmt, batch, nextId, audit } from '../lib.js';

const HH_FIELDS = ['name', 'mailing_name', 'address1', 'address2', 'city', 'state', 'zip',
  'alt_address1', 'alt_address2', 'alt_city', 'alt_state', 'alt_zip', 'alt_begin', 'alt_end',
  'phone', 'email', 'notes', 'active'];
const PERSON_FIELDS = ['household_id', 'first_name', 'last_name', 'suffix', 'nickname', 'relationship',
  'gender', 'birth_date', 'email', 'phone', 'status', 'membership_code', 'received_by', 'date_received',
  'baptism_date', 'confirmation_date', 'wedding_date', 'death_date', 'notes'];
const DATE_FIELDS = new Set(['alt_begin', 'alt_end', 'birth_date', 'date_received', 'baptism_date',
  'confirmation_date', 'wedding_date', 'death_date']);
export const STATUSES = ['member', 'nonmember', 'visitor', 'friend', 'inactive', 'deceased'];

function clean(body, fields) {
  const out = {};
  for (const f of fields) {
    if (!(f in body)) continue;
    if (f === 'active') out[f] = body[f] !== false && body[f] !== 'false' ? 1 : 0;
    else if (f === 'household_id') out[f] = Number(body[f]) || null;
    else if (DATE_FIELDS.has(f)) out[f] = dateOrNull(body[f]);
    else out[f] = blank(body[f]);
  }
  return out;
}
const insertSql = (table, obj) => {
  const keys = Object.keys(obj);
  return [`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => obj[k])];
};
async function updateRow(db, table, id, obj) {
  const keys = Object.keys(obj);
  if (keys.length) {
    const ts = ['households', 'people'].includes(table) ? `, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')` : '';
    await run(db, `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')}${ts} WHERE id = ?`, ...keys.map(k => obj[k]), id);
  }
  return first(db, `SELECT * FROM ${table} WHERE id = ?`, id);
}

export default function (r) {
  // People search (counters use this for attendance).
  r.get('/api/people', 'counter', async c => {
    const term = blank(c.query.get('q'));
    const status = blank(c.query.get('status'));
    const where = [];
    const params = [];
    if (term) {
      where.push(`(lower(p.first_name || ' ' || p.last_name) LIKE ? OR lower(COALESCE(p.nickname,'')) LIKE ? OR lower(hh.name) LIKE ?)`);
      const t = `%${term.toLowerCase()}%`;
      params.push(t, t, t);
    }
    if (status) { where.push('p.status = ?'); params.push(status); } else where.push(`p.status <> 'deceased'`);
    return all(c.db, `SELECT p.id, p.first_name, p.last_name, p.nickname, p.status, p.household_id, hh.name AS household_name
      FROM people p JOIN households hh ON hh.id = p.household_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE LIMIT ${term ? 50 : 3000}`, ...params);
  });

  r.get('/api/households', 'finance', async c => {
    const term = blank(c.query.get('q'));
    const params = [];
    let where = '';
    if (term) {
      const t = `%${term.toLowerCase()}%`;
      where = `WHERE lower(hh.name) LIKE ? OR EXISTS (SELECT 1 FROM people p WHERE p.household_id = hh.id AND lower(p.first_name || ' ' || p.last_name) LIKE ?)
               OR lower(COALESCE(hh.city,'')) LIKE ? OR COALESCE(hh.phone,'') LIKE ?`;
      params.push(t, t, t, t);
    }
    return all(c.db, `
      SELECT hh.id, hh.name, hh.city, hh.state, hh.phone, hh.active,
        (SELECT group_concat(first_name, ', ') FROM (SELECT p.first_name FROM people p WHERE p.household_id = hh.id AND p.status <> 'deceased'
           ORDER BY p.relationship = 'head' DESC, p.birth_date IS NULL, p.birth_date, p.id)) AS people,
        (SELECT group_concat(envelope_no, ', ') FROM (SELECT c.envelope_no FROM contributors c JOIN people p ON p.id = c.person_id
           WHERE p.household_id = hh.id AND c.envelope_no IS NOT NULL ORDER BY c.envelope_no)) AS envelopes
      FROM households hh ${where}
      ORDER BY hh.active DESC, hh.name COLLATE NOCASE LIMIT 1000`, ...params);
  });

  r.get('/api/households/:id', 'finance', async c => {
    const hh = await first(c.db, 'SELECT * FROM households WHERE id = ?', c.params.id);
    if (!hh) throw notFound('Household');
    const people = await all(c.db, `SELECT * FROM people WHERE household_id = ?
      ORDER BY CASE relationship WHEN 'head' THEN 0 WHEN 'spouse' THEN 1 WHEN 'child' THEN 2 ELSE 3 END, birth_date IS NULL, birth_date, id`, c.params.id);
    const contributors = await all(c.db, `SELECT id, envelope_no, display_name, person_id, joint_person_id, statement_method, active
      FROM contributor_view WHERE household_id = ? ORDER BY envelope_no IS NULL, envelope_no`, c.params.id);
    return { ...hh, people, contributors };
  });

  r.post('/api/households', 'finance', async c => {
    const body = await c.body();
    const hh = clean(body, HH_FIELDS);
    if (!hh.name) throw bad('Household name is required.');
    hh.id = await nextId(c.db, 'households');
    const statements = [stmt(c.db, ...flat(insertSql('households', hh)))];
    let pid = await nextId(c.db, 'people');
    for (const p of body.people || []) {
      const person = clean({ ...p, household_id: hh.id }, PERSON_FIELDS);
      if (!person.first_name) continue;
      person.last_name = person.last_name || hh.name;
      person.status = STATUSES.includes(person.status) ? person.status : 'member';
      person.id = pid++;
      statements.push(stmt(c.db, ...flat(insertSql('people', person))));
    }
    await batch(c.db, statements);
    await audit(c, 'household_create', `${hh.id} ${hh.name}`);
    return first(c.db, 'SELECT * FROM households WHERE id = ?', hh.id);
  });

  r.put('/api/households/:id', 'finance', async c => {
    const hh = clean(await c.body(), HH_FIELDS);
    if ('name' in hh && !hh.name) throw bad('Household name is required.');
    const row = await updateRow(c.db, 'households', c.params.id, hh);
    if (!row) throw notFound('Household');
    await audit(c, 'household_update', `${row.id} ${row.name}`);
    return row;
  });

  r.delete('/api/households/:id', 'finance', async c => {
    const g = await first(c.db, `SELECT count(*) AS n FROM offerings o JOIN contributors ct ON ct.id = o.contributor_id
      JOIN people p ON p.id IN (ct.person_id, ct.joint_person_id) WHERE p.household_id = ?`, c.params.id);
    if (g.n) throw bad('This household has giving records. Mark it inactive instead of deleting it.');
    await batch(c.db, [
      stmt(c.db, `DELETE FROM contributors WHERE person_id IN (SELECT id FROM people WHERE household_id = ?)
        AND NOT EXISTS (SELECT 1 FROM offerings o WHERE o.contributor_id = contributors.id)`, c.params.id),
      stmt(c.db, 'DELETE FROM households WHERE id = ?', c.params.id),
    ]);
    await audit(c, 'household_delete', c.params.id);
    return { ok: true };
  });

  r.get('/api/people/:id', 'finance', async c => {
    const p = await first(c.db, 'SELECT * FROM people WHERE id = ?', c.params.id);
    if (!p) throw notFound('Person');
    return p;
  });

  r.post('/api/people', 'finance', async c => {
    const p = clean(await c.body(), PERSON_FIELDS);
    if (!p.household_id) throw bad('Choose a household for this person.');
    if (!p.first_name || !p.last_name) throw bad('First and last name are required.');
    if (p.status && !STATUSES.includes(p.status)) throw bad('Unknown membership status.');
    const [sql, vals] = insertSql('people', p);
    const meta = await run(c.db, sql, ...vals);
    await audit(c, 'person_create', `${meta.last_row_id} ${p.first_name} ${p.last_name}`);
    return first(c.db, 'SELECT * FROM people WHERE id = ?', meta.last_row_id);
  });

  r.put('/api/people/:id', 'finance', async c => {
    const p = clean(await c.body(), PERSON_FIELDS);
    if (('first_name' in p && !p.first_name) || ('last_name' in p && !p.last_name)) throw bad('First and last name are required.');
    if (p.status && !STATUSES.includes(p.status)) throw bad('Unknown membership status.');
    delete p.household_id;
    const row = await updateRow(c.db, 'people', c.params.id, p);
    if (!row) throw notFound('Person');
    await audit(c, 'person_update', `${row.id} ${row.first_name} ${row.last_name}`);
    return row;
  });

  r.delete('/api/people/:id', 'finance', async c => {
    const g = await first(c.db, `SELECT count(*) AS n FROM offerings o JOIN contributors ct ON ct.id = o.contributor_id
      WHERE ? IN (ct.person_id, ct.joint_person_id)`, c.params.id);
    if (g.n) throw bad('This person has giving records. Change their status to inactive instead of deleting them.');
    await batch(c.db, [
      stmt(c.db, 'DELETE FROM contributors WHERE person_id = ?', c.params.id),
      stmt(c.db, 'DELETE FROM people WHERE id = ?', c.params.id),
    ]);
    await audit(c, 'person_delete', c.params.id);
    return { ok: true };
  });
}

const flat = ([sql, vals]) => [sql, ...vals];
export { bool };
