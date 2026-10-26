// Reports and year-end giving statements.
import { html, raw, $, $$, money, fmtDate, toast } from './ui.js';
import { get } from './api.js';
import { toCsv, saveFile, downloadExport, downloadBackup } from './csv.js';
import { go, state } from './app.js';

let lastStatements = null;

// Group the server's lean gift rows into one statement per giver.
function buildStatements(data, sort) {
  const funds = new Map(data.funds.map(f => [f.id, f]));
  const byId = new Map(data.contributors.map(c => [c.id, { ...c, lines: [], funds: {}, total_cents: 0, deductible_cents: 0, nondeductible_cents: 0 }]));
  for (const [cid, date, fundId, cents] of data.gifts) {
    const s = byId.get(cid);
    const f = funds.get(fundId);
    if (!s || !f) continue;
    s.lines.push({ date, fund: f.name, amount_cents: cents, deductible: f.deductible });
    s.funds[f.id] = s.funds[f.id] || { fund: f.name, code: f.code, deductible: f.deductible, total_cents: 0 };
    s.funds[f.id].total_cents += cents;
    s.total_cents += cents;
    if (f.deductible) s.deductible_cents += cents; else s.nondeductible_cents += cents;
  }
  const byName = (a, b) => (a.sort_name || '').localeCompare(b.sort_name || '', 'en', { sensitivity: 'base' }) || (a.envelope_no ?? 0) - (b.envelope_no ?? 0);
  const cmp = sort === 'envelope' ? (a, b) => (a.envelope_no ?? Infinity) - (b.envelope_no ?? Infinity)
    : sort === 'zip' ? (a, b) => (a.zip || '~').localeCompare(b.zip || '~') || byName(a, b) : byName;
  const statements = [...byId.values()].filter(s => s.lines.length).sort(cmp)
    .map(s => ({ ...s, funds: Object.values(s.funds).sort((a, b) => a.code - b.code) }));
  return { from: data.from, to: data.to, settings: data.settings, statements };
}

const qs = () => new URLSearchParams(location.hash.split('?')[1] || '');
const thisYear = new Date().getFullYear();

export function index() {
  const y = thisYear;
  const prev = new Date().getMonth() < 3 ? y - 1 : y; // early in the year, statements are for last year
  $('#view').innerHTML = html`
    <h1>Reports</h1>
    <div class="panel flush"><ul class="list">
      <li><a class="item" href="#/statements?year=${prev}"><span class="spacer"><strong>Year-end giving statements</strong><br><span class="small muted">Tax letters for each giver, ready to print or save as PDF</span></span></a></li>
      <li><a class="item" href="#/report/contributors"><span class="spacer"><strong>Giving by envelope</strong><br><span class="small muted">Totals for every giver, plus loose offering</span></span></a></li>
      <li><a class="item" href="#/report/funds"><span class="spacer"><strong>Giving by fund and month</strong><br><span class="small muted">What came in to each fund</span></span></a></li>
      <li><a class="item" href="#/report/attendance"><span class="spacer"><strong>Attendance</strong><br><span class="small muted">Services, head counts, and who hasn't been in a while</span></span></a></li>
      <li><a class="item" href="#/report/directory"><span class="spacer"><strong>Church directory</strong><br><span class="small muted">Households with addresses and phone numbers</span></span></a></li>
    </ul></div>
    <div class="panel"><h2>Download your data</h2>
      <p class="small muted">Spreadsheet files you can open in Excel or Google Sheets. Keep a backup copy somewhere safe each month.</p>
      <div class="row" id="exports">
        <button type="button" data-x="households">Households</button>
        <button type="button" data-x="people">People</button>
        <button type="button" data-x="contributors">Envelopes</button>
        <button type="button" data-x="offerings">All gifts</button>
        <button type="button" data-x="attendance">Attendance</button>
        <button type="button" class="primary" data-x="backup">Full backup</button>
      </div></div>`;
  $$('#exports [data-x]').forEach(b => { b.onclick = async () => {
    b.disabled = true;
    try { if (b.dataset.x === 'backup') await downloadBackup(); else await downloadExport(b.dataset.x); }
    catch (ex) { toast(ex.message, true); }
    b.disabled = false;
  }; });
}

function rangeForm(from, to, extra = '') {
  return html`<form class="panel noprint" id="rf"><div class="fields">
    <div class="field"><label for="from">From</label><input id="from" type="date" value="${from}"></div>
    <div class="field"><label for="to">Through</label><input id="to" type="date" value="${to}"></div>
    ${raw(extra)}
  </div><div class="row"><button class="primary" type="submit">Show</button><button type="button" id="prt">Print</button><a class="btn" id="csv" href="#">Download spreadsheet</a></div></form>`;
}

// ---------------- Statements ----------------
export async function statements() {
  const p = qs();
  const year = Number(p.get('year')) || thisYear;
  const from = p.get('from') || `${year}-01-01`;
  const to = p.get('to') || `${year}-12-31`;
  const sort = p.get('sort') || 'name';
  const method = p.get('method') || '';
  const show = p.get('show') || 'both';
  const cid = p.get('contributor_id') || '';
  const v = $('#view');
  v.innerHTML = html`
    <a class="back noprint" href="#/reports">← Reports</a>
    <div class="pagehead noprint"><h1>Giving statements</h1></div>
    <form class="panel noprint" id="sf">
      <div class="fields">
        <div class="field"><label for="from">Gifts from</label><input id="from" type="date" value="${from}"></div>
        <div class="field"><label for="to">Through</label><input id="to" type="date" value="${to}"></div>
        <div class="field"><label for="sort">Order</label><select id="sort">
          <option value="name" ${sort === 'name' ? raw('selected') : ''}>By last name</option>
          <option value="envelope" ${sort === 'envelope' ? raw('selected') : ''}>By envelope number</option>
          <option value="zip" ${sort === 'zip' ? raw('selected') : ''}>By ZIP (bulk mail)</option></select></div>
        <div class="field"><label for="method">Who</label><select id="method">
          <option value="" ${!method ? raw('selected') : ''}>Everyone who gave</option>
          <option value="mail" ${method === 'mail' ? raw('selected') : ''}>Only those who get mail</option>
          <option value="email" ${method === 'email' ? raw('selected') : ''}>Only those who get email</option></select></div>
        <div class="field"><label for="show">Detail</label><select id="show">
          <option value="both" ${show === 'both' ? raw('selected') : ''}>Fund totals and every gift</option>
          <option value="funds" ${show === 'funds' ? raw('selected') : ''}>Fund totals only</option>
          <option value="items" ${show === 'items' ? raw('selected') : ''}>Every gift only</option></select></div>
      </div>
      ${cid ? html`<p class="small">Showing one giver. <a href="#/statements?year=${year}">Show everyone</a></p>` : ''}
      <div class="row"><button class="primary" type="submit">Prepare statements</button><button type="button" id="prt">Print or save as PDF</button>
        <a class="btn" id="csv" href="#">Mail-merge spreadsheet</a><a class="btn" href="#/settings">Edit letter wording</a></div>
    </form>
    <div id="out"><p class="muted">Preparing…</p></div>`;

  const params = () => `from=${$('#from').value}&to=${$('#to').value}&sort=${$('#sort').value}&method=${$('#method').value}${cid ? `&contributor_id=${cid}` : ''}`;
  $('#sf').onsubmit = e => { e.preventDefault(); go(`statements?${params()}&show=${$('#show').value}`); };
  $('#prt').onclick = () => window.print();
  $('#csv').onclick = e => {
    e.preventDefault();
    if (!lastStatements) return;
    const d = cents => (cents / 100).toFixed(2);
    saveFile(`giving-statements-${lastStatements.from}-to-${lastStatements.to}.csv`, toCsv(lastStatements.statements.map(s => ({
      envelope: s.envelope_no, name: s.name, address: s.address.join(' '), city_state_zip: s.city_line, email: s.email,
      statement_method: s.statement_method, deductible: d(s.deductible_cents), nondeductible: d(s.nondeductible_cents), total: d(s.total_cents),
    }))));
  };

  const data = buildStatements(await get(`/statements?${params()}`), $('#sort').value);
  lastStatements = data;
  const s = data.settings;
  const period = `${fmtDate(data.from, { month: 'long', day: 'numeric', year: 'numeric' })} through ${fmtDate(data.to, { month: 'long', day: 'numeric', year: 'numeric' })}`;
  const printed = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const totalAll = data.statements.reduce((a, x) => a + x.total_cents, 0);
  $('#out').innerHTML = data.statements.length ? html`
    <p class="noprint muted">${data.statements.length} statement${data.statements.length === 1 ? '' : 's'} · ${money(totalAll)} total. Each prints on its own page.</p>
    ${data.statements.map(st => html`
    <article class="letter">
      <div class="from"><strong>${s.church_name || ''}</strong><br>
        ${[s.church_address1, s.church_address2, s.church_city_line, s.church_phone].filter(Boolean).map((l, i) => html`${i ? raw('<br>') : ''}${l}`)}
        ${s.church_ein ? html`<br><span class="fine">EIN ${s.church_ein}</span>` : ''}</div>
      <div class="to">${st.name}<br>${st.address.map(a => html`${a}<br>`)}${st.city_line}</div>
      <p>${printed}</p>
      <p><strong>Contribution statement · ${period}</strong><br><span class="fine">Envelope #${st.envelope_no ?? ''}</span></p>
      <p>Dear ${st.name},</p>
      ${(s.statement_message || '').split(/\n+/).map(par => html`<p>${par}</p>`)}
      ${show !== 'items' ? html`<table><thead><tr><th>Fund</th><th class="num">Amount</th></tr></thead>
        <tbody>${st.funds.map(f => html`<tr><td>${f.fund}${f.deductible ? '' : ' (not tax-deductible)'}</td><td class="num">${money(f.total_cents)}</td></tr>`)}</tbody>
        <tfoot><tr><td>Total contributions</td><td class="num">${money(st.total_cents)}</td></tr></tfoot></table>` : ''}
      ${show !== 'funds' ? html`<table><thead><tr><th>Date</th><th>Fund</th><th class="num">Amount</th></tr></thead>
        <tbody>${st.lines.map(l => html`<tr><td>${fmtDate(l.date, { month: '2-digit', day: '2-digit', year: 'numeric' })}</td><td>${l.fund}</td><td class="num">${money(l.amount_cents)}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="2">Total contributions</td><td class="num">${money(st.total_cents)}</td></tr></tfoot></table>` : ''}
      ${st.nondeductible_cents ? html`<p class="fine">Tax-deductible: ${money(st.deductible_cents)} · Not deductible: ${money(st.nondeductible_cents)}</p>` : ''}
      <div class="sig"><div class="line"></div>${s.signer_name || ''}${s.signer_title ? html`<br>${s.signer_title}` : ''}</div>
    </article>`)}`
    : html`<div class="panel"><p class="empty">No posted gifts in this period. Post your offering batches first, or widen the dates.</p></div>`;
}

// ---------------- Other reports ----------------
export async function report(kind) {
  const p = qs();
  const from = p.get('from') || `${thisYear}-01-01`;
  const to = p.get('to') || `${thisYear}-12-31`;
  const v = $('#view');
  const titles = { funds: 'Giving by fund and month', contributors: 'Giving by envelope', attendance: 'Attendance', directory: 'Church directory' };
  const range = `from=${from}&to=${to}`;
  if (kind === 'directory') {
    const rows = await get('/reports/directory');
    v.innerHTML = html`<a class="back noprint" href="#/reports">← Reports</a>
      <div class="pagehead"><h1>${state.settings.church_name || ''} directory</h1><div class="row noprint"><button id="prt">Print</button><a class="btn" href="/api/reports/directory?format=csv">Download spreadsheet</a></div></div>
      <div class="panel flush"><ul class="list">${rows.map(h => html`<li class="item" style="display:block;padding:.75rem 1rem">
        <strong>${h.name}</strong> <span class="muted">— ${h.people.map(x => x.first_name).join(', ')}</span><br>
        <span class="small">${[h.address1, h.address2, [h.city, h.state].filter(Boolean).join(', '), h.zip].filter(Boolean).join(' · ')}${h.phone ? ` · ${h.phone}` : ''}${h.email ? ` · ${h.email}` : ''}</span></li>`)}</ul></div>`;
    $('#prt').onclick = () => window.print();
    return;
  }
  v.innerHTML = html`<a class="back noprint" href="#/reports">← Reports</a><div class="pagehead"><h1>${titles[kind]}</h1></div>${rangeForm(from, to)}<div id="out" class="report-print"></div>`;
  $('#rf').onsubmit = e => { e.preventDefault(); go(`report/${kind}?from=${$('#from').value}&to=${$('#to').value}`); };
  $('#prt').onclick = () => window.print();
  $('#csv').href = `/api/reports/${kind}?${range}&format=csv`;
  const out = $('#out');

  if (kind === 'contributors') {
    const d = await get(`/reports/contributors?${range}`);
    const total = d.rows.reduce((a, r) => a + r.total_cents, 0);
    out.innerHTML = html`<p class="muted">${fmtDate(from)} – ${fmtDate(to)}, posted gifts only.</p><div class="panel flush"><div class="tablewrap"><table>
      <thead><tr><th class="num">#</th><th>Name</th><th class="num">Gifts</th><th>Last gift</th><th class="num">Total</th></tr></thead>
      <tbody>${d.rows.map(r => html`<tr><td class="num">${r.envelope_no ?? ''}</td><td>${r.display_name}</td><td class="num">${r.gifts}</td><td>${fmtDate(r.last_gift)}</td><td class="num">${money(r.total_cents)}</td></tr>`)}
        <tr><td></td><td><em>Loose offering</em></td><td></td><td></td><td class="num">${money(d.loose_cents)}</td></tr></tbody>
      <tfoot><tr><td colspan="4">Total</td><td class="num">${money(total + d.loose_cents)}</td></tr></tfoot></table></div></div>`;
  }

  if (kind === 'funds') {
    const d = await get(`/reports/funds?${range}`);
    const months = [...new Set(d.rows.map(r => r.month))].sort();
    const funds = [...new Map(d.rows.map(r => [r.code, r.name])).entries()];
    const cell = (code, m) => d.rows.find(r => r.code === code && r.month === m)?.total_cents || 0;
    const mLabel = m => new Date(Number(m.slice(0, 4)), Number(m.slice(5)) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    out.innerHTML = d.rows.length ? html`<div class="panel flush"><div class="tablewrap"><table>
      <thead><tr><th>Month</th>${funds.map(([, n]) => html`<th class="num">${n}</th>`)}<th class="num">Total</th></tr></thead>
      <tbody>${months.map(m => html`<tr><td>${mLabel(m)}</td>${funds.map(([c]) => html`<td class="num">${money(cell(c, m), { blankZero: true })}</td>`)}
        <td class="num"><strong>${money(funds.reduce((a, [c]) => a + cell(c, m), 0))}</strong></td></tr>`)}</tbody>
      <tfoot><tr><td>Total</td>${funds.map(([c]) => html`<td class="num">${money(months.reduce((a, m) => a + cell(c, m), 0))}</td>`)}
        <td class="num">${money(d.rows.reduce((a, r) => a + r.total_cents, 0))}</td></tr></tfoot></table></div></div>` : html`<p class="empty">No posted gifts in this period.</p>`;
  }

  if (kind === 'attendance') {
    const d = await get(`/reports/attendance?${range}`);
    const avg = d.sessions.length ? Math.round(d.sessions.reduce((a, s) => a + (s.headcount || s.recorded), 0) / d.sessions.length) : 0;
    const absent = d.people.filter(x => x.times === 0 && x.status === 'member');
    out.innerHTML = html`
      <div class="stats"><div class="stat"><div class="v">${d.sessions.length}</div><div class="l">Services recorded</div></div>
        <div class="stat"><div class="v">${avg}</div><div class="l">Average attendance</div></div>
        <div class="stat"><div class="v">${absent.length}</div><div class="l">Members not recorded present</div></div></div>
      <div class="panel flush"><h2 style="padding:1rem 1rem 0">Services</h2><div class="tablewrap"><table>
        <thead><tr><th>Date</th><th>Event</th><th class="num">Named</th><th class="num">Head count</th></tr></thead>
        <tbody>${d.sessions.map(s => html`<tr><td>${fmtDate(s.session_date)}</td><td>${s.event_name}</td><td class="num">${s.recorded}</td><td class="num">${s.headcount ?? ''}</td></tr>`)}</tbody></table></div></div>
      <div class="panel flush"><h2 style="padding:1rem 1rem 0">People, fewest visits first</h2><div class="tablewrap"><table>
        <thead><tr><th>Name</th><th>Status</th><th class="num">Times</th><th>Last here</th></tr></thead>
        <tbody>${d.people.map(x => html`<tr><td>${x.last_name}, ${x.first_name}</td><td>${x.status}</td><td class="num">${x.times}</td><td>${x.last_attended_ever ? fmtDate(x.last_attended_ever) : 'Never recorded'}</td></tr>`)}</tbody></table></div></div>`;
  }
}

export { toast };
