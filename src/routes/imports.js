// Imports: membership + envelopes, and historical offerings.
// The browser reads the CSV and maps its columns to our field names (public/js/csv.js), then sends
// { rows: [...] }. Rows are written with a single JSON parameter per table (json_each), which keeps a
// whole import inside D1's per-request query limit and makes each request all-or-nothing.
import { bad, parseCents, all, stmt, batch, nextId, audit } from '../lib.js';

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const MAX_ROWS = 2000; // per request; the browser sends larger files in pieces

function rowsFrom(body) {
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) throw bad('The file has no rows. Make sure the first row holds column names.');
  if (rows.length > MAX_ROWS) throw bad(`Send at most ${MAX_ROWS} rows at a time.`);
  return rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r || {})) if (v !== null && v !== undefined && String(v).trim() !== '') o[k] = String(v).trim().slice(0, 500);
    return o;
  });
}

function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

const STATUS_MAP = { member: 'member', active: 'member', communicant: 'member', baptized: 'member', nonmember: 'nonmember',
  visitor: 'visitor', guest: 'visitor', friend: 'friend', inactive: 'inactive', deceased: 'deceased' };

// INSERT INTO table (cols) SELECT ... FROM json_each(?), split into chunks.
function jsonInserts(db, table, cols, rows, chunk = 1500) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk).map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? null])));
    out.push(stmt(db, `INSERT INTO ${table} (${cols.join(',')}) SELECT ${cols.map(c => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?)`, JSON.stringify(part)));
  }
  return out;
}

export default function (r) {
  // One row per household (head + optional spouse columns) OR one row per person with a Household ID column.
  r.post('/api/import/membership', 'finance', async c => {
    const body = await c.body();
    const rows = rowsFrom(body);
    const dryRun = body.dry_run !== false;
    const errors = [];
    const groups = new Map();
    rows.forEach((x, i) => {
      const line = Number(x._line) || i + 2;
      if (!x.first_name || !x.last_name) { errors.push(`Row ${line}: first and last name are required.`); return; }
      const key = x.household_id ? `id:${x.household_id}` : `row:${line}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...x, line });
    });

    const existingEnv = new Set((await all(c.db, 'SELECT envelope_no FROM contributors WHERE envelope_no IS NOT NULL')).map(x => x.envelope_no));
    const seenEnv = new Set();
    const plan = [];
    for (const g of groups.values()) {
      const head = g[0];
      const hh = { name: head.household_name || head.last_name, address1: head.address1, address2: head.address2, city: head.city, state: head.state, zip: head.zip, phone: head.phone };
      const people = [];
      let envelope = null;
      for (const x of g) {
        let rel = (x.relationship || '').toLowerCase();
        if (/head|primary/.test(rel)) rel = 'head';
        else if (/spouse|wife|husband/.test(rel)) rel = 'spouse';
        else if (/child|son|daughter/.test(rel)) rel = 'child';
        else rel = rel ? 'other' : (people.length ? null : 'head');
        const p = { first_name: x.first_name, last_name: x.last_name, relationship: rel, email: x.email || null, phone: x.cell || null,
          status: STATUS_MAP[norm(x.status || 'member')] || 'member', birth_date: parseDate(x.birth_date) };
        people.push(p);
        if (x.spouse_first) people.push({ first_name: x.spouse_first, last_name: x.spouse_last || x.last_name, relationship: 'spouse', status: p.status });
        if (x.envelope && !envelope) {
          const n = Number(String(x.envelope).replace(/\D/g, ''));
          if (!n) errors.push(`Row ${x.line}: envelope "${x.envelope}" is not a number.`);
          else if (existingEnv.has(n) || seenEnv.has(n)) errors.push(`Row ${x.line}: envelope ${n} is already used.`);
          else { envelope = { number: n, person: p }; seenEnv.add(n); }
        }
      }
      if (envelope) {
        const sp = people.find(pp => pp !== envelope.person && pp.relationship === 'spouse' && ['head', null].includes(envelope.person.relationship));
        envelope.joint = sp || null;
      }
      plan.push({ hh, people, envelope });
    }

    const summary = {
      households: plan.length,
      people: plan.reduce((a, p) => a + p.people.length, 0),
      envelopes: plan.filter(p => p.envelope).length,
      errors,
      preview: plan.slice(0, 8).map(p => ({ household: p.hh.name, people: p.people.map(x => `${x.first_name} ${x.last_name}`).join(', '), envelope: p.envelope?.number || null })),
    };
    if (dryRun || errors.length) return { dry_run: true, ...summary };

    let hid = await nextId(c.db, 'households');
    let pid = await nextId(c.db, 'people');
    const H = [], P = [], C = [];
    for (const p of plan) {
      const h = { id: hid++, ...p.hh };
      H.push(h);
      for (const person of p.people) { person.id = pid++; person.household_id = h.id; P.push(person); }
      if (p.envelope) C.push({ envelope_no: p.envelope.number, person_id: p.envelope.person.id, joint_person_id: p.envelope.joint?.id ?? null });
    }
    await batch(c.db, [
      ...jsonInserts(c.db, 'households', ['id', 'name', 'address1', 'address2', 'city', 'state', 'zip', 'phone'], H),
      ...jsonInserts(c.db, 'people', ['id', 'household_id', 'first_name', 'last_name', 'relationship', 'email', 'phone', 'status', 'birth_date'], P),
      ...jsonInserts(c.db, 'contributors', ['envelope_no', 'person_id', 'joint_person_id'], C),
    ]);
    await audit(c, 'import_membership', `${summary.households} households, ${summary.people} people, ${summary.envelopes} envelopes`);
    return { dry_run: false, ...summary };
  });

  // Columns: Envelope, Date, Fund (number or name), Amount, [Check], [Memo]. One batch per date.
  r.post('/api/import/offerings', 'finance', async c => {
    const body = await c.body();
    const rows = rowsFrom(body);
    const dryRun = body.dry_run !== false;
    const funds = await all(c.db, 'SELECT * FROM funds');
    const defaultFund = funds.filter(f => f.active).sort((a, b) => a.code - b.code)[0];
    const envMap = new Map((await all(c.db, 'SELECT id, envelope_no FROM contributors WHERE envelope_no IS NOT NULL')).map(x => [x.envelope_no, x.id]));
    const errors = [];
    const byDate = new Map();
    rows.forEach((x, i) => {
      const line = Number(x._line) || i + 2;
      const date = parseDate(x.date);
      if (!date) { errors.push(`Row ${line}: date "${x.date || ''}" is missing or not a date.`); return; }
      const cents = parseCents(x.amount);
      if (!cents) { errors.push(`Row ${line}: amount "${x.amount || ''}" is missing or not a number.`); return; }
      let fund = defaultFund;
      if (x.fund) {
        fund = /^\d+$/.test(x.fund) ? funds.find(f => f.code === Number(x.fund)) : funds.find(f => norm(f.name) === norm(x.fund));
        if (!fund) { errors.push(`Row ${line}: no fund matches "${x.fund}". Add it under Settings → Funds first.`); return; }
      }
      let contributorId = null;
      const env = Number(String(x.envelope || '').replace(/\D/g, ''));
      if (env) {
        contributorId = envMap.get(env);
        if (!contributorId) { errors.push(`Row ${line}: there is no envelope #${env}.`); return; }
      }
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ contributor_id: contributorId, fund_id: fund.id, amount_cents: cents, check_no: x.check_no || null, memo: x.memo || null });
    });
    const batches = [...byDate.entries()].sort().map(([date, lines]) => ({ date, lines: lines.length, total_cents: lines.reduce((a, l) => a + l.amount_cents, 0) }));
    const summary = { batches, rows: rows.length, errors, total_cents: batches.reduce((a, b) => a + b.total_cents, 0) };
    if (dryRun || errors.length) return { dry_run: true, ...summary };

    const label = String(body.description || 'Imported').slice(0, 120);
    const post = body.post === true;
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    let bid = await nextId(c.db, 'batches');
    const B = [], O = [];
    for (const [date, lines] of [...byDate.entries()].sort()) {
      const b = { id: bid++, batch_date: date, description: label, status: post ? 'posted' : 'open', created_by: c.user.id,
        posted_by: post ? c.user.id : null, posted_at: post ? stamp : null };
      B.push(b);
      for (const l of lines) O.push({ ...l, batch_id: b.id, entered_by: c.user.id });
    }
    await batch(c.db, [
      ...jsonInserts(c.db, 'batches', ['id', 'batch_date', 'description', 'status', 'created_by', 'posted_by', 'posted_at'], B),
      ...jsonInserts(c.db, 'offerings', ['batch_id', 'contributor_id', 'fund_id', 'amount_cents', 'check_no', 'memo', 'entered_by'], O),
    ]);
    await audit(c, 'import_offerings', `${rows.length} rows into ${batches.length} batches${post ? ' (posted)' : ''}`);
    return { dry_run: false, ...summary };
  });
}
