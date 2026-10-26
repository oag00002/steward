// Funds, contributors (envelopes) and offering batches.
import { HttpError, bad, notFound, blank, dateOrNull, intOrNull, parseCents, all, first, run, stmt, batch, isUnique, audit, thisYear, yearBounds } from '../lib.js';
import { RANK } from '../auth.js';

export const OTHER_ENVELOPE_START = 100000; // numbers for givers who don't use physical envelopes

async function usedNumbers(db) {
  return new Set((await all(db, 'SELECT envelope_no FROM contributors WHERE envelope_no IS NOT NULL')).map(r => r.envelope_no));
}
export async function nextAvailable(db) {
  const used = await usedNumbers(db);
  for (let n = 1; n < OTHER_ENVELOPE_START; n++) if (!used.has(n)) return n;
  return null;
}
async function nextHighest(db) {
  return (await first(db, `SELECT COALESCE(MAX(envelope_no),0)+1 AS n FROM contributors WHERE envelope_no < ${OTHER_ENVELOPE_START}`)).n;
}
export async function nextOther(db) {
  return (await first(db, `SELECT MAX(COALESCE(MAX(envelope_no),0)+1, ${OTHER_ENVELOPE_START}) AS n FROM contributors WHERE envelope_no >= ${OTHER_ENVELOPE_START}`)).n;
}

export function summarize(lines) {
  const byFund = {};
  let total = 0, checks = 0;
  const envelopes = new Set();
  for (const l of lines) {
    total += l.amount_cents;
    if (l.check_no) checks += l.amount_cents;
    if (l.contributor_id) envelopes.add(l.contributor_id);
    const k = l.fund_id;
    byFund[k] = byFund[k] || { fund_id: k, fund_code: l.fund_code, fund_name: l.fund_name, total_cents: 0, count: 0 };
    byFund[k].total_cents += l.amount_cents;
    byFund[k].count++;
  }
  return {
    total_cents: total, check_cents: checks, cash_cents: total - checks, line_count: lines.length, envelope_count: envelopes.size,
    by_fund: Object.values(byFund).sort((a, b) => a.fund_code - b.fund_code),
  };
}

const isFinance = c => RANK[c.user.role] >= RANK.finance;

async function loadBatch(c, id) {
  const b = await first(c.db, `SELECT b.*, cu.username AS created_by_name, pu.username AS posted_by_name
    FROM batches b LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users pu ON pu.id = b.posted_by WHERE b.id = ?`, id);
  if (!b) throw notFound('Batch');
  if (b.status === 'posted' && !isFinance(c)) throw new HttpError(403, 'Posted batches are only visible to the financial secretary.');
  return b;
}

const batchLines = (db, id) => all(db, `
  SELECT o.id, o.contributor_id, o.fund_id, o.amount_cents, o.check_no, o.memo, o.client_id, o.created_at,
    cv.envelope_no, COALESCE(cv.display_name, 'Loose offering (no envelope)') AS display_name,
    f.code AS fund_code, f.name AS fund_name, u.username AS entered_by
  FROM offerings o JOIN funds f ON f.id = o.fund_id
  LEFT JOIN contributor_view cv ON cv.id = o.contributor_id
  LEFT JOIN users u ON u.id = o.entered_by
  WHERE o.batch_id = ? ORDER BY o.id`, id);

async function validateContributor(db, body, id = null) {
  const c = {
    person_id: intOrNull(body.person_id),
    joint_person_id: intOrNull(body.joint_person_id),
    custom_name: blank(body.custom_name),
    other_name: blank(body.other_name),
    other_address1: blank(body.other_address1), other_address2: blank(body.other_address2),
    other_city: blank(body.other_city), other_state: blank(body.other_state), other_zip: blank(body.other_zip),
    other_email: blank(body.other_email),
    statement_method: ['mail', 'email', 'none'].includes(body.statement_method) ? body.statement_method : 'mail',
    uses_envelopes: body.uses_envelopes !== false ? 1 : 0,
    skip_renumber: body.skip_renumber === true ? 1 : 0,
    active: body.active !== false ? 1 : 0,
    notes: blank(body.notes),
  };
  if (!c.person_id && !c.other_name) throw bad('Choose a person from membership, or enter a name for an other giver.');
  if (c.joint_person_id && !c.person_id) throw bad('A joint contributor needs a primary contributor.');
  if (c.person_id && c.joint_person_id) {
    if (c.person_id === c.joint_person_id) throw bad('The joint contributor must be a different person.');
    const rows = await all(db, 'SELECT id, household_id FROM people WHERE id IN (?,?)', c.person_id, c.joint_person_id);
    if (rows.length !== 2 || rows[0].household_id !== rows[1].household_id) throw bad('A joint contributor must live in the same household.');
  }
  for (const pid of [c.person_id, c.joint_person_id].filter(Boolean)) {
    const hit = await first(db, 'SELECT envelope_no FROM contributors WHERE (person_id = ? OR joint_person_id = ?) AND active = 1 AND id <> ?', pid, pid, id || 0);
    if (hit) throw bad(`That person is already on envelope ${hit.envelope_no ?? '(no number)'}.`);
  }
  let env = body.envelope_no;
  if (env === 'next') env = await nextAvailable(db);
  else if (env === 'highest') env = await nextHighest(db);
  else env = intOrNull(env);
  if (env !== null && env < 0) throw bad('Envelope numbers must be positive.');
  if (env === 0) throw bad('Envelope 0 is reserved for loose offering.');
  if (!env && !c.uses_envelopes) env = await nextOther(db);
  c.envelope_no = env;
  c.upcoming_envelope_no = intOrNull(body.upcoming_envelope_no);
  return c;
}

async function resolveLine(db, body) {
  const amount = parseCents(body.amount ?? (body.amount_cents != null ? body.amount_cents / 100 : null));
  if (!amount) throw bad('Enter an amount.');
  if (Math.abs(amount) > 100000000) throw bad('That amount looks too large.');
  let contributorId = null;
  if (body.anonymous) contributorId = null;
  else if (body.contributor_id) {
    contributorId = Number(body.contributor_id);
    if (!(await first(db, 'SELECT id FROM contributors WHERE id = ?', contributorId))) throw bad('That envelope no longer exists.');
  } else if (blank(body.envelope_no)) {
    const env = intOrNull(body.envelope_no);
    const hit = await first(db, 'SELECT id FROM contributors WHERE envelope_no = ?', env);
    if (!hit) throw bad(`There is no envelope #${env}.`);
    contributorId = hit.id;
  } else throw bad('Enter an envelope number (or mark it as loose offering).');
  const fundId = Number(body.fund_id);
  if (!fundId || !(await first(db, 'SELECT id FROM funds WHERE id = ?', fundId))) throw bad('Choose a fund.');
  return { contributor_id: contributorId, fund_id: fundId, amount_cents: amount, check_no: blank(body.check_no), memo: blank(body.memo) };
}

export default function (r) {
  // ---------------- Funds ----------------
  r.get('/api/funds', 'counter', c => all(c.db, 'SELECT * FROM funds ORDER BY active DESC, code'));

  const saveFund = async (c, id) => {
    const body = await c.body();
    const code = intOrNull(body.code);
    const name = blank(body.name);
    if (!code || !name) throw bad('Fund number and name are required.');
    try {
      if (id) {
        const m = await run(c.db, 'UPDATE funds SET code=?, name=?, deductible=?, active=? WHERE id=?', code, name, body.deductible !== false, body.active !== false, id);
        if (!m.changes) throw notFound('Fund');
      } else {
        id = (await run(c.db, 'INSERT INTO funds (code, name, deductible, active) VALUES (?,?,?,?)', code, name, body.deductible !== false, body.active !== false)).last_row_id;
      }
    } catch (e) {
      if (isUnique(e)) throw bad(`Fund number ${code} is already used.`);
      throw e;
    }
    await audit(c, 'fund_save', `${code} ${name}`);
    return first(c.db, 'SELECT * FROM funds WHERE id = ?', id);
  };
  r.post('/api/funds', 'finance', c => saveFund(c, null));
  r.put('/api/funds/:id', 'finance', c => saveFund(c, c.params.id));

  // ---------------- Contributors / envelopes ----------------
  // Envelope -> name list for fast lookups while counting (cached on the phone).
  r.get('/api/contributors/directory', 'counter', c => all(c.db,
    'SELECT id, envelope_no, display_name, sort_name, active FROM contributor_view ORDER BY envelope_no IS NULL, envelope_no, sort_name'));

  r.get('/api/contributors', 'finance', async c => {
    const [from, to] = yearBounds(intOrNull(c.query.get('year')) || thisYear());
    return all(c.db, `
      SELECT cv.id, cv.envelope_no, cv.upcoming_envelope_no, cv.prior_envelope_no, cv.display_name, cv.sort_name,
        cv.household_id, cv.household_name, cv.is_other_giver, cv.statement_method, cv.uses_envelopes,
        cv.skip_renumber, cv.active, cv.person_id, cv.joint_person_id,
        COALESCE(t.total, 0) AS year_total_cents
      FROM contributor_view cv
      LEFT JOIN (SELECT o.contributor_id, SUM(o.amount_cents) AS total FROM offerings o JOIN batches b ON b.id = o.batch_id
        WHERE b.status = 'posted' AND b.batch_date BETWEEN ? AND ? GROUP BY o.contributor_id) t ON t.contributor_id = cv.id
      ORDER BY cv.active DESC, cv.envelope_no IS NULL, cv.envelope_no, cv.sort_name`, from, to);
  });

  r.get('/api/contributors/next-envelope', 'finance', async c => ({ next_available: await nextAvailable(c.db), next_highest: await nextHighest(c.db) }));

  r.get('/api/contributors/:id', 'finance', async c => {
    const row = await first(c.db, 'SELECT * FROM contributor_view WHERE id = ?', c.params.id);
    if (!row) throw notFound('Contributor');
    return row;
  });

  r.get('/api/contributors/:id/giving', 'finance', async c => {
    const [dFrom, dTo] = yearBounds(thisYear());
    const from = dateOrNull(c.query.get('from')) || dFrom;
    const to = dateOrNull(c.query.get('to')) || dTo;
    return all(c.db, `
      SELECT o.id, b.id AS batch_id, b.batch_date, b.status, f.code AS fund_code, f.name AS fund_name, o.amount_cents, o.check_no, o.memo
      FROM offerings o JOIN batches b ON b.id = o.batch_id JOIN funds f ON f.id = o.fund_id
      WHERE o.contributor_id = ? AND b.batch_date BETWEEN ? AND ?
      ORDER BY b.batch_date, f.code, o.id`, c.params.id, from, to);
  });

  const saveContributor = async (c, id) => {
    if (id && !(await first(c.db, 'SELECT id FROM contributors WHERE id = ?', id))) throw notFound('Contributor');
    const v = await validateContributor(c.db, await c.body(), id);
    const keys = Object.keys(v);
    try {
      if (id) await run(c.db, `UPDATE contributors SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => v[k]), id);
      else id = (await run(c.db, `INSERT INTO contributors (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => v[k]))).last_row_id;
    } catch (e) {
      if (isUnique(e)) throw bad(`Envelope ${v.envelope_no} is already assigned.`);
      throw e;
    }
    const full = await first(c.db, 'SELECT * FROM contributor_view WHERE id = ?', id);
    await audit(c, 'contributor_save', `#${full.envelope_no} ${full.display_name}`);
    return full;
  };
  r.post('/api/contributors', 'finance', c => saveContributor(c, null));
  r.put('/api/contributors/:id', 'finance', c => saveContributor(c, c.params.id));

  r.delete('/api/contributors/:id', 'finance', async c => {
    const g = await first(c.db, 'SELECT count(*) AS n FROM offerings WHERE contributor_id = ?', c.params.id);
    if (g.n) throw bad('This envelope has giving records. Mark it inactive instead of deleting it.');
    await run(c.db, 'DELETE FROM contributors WHERE id = ?', c.params.id);
    await audit(c, 'contributor_delete', c.params.id);
    return { ok: true };
  });

  // Year-end: fill in next year's envelope numbers.
  r.post('/api/contributors/renumber', 'finance', async c => {
    const body = await c.body();
    const start = intOrNull(body.start) || 1;
    const mode = body.mode === 'alphabetical' ? 'alphabetical' : 'keep_order';
    const rows = await all(c.db, `SELECT id, envelope_no, skip_renumber FROM contributor_view WHERE active = 1 AND uses_envelopes = 1
      ORDER BY ${mode === 'alphabetical' ? 'sort_name COLLATE NOCASE, envelope_no' : 'envelope_no IS NULL, envelope_no, sort_name COLLATE NOCASE'}`);
    const reserved = new Set(rows.filter(x => x.skip_renumber && x.envelope_no).map(x => x.envelope_no));
    let n = start;
    const plan = [];
    for (const row of rows) {
      if (row.skip_renumber) { plan.push({ id: row.id, n: row.envelope_no }); continue; }
      while (reserved.has(n)) n++;
      plan.push({ id: row.id, n });
      n++;
    }
    await run(c.db, `UPDATE contributors SET upcoming_envelope_no =
      (SELECT json_extract(j.value, '$.n') FROM json_each(?1) j WHERE json_extract(j.value, '$.id') = contributors.id)
      WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`, JSON.stringify(plan));
    await audit(c, 'envelope_renumber', `${mode} from ${start}`);
    return { ok: true, count: plan.filter((p, i) => !rows[i].skip_renumber).length };
  });

  r.post('/api/contributors/clear-upcoming', 'finance', async c => {
    await run(c.db, 'UPDATE contributors SET upcoming_envelope_no = NULL');
    await audit(c, 'envelope_clear_upcoming', '');
    return { ok: true };
  });

  // Year-end: make next year's numbers current. Old numbers are kept as prior_envelope_no.
  r.post('/api/contributors/apply-upcoming', 'finance', async c => {
    const dupes = await all(c.db, `SELECT upcoming_envelope_no AS n FROM contributors WHERE upcoming_envelope_no IS NOT NULL
      GROUP BY upcoming_envelope_no HAVING count(*) > 1`);
    if (dupes.length) throw bad(`Next year's numbers have duplicates: ${dupes.map(d => d.n).join(', ')}`);
    const clash = await all(c.db, `SELECT envelope_no AS n FROM contributors WHERE upcoming_envelope_no IS NULL AND envelope_no IN
      (SELECT upcoming_envelope_no FROM contributors WHERE upcoming_envelope_no IS NOT NULL)`);
    if (clash.length) throw bad(`These numbers would be used twice (a giver without a next-year number still holds them): ${clash.map(d => d.n).join(', ')}`);
    const count = (await first(c.db, 'SELECT count(*) AS n FROM contributors WHERE upcoming_envelope_no IS NOT NULL')).n;
    await batch(c.db, [
      stmt(c.db, 'UPDATE contributors SET prior_envelope_no = envelope_no, envelope_no = NULL WHERE upcoming_envelope_no IS NOT NULL'),
      stmt(c.db, 'UPDATE contributors SET envelope_no = upcoming_envelope_no, upcoming_envelope_no = NULL WHERE upcoming_envelope_no IS NOT NULL'),
    ]);
    await audit(c, 'envelope_apply_upcoming', `${count} envelopes`);
    return { ok: true, count };
  });

  // ---------------- Batches ----------------
  r.get('/api/batches', 'counter', async c => {
    const status = isFinance(c) ? blank(c.query.get('status')) : 'open';
    const year = intOrNull(c.query.get('year'));
    const where = [];
    const params = [];
    if (status) { where.push('b.status = ?'); params.push(status); }
    if (year) { where.push('b.batch_date BETWEEN ? AND ?'); params.push(...yearBounds(year)); }
    return all(c.db, `
      SELECT b.id, b.batch_date, b.description, b.status, b.posted_at, b.deposit_date, b.counted_cash_cents, b.counted_checks_cents,
        COALESCE(SUM(o.amount_cents),0) AS total_cents, count(o.id) AS line_count
      FROM batches b LEFT JOIN offerings o ON o.batch_id = b.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY b.id ORDER BY b.status = 'open' DESC, b.batch_date DESC, b.id DESC LIMIT 500`, ...params);
  });

  r.post('/api/batches', 'counter', async c => {
    const body = await c.body();
    const date = dateOrNull(body.batch_date);
    if (!date) throw bad('Choose the date for this offering.');
    const m = await run(c.db, 'INSERT INTO batches (batch_date, description, created_by) VALUES (?,?,?)', date, blank(body.description), c.user.id);
    await audit(c, 'batch_create', `${m.last_row_id} ${date}`);
    return first(c.db, 'SELECT * FROM batches WHERE id = ?', m.last_row_id);
  });

  r.get('/api/batches/:id', 'counter', async c => {
    const b = await loadBatch(c, c.params.id);
    const lines = await batchLines(c.db, b.id);
    return { ...b, lines, summary: summarize(lines) };
  });

  r.put('/api/batches/:id', 'counter', async c => {
    const b = await loadBatch(c, c.params.id);
    if (b.status !== 'open') throw bad('This batch is posted. Reopen it first to make changes.');
    const body = await c.body();
    const date = 'batch_date' in body ? dateOrNull(body.batch_date) : b.batch_date;
    if (!date) throw bad('The batch needs a date.');
    const num = v => (v === null || v === '' || v === undefined ? null : Math.round(Number(v)));
    await run(c.db, 'UPDATE batches SET batch_date=?, description=?, counted_cash_cents=?, counted_checks_cents=? WHERE id=?',
      date, 'description' in body ? blank(body.description) : b.description,
      'counted_cash_cents' in body ? num(body.counted_cash_cents) : b.counted_cash_cents,
      'counted_checks_cents' in body ? num(body.counted_checks_cents) : b.counted_checks_cents, b.id);
    return first(c.db, 'SELECT * FROM batches WHERE id = ?', b.id);
  });

  r.delete('/api/batches/:id', 'finance', async c => {
    const b = await loadBatch(c, c.params.id);
    if (b.status !== 'open') throw bad('Posted batches cannot be deleted. Reopen it first.');
    await run(c.db, 'DELETE FROM batches WHERE id = ?', b.id);
    await audit(c, 'batch_delete', `${b.id} ${b.batch_date}`);
    return { ok: true };
  });

  r.post('/api/batches/:id/lines', 'counter', async c => {
    const b = await loadBatch(c, c.params.id);
    const body = await c.body();
    const clientId = blank(body.client_id);
    if (clientId) {
      const existing = await first(c.db, 'SELECT id FROM offerings WHERE client_id = ?', clientId);
      if (existing) return { id: existing.id, duplicate: true };
    }
    if (b.status !== 'open') throw bad('This batch has been posted, so lines cannot be added.');
    const l = await resolveLine(c.db, body);
    try {
      const m = await run(c.db, `INSERT INTO offerings (batch_id, contributor_id, fund_id, amount_cents, check_no, memo, client_id, entered_by)
        VALUES (?,?,?,?,?,?,?,?)`, b.id, l.contributor_id, l.fund_id, l.amount_cents, l.check_no, l.memo, clientId, c.user.id);
      return new Response(JSON.stringify({ id: m.last_row_id }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      if (clientId && isUnique(e)) {
        const existing = await first(c.db, 'SELECT id FROM offerings WHERE client_id = ?', clientId);
        return { id: existing?.id, duplicate: true };
      }
      throw e;
    }
  });

  r.put('/api/batches/:id/lines/:lineId', 'counter', async c => {
    const b = await loadBatch(c, c.params.id);
    if (b.status !== 'open') throw bad('This batch is posted. Reopen it first to make changes.');
    const l = await resolveLine(c.db, await c.body());
    const m = await run(c.db, `UPDATE offerings SET contributor_id=?, fund_id=?, amount_cents=?, check_no=?, memo=? WHERE id=? AND batch_id=?`,
      l.contributor_id, l.fund_id, l.amount_cents, l.check_no, l.memo, c.params.lineId, b.id);
    if (!m.changes) throw notFound('Line');
    return { ok: true };
  });

  r.delete('/api/batches/:id/lines/:lineId', 'counter', async c => {
    const b = await loadBatch(c, c.params.id);
    if (b.status !== 'open') throw bad('This batch is posted. Reopen it first to make changes.');
    await run(c.db, 'DELETE FROM offerings WHERE id = ? AND batch_id = ?', c.params.lineId, b.id);
    return { ok: true };
  });

  r.post('/api/batches/:id/post', 'finance', async c => {
    const b = await loadBatch(c, c.params.id);
    if (b.status !== 'open') throw bad('This batch is already posted.');
    const lines = await batchLines(c.db, b.id);
    if (!lines.length) throw bad('This batch has no offerings to post.');
    const body = await c.body();
    const eventId = intOrNull(body.attendance_event_id);
    const statements = [
      stmt(c.db, `UPDATE batches SET status='posted', posted_by=?, posted_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), deposit_date=? WHERE id=? AND status='open'`,
        c.user.id, dateOrNull(body.deposit_date), b.id),
    ];
    // Optional: everyone who gave is marked present at an event on the batch date.
    if (eventId) {
      statements.push(
        stmt(c.db, 'INSERT INTO attendance_sessions (event_id, session_date) VALUES (?,?) ON CONFLICT (event_id, session_date) DO NOTHING', eventId, b.batch_date),
        stmt(c.db, `INSERT INTO attendance_records (session_id, person_id)
          SELECT (SELECT id FROM attendance_sessions WHERE event_id = ?1 AND session_date = ?2), pid FROM (
            SELECT ct.person_id AS pid FROM offerings o JOIN contributors ct ON ct.id = o.contributor_id WHERE o.batch_id = ?3
            UNION SELECT ct.joint_person_id FROM offerings o JOIN contributors ct ON ct.id = o.contributor_id WHERE o.batch_id = ?3
          ) WHERE pid IS NOT NULL ON CONFLICT DO NOTHING`, eventId, b.batch_date, b.id),
      );
    }
    const results = await batch(c.db, statements);
    const s = summarize(lines);
    await audit(c, 'batch_post', `${b.id} ${b.batch_date} $${(s.total_cents / 100).toFixed(2)}`);
    return { ok: true, attendance_marked: eventId ? results[2].meta.changes : 0 };
  });

  r.post('/api/batches/:id/reopen', 'finance', async c => {
    const b = await loadBatch(c, c.params.id);
    if (b.status !== 'posted') throw bad('This batch is not posted.');
    await run(c.db, `UPDATE batches SET status='open', posted_by=NULL, posted_at=NULL WHERE id=?`, b.id);
    await audit(c, 'batch_reopen', `${b.id} ${b.batch_date}`);
    return { ok: true };
  });
}
