// Dashboard, reports, year-end statements and exports.
import { bad, blank, dateOrNull, intOrNull, all, first, rawRows, csvResponse, mailAddress, thisYear, yearBounds } from '../lib.js';

const range = c => {
  const [f, t] = yearBounds(thisYear());
  return [dateOrNull(c.query.get('from')) || f, dateOrNull(c.query.get('to')) || t];
};
const dollars = cents => (cents / 100).toFixed(2);

export default function (r) {
  r.get('/api/dashboard', 'counter', async c => {
    const out = {};
    out.open_batches = await all(c.db, `SELECT b.id, b.batch_date, b.description, count(o.id) AS line_count, COALESCE(SUM(o.amount_cents),0) AS total_cents
      FROM batches b LEFT JOIN offerings o ON o.batch_id = b.id WHERE b.status='open' GROUP BY b.id ORDER BY b.batch_date DESC`);
    if (c.user.role !== 'counter') {
      const [from, to] = yearBounds(thisYear());
      out.ytd_cents = (await first(c.db, `SELECT COALESCE(SUM(o.amount_cents),0) AS t FROM offerings o JOIN batches b ON b.id=o.batch_id
        WHERE b.status='posted' AND b.batch_date BETWEEN ? AND ?`, from, to)).t;
      out.recent = (await all(c.db, `SELECT b.batch_date, SUM(o.amount_cents) AS total_cents FROM batches b JOIN offerings o ON o.batch_id=b.id
        WHERE b.status='posted' GROUP BY b.batch_date ORDER BY b.batch_date DESC LIMIT 10`)).reverse();
      out.members = await all(c.db, 'SELECT status, count(*) AS n FROM people GROUP BY status ORDER BY n DESC');
    }
    out.attendance = await all(c.db, `SELECT s.session_date, e.name, COALESCE(s.headcount, (SELECT count(*) FROM attendance_records ar WHERE ar.session_id=s.id)) AS n
      FROM attendance_sessions s JOIN events e ON e.id=s.event_id ORDER BY s.session_date DESC LIMIT 8`);
    return out;
  });

  // ---- Year-end giving statements ----
  // Returns lean data; the browser groups gifts into one letter per giver.
  r.get('/api/statements', 'finance', async c => {
    const [from, to] = range(c);
    const where = [];
    const params = [];
    const one = intOrNull(c.query.get('contributor_id'));
    if (one) { where.push('cv.id = ?'); params.push(one); }
    const ef = intOrNull(c.query.get('env_from')), et = intOrNull(c.query.get('env_to'));
    if (ef) { where.push('cv.envelope_no >= ?'); params.push(ef); }
    if (et) { where.push('cv.envelope_no <= ?'); params.push(et); }
    const method = c.query.get('method');
    if (!one) {
      if (method === 'mail' || method === 'email') { where.push('cv.statement_method = ?'); params.push(method); }
      else where.push(`cv.statement_method <> 'none'`);
    }
    const filter = where.length ? 'AND ' + where.join(' AND ') : '';
    const givers = await all(c.db, `
      SELECT cv.id, cv.envelope_no, cv.prior_envelope_no, cv.display_name, cv.sort_name, cv.statement_method, cv.use_alt,
        cv.home_address1, cv.home_address2, cv.home_city, cv.home_state, cv.home_zip,
        cv.alt_address1, cv.alt_address2, cv.alt_city, cv.alt_state, cv.alt_zip, cv.mail_email
      FROM contributor_view cv
      WHERE EXISTS (SELECT 1 FROM offerings o JOIN batches b ON b.id = o.batch_id
        WHERE o.contributor_id = cv.id AND b.status = 'posted' AND b.batch_date BETWEEN ? AND ?) ${filter}`, from, to, ...params);
    const contributors = givers.map(x => {
      const a = mailAddress(x);
      return { id: x.id, envelope_no: x.envelope_no, prior_envelope_no: x.prior_envelope_no, name: x.display_name, sort_name: x.sort_name,
        statement_method: x.statement_method, email: x.mail_email, zip: a.zip, address: [a.address1, a.address2].filter(Boolean),
        city_line: [a.city && `${a.city},`, a.state, a.zip].filter(Boolean).join(' ') };
    });
    // gifts: [contributor_id, date, fund_id, amount_cents]
    const gifts = await rawRows(c.db, `
      SELECT o.contributor_id, b.batch_date, o.fund_id, o.amount_cents
      FROM offerings o JOIN batches b ON b.id = o.batch_id AND b.status = 'posted' AND b.batch_date BETWEEN ? AND ?
      JOIN contributor_view cv ON cv.id = o.contributor_id
      WHERE 1 = 1 ${filter}
      ORDER BY b.batch_date, o.fund_id, o.id`, from, to, ...params);
    const funds = await all(c.db, 'SELECT id, code, name, deductible FROM funds');
    const settings = Object.fromEntries((await all(c.db, 'SELECT key, value FROM settings')).map(x => [x.key, x.value]));
    return { from, to, settings, funds, contributors, gifts: gifts.rows };
  });

  // ---- Giving by fund and month ----
  r.get('/api/reports/funds', 'finance', async c => {
    const [from, to] = range(c);
    const rows = await all(c.db, `
      SELECT f.code, f.name, substr(b.batch_date, 1, 7) AS month, SUM(o.amount_cents) AS total_cents, count(*) AS gifts
      FROM offerings o JOIN batches b ON b.id=o.batch_id AND b.status='posted' JOIN funds f ON f.id=o.fund_id
      WHERE b.batch_date BETWEEN ? AND ? GROUP BY f.code, f.name, month ORDER BY f.code, month`, from, to);
    if (c.query.get('format') === 'csv') return csvResponse(`giving-by-fund-${from}-to-${to}.csv`, rows.map(x => ({ ...x, total: dollars(x.total_cents) })), ['code', 'name', 'month', 'gifts', 'total']);
    return { from, to, rows };
  });

  // ---- Totals per contributor ----
  r.get('/api/reports/contributors', 'finance', async c => {
    const [from, to] = range(c);
    const rows = await all(c.db, `
      SELECT cv.envelope_no, cv.display_name, cv.sort_name, count(o.id) AS gifts, SUM(o.amount_cents) AS total_cents,
        SUM(CASE WHEN f.deductible = 1 THEN o.amount_cents ELSE 0 END) AS deductible_cents, MAX(b.batch_date) AS last_gift
      FROM offerings o JOIN batches b ON b.id=o.batch_id AND b.status='posted' JOIN funds f ON f.id=o.fund_id
      JOIN contributor_view cv ON cv.id=o.contributor_id
      WHERE b.batch_date BETWEEN ? AND ?
      GROUP BY cv.id ORDER BY cv.envelope_no IS NULL, cv.envelope_no, cv.sort_name COLLATE NOCASE`, from, to);
    const loose = (await first(c.db, `SELECT COALESCE(SUM(o.amount_cents),0) AS t FROM offerings o JOIN batches b ON b.id=o.batch_id AND b.status='posted'
      WHERE o.contributor_id IS NULL AND b.batch_date BETWEEN ? AND ?`, from, to)).t;
    if (c.query.get('format') === 'csv') {
      return csvResponse(`giving-by-envelope-${from}-to-${to}.csv`,
        rows.map(x => ({ ...x, total: dollars(x.total_cents), deductible: dollars(x.deductible_cents) })),
        ['envelope_no', 'display_name', 'gifts', 'deductible', 'total', 'last_gift']);
    }
    return { from, to, rows, loose_cents: loose };
  });

  // ---- Attendance ----
  r.get('/api/reports/attendance', 'finance', async c => {
    const [from, to] = range(c);
    const ev = intOrNull(c.query.get('event_id'));
    const evSql = ev ? 'AND s.event_id = ?' : '';
    const evP = ev ? [ev] : [];
    const sessions = await all(c.db, `
      SELECT s.id, s.session_date, e.name AS event_name, e.attendance_type, s.headcount,
        (SELECT count(*) FROM attendance_records ar WHERE ar.session_id = s.id) AS recorded
      FROM attendance_sessions s JOIN events e ON e.id = s.event_id
      WHERE s.session_date BETWEEN ? AND ? ${evSql} ORDER BY s.session_date, e.name`, from, to, ...evP);
    const people = await all(c.db, `
      SELECT p.id, p.first_name, p.last_name, p.status, hh.name AS household_name,
        (SELECT count(*) FROM attendance_records ar JOIN attendance_sessions s ON s.id = ar.session_id
          WHERE ar.person_id = p.id AND s.session_date BETWEEN ? AND ? ${evSql}) AS times,
        (SELECT MAX(s.session_date) FROM attendance_records ar JOIN attendance_sessions s ON s.id = ar.session_id
          WHERE ar.person_id = p.id AND s.session_date BETWEEN ? AND ? ${evSql}) AS last_attended,
        (SELECT MAX(s.session_date) FROM attendance_records ar JOIN attendance_sessions s ON s.id = ar.session_id
          WHERE ar.person_id = p.id) AS last_attended_ever
      FROM people p JOIN households hh ON hh.id = p.household_id
      WHERE p.status IN ('member','nonmember','friend','visitor')
      ORDER BY times ASC, p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE`, from, to, ...evP, from, to, ...evP);
    if (c.query.get('format') === 'csv') {
      return csvResponse(`attendance-${from}-to-${to}.csv`, people, ['last_name', 'first_name', 'household_name', 'status', 'times', 'last_attended', 'last_attended_ever']);
    }
    return { from, to, sessions, people, session_count: sessions.length };
  });

  // ---- Directory ----
  r.get('/api/reports/directory', 'finance', async c => {
    const status = blank(c.query.get('status'));
    const rows = await all(c.db, `
      SELECT hh.id, hh.name, hh.address1, hh.address2, hh.city, hh.state, hh.zip, hh.phone, hh.email,
        (SELECT json_group_array(json_object('first_name', first_name, 'last_name', last_name, 'relationship', relationship,
            'phone', phone, 'email', email, 'birth_date', birth_date, 'status', status))
         FROM (SELECT * FROM people p WHERE p.household_id = hh.id AND p.status <> 'deceased' ${status ? 'AND p.status = ?1' : ''}
           ORDER BY CASE p.relationship WHEN 'head' THEN 0 WHEN 'spouse' THEN 1 WHEN 'child' THEN 2 ELSE 3 END, p.birth_date IS NULL, p.birth_date)) AS people
      FROM households hh WHERE hh.active = 1
        AND EXISTS (SELECT 1 FROM people p WHERE p.household_id = hh.id AND p.status <> 'deceased' ${status ? 'AND p.status = ?1' : ''})
      ORDER BY hh.name COLLATE NOCASE`, ...(status ? [status] : []));
    for (const h of rows) h.people = JSON.parse(h.people || '[]');
    if (c.query.get('format') === 'csv') {
      const flat = rows.flatMap(hh => hh.people.map(p => ({ household: hh.name, ...p, address1: hh.address1, address2: hh.address2, city: hh.city, state: hh.state, zip: hh.zip, household_phone: hh.phone })));
      return csvResponse('directory.csv', flat);
    }
    return rows;
  });

  // ---- Exports / backup ----
  const EXPORTS = {
    households: 'SELECT * FROM households ORDER BY id',
    people: 'SELECT * FROM people ORDER BY id',
    contributors: `SELECT id, envelope_no, upcoming_envelope_no, prior_envelope_no, display_name, person_id, joint_person_id, custom_name, other_name,
      CASE WHEN use_alt THEN alt_address1 ELSE home_address1 END AS address1, CASE WHEN use_alt THEN alt_address2 ELSE home_address2 END AS address2,
      CASE WHEN use_alt THEN alt_city ELSE home_city END AS city, CASE WHEN use_alt THEN alt_state ELSE home_state END AS state,
      CASE WHEN use_alt THEN alt_zip ELSE home_zip END AS zip, mail_email AS email, statement_method, uses_envelopes, active
      FROM contributor_view ORDER BY envelope_no IS NULL, envelope_no`,
    funds: 'SELECT * FROM funds ORDER BY code',
    offerings: `SELECT o.id, b.id AS batch_id, b.batch_date, b.status, cv.envelope_no, cv.display_name, f.code AS fund_code, f.name AS fund_name,
      printf('%.2f', o.amount_cents / 100.0) AS amount, o.check_no, o.memo
      FROM offerings o JOIN batches b ON b.id=o.batch_id JOIN funds f ON f.id=o.fund_id LEFT JOIN contributor_view cv ON cv.id=o.contributor_id ORDER BY b.batch_date, o.id`,
    attendance: `SELECT s.session_date, e.name AS event, p.id AS person_id, p.first_name, p.last_name
      FROM attendance_records ar JOIN attendance_sessions s ON s.id=ar.session_id JOIN events e ON e.id=s.event_id JOIN people p ON p.id=ar.person_id
      ORDER BY s.session_date, e.name, p.last_name`,
  };

  // Paged so no single request does too much work: { columns, rows, next_offset }.
  const PAGE = 4000;
  const page = async (c, sql) => {
    const offset = Math.max(0, intOrNull(c.query.get('offset')) || 0);
    const { columns, rows } = await rawRows(c.db, `${sql} LIMIT ${PAGE + 1} OFFSET ${offset}`);
    const more = rows.length > PAGE;
    return { columns, rows: more ? rows.slice(0, PAGE) : rows, next_offset: more ? offset + PAGE : null };
  };
  const TABLES = new Set(['settings', 'households', 'people', 'funds', 'contributors', 'batches', 'offerings', 'events', 'attendance_sessions', 'attendance_records']);

  r.get('/api/export/table/:name', 'finance', c => {
    if (!TABLES.has(c.params.name)) throw bad('Unknown table.');
    return page(c, `SELECT * FROM ${c.params.name} ORDER BY rowid`);
  });

  r.get('/api/export/:name', 'finance', c => {
    const sql = EXPORTS[c.params.name];
    if (!sql) throw bad('Unknown export.');
    return page(c, sql);
  });
}
