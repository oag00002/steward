// End-to-end API check against a running server.
// Usage: BASE=http://localhost:3000 USER=owen PASS=... node test/smoke.js   (uses a scratch database!)
const BASE = process.env.BASE || 'http://localhost:3000';
let cookie = '';
async function api(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Steward': '1', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`); e.status = res.status; e.data = data; throw e; }
  return data;
}
// Test-side CSV reader: header names here already match the app's field names.
const rowsOf = csv => { const [h, ...lines] = csv.trim().split('\n'); const keys = h.split(',');
  return lines.map((l, i) => Object.fromEntries([...keys.map((k, j) => [k, l.split(',')[j] ?? '']), ['_line', i + 2]])); };
// Mirrors buildStatements() in public/js/reports.js.
const group = d => {
  const funds = new Map(d.funds.map(f => [f.id, f]));
  const by = new Map(d.contributors.map(c => [c.id, { ...c, lines: [], funds: {}, total_cents: 0 }]));
  for (const [cid, date, fid, cents] of d.gifts) { const s = by.get(cid); const f = funds.get(fid); s.lines.push({ date, cents }); s.funds[fid] = 1; s.total_cents += cents; }
  return { statements: [...by.values()].map(s => ({ ...s, funds: Object.keys(s.funds) })) };
};
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };

(async () => {
  // Brand-new site: create the administrator through the first-run setup screen's API.
  const me0 = await api('GET', '/auth/me');
  if (me0.needs_setup) {
    try { await api('POST', '/auth/setup', { setup_code: 'wrong-code-123', username: 'owen', password: process.env.PASS }); assert(false, 'bad setup code'); }
    catch (e) { assert(e.status === 401, 'wrong setup code refused'); }
    await api('POST', '/auth/setup', { setup_code: process.env.SETUP_CODE, username: process.env.USER_NAME || 'owen', password: process.env.PASS });
    console.log('ok - first administrator created through setup');
  }
  await api('POST', '/auth/login', { username: process.env.USER_NAME || 'owen', password: process.env.PASS });
  try { await api('POST', '/auth/setup', { setup_code: process.env.SETUP_CODE, username: 'intruder', password: 'xxxxxxxxxxxx' }); assert(false, 'setup locked'); }
  catch (e) { assert(e.status === 409, 'setup is closed once an administrator exists'); }
  const tag = Date.now() % 100000;

  // Membership import
  const csv = `household_id,first_name,last_name,relationship,address1,city,state,zip,envelope,email
H1,John,Smith${tag},Head,1 Main St,Uniontown,PA,15401,${tag % 900 + 1},john@example.com
H1,Mary,Smith${tag},Spouse,,,,,,
H1,Tim,Smith${tag},Child,,,,,,
H2,Ann,Jones${tag},Head,2 Oak Ave,Morgantown,WV,26505,${tag % 900 + 2},`;
  const dry = await api('POST', '/import/membership', { rows: rowsOf(csv), dry_run: true });
  assert(dry.households === 2 && dry.people === 4 && dry.envelopes === 2 && !dry.errors.length, 'membership import dry run');
  await api('POST', '/import/membership', { rows: rowsOf(csv), dry_run: false });
  const dir = await api('GET', '/contributors/directory');
  const smith = dir.find(d => d.envelope_no === tag % 900 + 1);
  assert(smith && smith.display_name === `John & Mary Smith${tag}`, 'joint envelope name: ' + smith?.display_name);

  // Other giver with auto number
  const other = await api('POST', '/contributors', { other_name: `Visitor ${tag}`, uses_envelopes: false, other_city: 'Pittsburgh' });
  assert(other.envelope_no >= 100000, 'other giver gets high number ' + other.envelope_no);

  // Funds
  const funds = await api('GET', '/funds');
  const general = funds.find(f => f.code === 1), building = funds.find(f => f.code === 2);

  // Batch with fast entry
  const b = await api('POST', '/batches', { batch_date: '2026-10-25', description: 'Sunday' });
  const cid = 'test-' + Math.random();
  await api('POST', `/batches/${b.id}/lines`, { client_id: cid, envelope_no: smith.envelope_no, fund_id: general.id, amount: '50' });
  const dup = await api('POST', `/batches/${b.id}/lines`, { client_id: cid, envelope_no: smith.envelope_no, fund_id: general.id, amount: '50' });
  assert(dup.duplicate, 'retry of same line is ignored (offline queue safety)');
  await api('POST', `/batches/${b.id}/lines`, { envelope_no: smith.envelope_no, fund_id: building.id, amount: '25.50', check_no: '1042' });
  await api('POST', `/batches/${b.id}/lines`, { envelope_no: tag % 900 + 2, fund_id: general.id, amount: '$1,000' });
  await api('POST', `/batches/${b.id}/lines`, { anonymous: true, fund_id: general.id, amount: '17.25' });
  await api('POST', `/batches/${b.id}/lines`, { contributor_id: other.id, fund_id: general.id, amount: '40' });
  try { await api('POST', `/batches/${b.id}/lines`, { envelope_no: 99999, fund_id: general.id, amount: '5' }); assert(false, 'unknown envelope rejected'); }
  catch (e) { assert(e.status === 400, 'unknown envelope rejected'); }
  const full = await api('GET', `/batches/${b.id}`);
  assert(full.summary.total_cents === 113275, 'batch total $1132.75 = ' + full.summary.total_cents);
  assert(full.summary.check_cents === 2550, 'check total');
  assert(full.summary.envelope_count === 3, 'envelope count');

  // Post with attendance
  const events = await api('GET', '/events');
  const post = await api('POST', `/batches/${b.id}/post`, { attendance_event_id: events[0].id, deposit_date: '2026-10-26' });
  assert(post.attendance_marked >= 3, 'givers marked present: ' + post.attendance_marked);
  try { await api('POST', `/batches/${b.id}/lines`, { envelope_no: smith.envelope_no, fund_id: general.id, amount: '5' }); assert(false, 'posted locked'); }
  catch (e) { assert(e.status === 400, 'posted batch is locked'); }

  // Offerings import (historical)
  const ocsv = `envelope,date,fund,amount\n${smith.envelope_no},01/05/2026,1,20\n${smith.envelope_no},1/12/2026,Building Fund,30.00\n,1/12/2026,1,8`;
  const od = await api('POST', '/import/offerings', { rows: rowsOf(ocsv), dry_run: true });
  assert(od.batches.length === 2 && od.total_cents === 5800 && !od.errors.length, 'offerings import dry run');
  await api('POST', '/import/offerings', { rows: rowsOf(ocsv), dry_run: false, post: true, description: 'From Shepherd\'s Staff' });

  // Statements
  const st = group(await api('GET', `/statements?from=2026-01-01&to=2026-12-31&contributor_id=${smith.id}`));
  const s = st.statements[0];
  assert(s && s.total_cents === 5000 + 2550 + 2000 + 3000, 'statement total for Smiths ' + s?.total_cents);
  assert(s.lines.length === 4 && s.funds.length === 2, 'itemized lines and fund summary');
  assert(s.city_line.includes('Uniontown'), 'address on statement');
  const all = group(await api('GET', '/statements?from=2026-01-01&to=2026-12-31'));
  assert(!all.statements.some(x => x.name.startsWith('Loose')), 'loose offering has no statement');

  // Reports
  const rc = await api('GET', '/reports/contributors?from=2026-01-01&to=2026-12-31');
  assert(rc.loose_cents >= 2525, 'loose offering total reported');
  const ra = await api('GET', '/reports/attendance?from=2026-10-01&to=2026-10-31');
  assert(ra.sessions.length >= 1, 'attendance report has a session');
  const csvOut = await api('GET', '/reports/contributors?format=csv');
  const exp = await api('GET', '/export/offerings?offset=0');
  assert(exp.columns.includes('amount') && exp.rows.length > 0, 'paged export');
  const tbl = await api('GET', '/export/table/people?offset=0');
  assert(tbl.columns.includes('first_name'), 'table export for backup');
  assert(typeof csvOut === 'string' && csvOut.startsWith('envelope_no'), 'CSV export');

  // Year-end renumber
  await api('POST', '/contributors/renumber', { mode: 'alphabetical', start: 1 });
  const list = await api('GET', '/contributors');
  assert(list.filter(c => c.uses_envelopes && c.active).every(c => c.upcoming_envelope_no), 'upcoming numbers assigned');
  await api('POST', '/contributors/apply-upcoming', {});
  const after = group(await api('GET', `/statements?from=2026-01-01&to=2026-12-31&contributor_id=${smith.id}`)).statements[0];
  assert(after.total_cents === s.total_cents && after.prior_envelope_no === smith.envelope_no, 'history survives renumbering');

  // Counter role restrictions
  await api('POST', '/users', { username: `counter${tag}`, password: 'countingpass1', role: 'counter' });
  const adminCookie = cookie;
  cookie = '';
  await api('POST', '/auth/login', { username: `counter${tag}`, password: 'countingpass1' });
  try { await api('GET', '/statements'); assert(false, 'counter blocked'); } catch (e) { assert(e.status === 403, 'counter cannot see statements'); }
  const cb = await api('POST', '/batches', { batch_date: '2026-11-01' });
  await api('POST', `/batches/${cb.id}/lines`, { envelope_no: 1, fund_id: general.id, amount: '10' });
  try { await api('POST', `/batches/${cb.id}/post`, {}); assert(false, 'counter post blocked'); } catch (e) { assert(e.status === 403, 'counter cannot post'); }
  cookie = adminCookie;

  // CSRF header required
  const res = await fetch(BASE + '/api/batches', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
  assert(res.status === 403, 'mutations without X-Steward header are refused');

  // Seasonal address is used on statements while active
  const hh = await api('GET', `/households/${(await api('GET', `/contributors/${smith.id}`)).household_id}`);
  await api('PUT', `/households/${hh.id}`, { alt_address1: '9 Palm Way', alt_city: 'Naples', alt_state: 'FL', alt_zip: '34102', alt_begin: '2000-01-01', alt_end: '2099-12-31' });
  const st2 = group(await api('GET', `/statements?from=2026-01-01&to=2026-12-31&contributor_id=${smith.id}`)).statements[0];
  assert(st2.city_line.includes('Naples') && st2.address[0] === '9 Palm Way', 'seasonal address on statement');

  // Large import stays within D1 per-request limits
  let big = 'household_id,first_name,last_name,relationship,address1,city,state,zip,envelope\n';
  for (let i = 0; i < 400; i++) {
    big += `B${i},Pat,Big${tag}x${i},Head,${i} Elm St,Uniontown,PA,15401,${2000 + i}\n`;
    big += `B${i},Sam,Big${tag}x${i},Spouse,,,,,\n`;
  }
  const t0 = Date.now();
  const bigRes = await api('POST', '/import/membership', { rows: rowsOf(big), dry_run: false });
  assert(bigRes.households === 400 && bigRes.people === 800 && bigRes.envelopes === 400, `400-household import in ${Date.now() - t0} ms`);
  const dir2 = await api('GET', '/contributors/directory');
  assert(dir2.find(d => d.envelope_no === 2005)?.display_name === `Pat & Sam Big${tag}x5`, 'imported joint envelope');
  let gifts = 'envelope,date,fund,amount\n';
  for (let i = 0; i < 3000; i++) gifts += `${2000 + (i % 400)},${1 + (i % 9)}/${1 + (i % 28)}/2026,${1 + (i % 3)},${(i % 50) + 5}.25\n`;
  const g0 = Date.now();
  const gRes = await api('POST', '/import/offerings', { rows: rowsOf(gifts).slice(0, 2000), dry_run: false, post: true });
  assert(gRes.rows === 2000 && !gRes.errors.length, `2000-gift import in ${Date.now() - g0} ms`);
  const s0 = Date.now();
  const allSt = group(await api('GET', '/statements?from=2026-01-01&to=2026-12-31'));
  assert(allSt.statements.length >= 400, `${allSt.statements.length} statements built in ${Date.now() - s0} ms`);
  await api('POST', '/contributors/renumber', { mode: 'alphabetical', start: 1 });
  assert((await api('GET', '/contributors')).filter(x => x.upcoming_envelope_no).length >= 400, 'renumber 400+ envelopes in one request');

  // Attendance mark / unmark
  const sess = await api('POST', '/attendance/sessions', { event_id: events[0].id, session_date: '2026-11-08' });
  const ppl = await api('GET', '/people');
  await api('POST', `/attendance/sessions/${sess.id}/mark`, { person_ids: ppl.slice(0, 5).map(p => p.id), present: true });
  await api('POST', `/attendance/sessions/${sess.id}/mark`, { person_ids: [ppl[0].id], present: false });
  assert((await api('GET', `/attendance/sessions/${sess.id}`)).present.length === 4, 'attendance mark and unmark');

  // Disabling a user signs them out
  const users = await api('GET', '/users');
  const counter = users.find(u => u.username === `counter${tag}`);
  const counterCookie = await (async () => { const save = cookie; cookie = ''; await api('POST', '/auth/login', { username: `counter${tag}`, password: 'countingpass1' }); const cc = cookie; cookie = save; return cc; })();
  await api('PUT', `/users/${counter.id}`, { role: 'counter', active: false });
  const me = await fetch(BASE + '/api/auth/me', { headers: { cookie: counterCookie } }).then(r => r.json());
  assert(me.user === null, 'disabled account is signed out');

  // Booleans come back as true/false
  const f1 = (await api('GET', '/funds'))[0];
  assert(f1.active === true && f1.deductible === true, 'booleans are real booleans');

  // Login throttling
  let last;
  for (let i = 0; i < 9; i++) {
    last = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Steward': '1' }, body: JSON.stringify({ username: 'nobody', password: 'wrongwrongwrong' }) });
  }
  assert(last.status === 429, 'repeated bad passwords are throttled');
  console.log('\nAll checks passed.');
})().catch(e => { console.error(e.message); process.exit(1); });
