// Settings, funds, users, imports and year-end tools.
import { html, raw, $, $$, money, fmtDate, toast, modal, confirmBox, formData, field, selectField, checkField } from './ui.js';
import { get, post, put, cache } from './api.js';
import { parseCsv, canonicalRows, downloadExport, readRestoreFile, restorePieces } from './csv.js';
import { state, isFinance, isAdmin, go, loadSettings } from './app.js';

export async function settings() {
  const v = $('#view');
  const s = state.settings;
  v.innerHTML = html`
    <h1>Settings</h1>
    ${isFinance() ? html`
    <div class="panel flush"><ul class="list">
      <li><a class="item" href="#/import"><span class="spacer"><strong>Import from Shepherd's Staff or a spreadsheet</strong><br><span class="small muted">Bring in households, envelopes and this year's giving</span></span></a></li>
      <li><a class="item" href="#/yearend"><span class="spacer"><strong>Year-end</strong><br><span class="small muted">Statements, next year's envelope numbers</span></span></a></li>
    </ul></div>
    <form class="panel" id="church"><h2>Church and statement letter</h2>
      <div class="fields">${field('Church name', 'church_name', s.church_name)}${field('Phone', 'church_phone', s.church_phone)}</div>
      ${field('Street address', 'church_address1', s.church_address1)}
      ${field('Address line 2', 'church_address2', s.church_address2)}
      <div class="fields">${field('City, state ZIP', 'church_city_line', s.church_city_line, 'placeholder="Uniontown, PA 15401"')}${field('EIN (optional)', 'church_ein', s.church_ein)}</div>
      <div class="field"><label for="f-msg">Statement message</label><textarea id="f-msg" name="statement_message" rows="5">${s.statement_message || ''}</textarea>
        <p class="small muted">The IRS expects the letter to say whether goods or services were given in exchange. The default wording covers that; blank lines start new paragraphs.</p></div>
      <div class="fields">${field('Signed by', 'signer_name', s.signer_name)}${field('Title', 'signer_title', s.signer_title)}</div>
      <button class="primary" type="submit">Save</button>
    </form>
    <div class="panel flush" id="funds"></div>` : ''}
    ${isAdmin() ? html`<div class="panel flush" id="users"></div>` : ''}
    <form class="panel" id="pw"><h2>Your password</h2>
      <div class="fields">${field('Current password', 'current', '', 'type="password" autocomplete="current-password" required')}${field('New password (10+ characters)', 'next', '', 'type="password" autocomplete="new-password" minlength="10" required')}</div>
      <div class="row"><button type="submit">Change password</button><span class="spacer"></span><button type="button" id="out">Sign out</button></div>
    </form>
    ${isAdmin() ? html`<p><button id="audit" class="ghost">View activity log</button></p>` : ''}`;

  $('#church')?.addEventListener('submit', async e => {
    e.preventDefault();
    try { await put('/settings', formData(e.target)); await loadSettings(); toast('Saved'); } catch (ex) { toast(ex.message, true); }
  });
  $('#pw').onsubmit = async e => {
    e.preventDefault();
    try { await post('/auth/password', formData(e.target)); e.target.reset(); toast('Password changed'); } catch (ex) { toast(ex.message, true); }
  };
  $('#out').onclick = async () => { await post('/auth/logout'); cache.del('user'); location.hash = '#/'; location.reload(); };
  $('#audit')?.addEventListener('click', auditLog);
  if (isFinance()) drawFunds();
  if (isAdmin()) drawUsers();
}

async function drawFunds() {
  const funds = await get('/funds');
  cache.set('funds', funds);
  $('#funds').innerHTML = html`<div class="row" style="padding:1rem 1rem 0"><h2 style="margin:0">Funds</h2><span class="spacer"></span><button id="addf">Add a fund</button></div>
    <ul class="list">${funds.map(f => html`<li><a class="item" href="#" data-f="${f.id}"><span class="env-no" style="min-width:2.5rem;font-weight:700">${f.code}</span>
      <span class="spacer">${f.name}${f.deductible ? '' : html` <span class="pill">not deductible</span>`}${f.active ? '' : html` <span class="pill">inactive</span>`}</span></a></li>`)}</ul>`;
  const edit = f => modal(html`<h2>${f.id ? 'Edit fund' : 'Add a fund'}</h2><form>
    <div class="fields">${field('Fund number', 'code', f.code, 'inputmode="numeric" required')}${field('Name', 'name', f.name, 'required')}</div>
    ${checkField('Gifts are tax-deductible', 'deductible', f.deductible !== false)}
    ${checkField('Active (shows in offering entry)', 'active', f.active !== false)}
    <div class="actions"><button type="button" data-x>Cancel</button><button class="primary" type="submit">Save</button></div></form>`.toString(), (el, close) => {
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { f.id ? await put(`/funds/${f.id}`, formData(e.target)) : await post('/funds', formData(e.target)); close(); drawFunds(); toast('Fund saved'); }
      catch (ex) { toast(ex.message, true); }
    };
  });
  $('#addf').onclick = () => edit({ code: Math.max(0, ...funds.map(f => f.code)) + 1 });
  $$('[data-f]').forEach(a => { a.onclick = e => { e.preventDefault(); edit(funds.find(f => String(f.id) === a.dataset.f)); }; });
}

const ROLE_TEXT = { admin: 'Administrator — everything, including users', finance: 'Financial secretary — giving, people, reports', counter: 'Counter — enter offerings and attendance only' };
async function drawUsers() {
  const users = await get('/users');
  $('#users').innerHTML = html`<div class="row" style="padding:1rem 1rem 0"><h2 style="margin:0">Who can sign in</h2><span class="spacer"></span><button id="addu">Add a person</button></div>
    <ul class="list">${users.map(u => html`<li><a class="item" href="#" data-u="${u.id}"><span class="spacer"><strong>${u.full_name || u.username}</strong> <span class="muted">${u.username}</span><br>
      <span class="small muted">${ROLE_TEXT[u.role]}${u.active ? '' : ' · disabled'}</span></span></a></li>`)}</ul>`;
  const edit = u => modal(html`<h2>${u.id ? u.username : 'Add a person'}</h2><form>
    ${u.id ? '' : field('Username', 'username', '', 'autocapitalize="none" required')}
    ${field('Full name', 'full_name', u.full_name)}
    ${selectField('Access', 'role', Object.entries(ROLE_TEXT), u.role || 'counter')}
    ${field(u.id ? 'New password (leave blank to keep)' : 'Password (10+ characters)', 'password', '', `type="password" autocomplete="new-password" ${u.id ? '' : 'required minlength="10"'}`)}
    ${u.id ? checkField('Can sign in', 'active', u.active) : ''}
    <div class="actions"><button type="button" data-x>Cancel</button><button class="primary" type="submit">Save</button></div></form>`.toString(), (el, close) => {
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { u.id ? await put(`/users/${u.id}`, formData(e.target)) : await post('/users', formData(e.target)); close(); drawUsers(); toast('Saved'); }
      catch (ex) { toast(ex.message, true); }
    };
  });
  $('#addu').onclick = () => edit({});
  $$('[data-u]').forEach(a => { a.onclick = e => { e.preventDefault(); edit(users.find(u => String(u.id) === a.dataset.u)); }; });
}

async function auditLog() {
  const rows = await get('/audit');
  modal(html`<h2>Activity log</h2><div class="tablewrap"><table><tbody>${rows.map(r => html`<tr><td class="small">${new Date(r.at).toLocaleString()}</td><td class="small">${r.username || ''}</td><td class="small">${r.action.replace(/_/g, ' ')} ${r.detail || ''}</td></tr>`)}</tbody></table></div>
    <div class="actions"><button data-x>Close</button></div>`.toString(), (el, close) => { el.querySelector('[data-x]').onclick = close; });
}

// ---------------- Import ----------------
export function importPage() {
  $('#view').innerHTML = html`
    <a class="back" href="#/settings">← Settings</a>
    <h1>Import</h1>
    <div class="note">Shepherd's Staff can save most reports and grids as spreadsheets. Save them as CSV (in Excel: File → Save As → CSV), then pick the file here. You'll see a preview before anything is saved.</div>
    <div class="panel"><h2>1. Households, people and envelopes</h2>
      <p class="small">One row per household, or one row per person with a <em>Household ID</em> column to group families. Recognized columns:
        <strong>First Name, Last Name</strong> (required), Household ID, Household Name, Relationship, Spouse First Name, Address, Address 2, City, State, Zip, Phone, Cell, Email, Envelope, Status, Birth Date.</p>
      <input type="file" id="mf" accept=".csv,text/csv">
      <div id="mres"></div></div>
    <div class="panel"><h2>2. Gifts already recorded this year</h2>
      <p class="small">So year-end statements include everything. Import envelopes first. Columns: <strong>Envelope, Date, Amount</strong> (required), Fund (number or name; blank means fund 1), Check, Memo. A blank envelope counts as loose offering. One offering is created for each date.</p>
      <div class="fields"><div class="field"><label for="od">Label for these offerings</label><input id="od" value="Imported from Shepherd's Staff"></div></div>
      <label class="check"><input type="checkbox" id="opost" checked> Post them right away (they were already checked in the old system)</label>
      <input type="file" id="of" accept=".csv,text/csv">
      <div id="ores"></div></div>
    ${isAdmin() ? html`<div class="panel"><h2>3. Restore everything from a file</h2>
      <p class="small">Loads a whole church at once: households, people, envelopes, funds, every gift and all attendance history. Use it for a file converted from Shepherd's Staff, or a <em>Full backup</em> from another copy of Steward. It only works while this Steward has no records yet, so nothing can be overwritten. Sign-ins are kept as they are.</p>
      <input type="file" id="rf" accept=".json,application/json">
      <div id="rres"></div></div>` : ''}`;

  const run = async (kind, file, out, extra) => {
    out.innerHTML = html`<p class="muted" style="margin-top:1rem">Reading ${file.name}…</p>`;
    let pieces, mapping, fileErrors = [];
    try {
      const parsed = parseCsv(await file.text());
      mapping = canonicalRows(parsed);
      const rows = mapping.rows.map((r, i) => ({ ...r, _line: i + 2 }));
      if (!rows.length) throw new Error('The file has no rows. Make sure the first row holds column names.');
      // Keep each household (or each date) whole within one request.
      const keyOf = kind === 'membership' ? r => (r.household_id ? `h:${r.household_id}` : `r:${r._line}`) : r => `d:${r.date || ''}`;
      const groups = new Map();
      for (const r of rows) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      pieces = [[]];
      for (const g of groups.values()) {
        if (pieces.at(-1).length && pieces.at(-1).length + g.length > 1500) pieces.push([]);
        pieces.at(-1).push(...g);
      }
      if (kind === 'membership') {
        const seen = new Map();
        for (const r of rows) {
          const n = Number(String(r.envelope || '').replace(/\D/g, ''));
          if (!n) continue;
          const key = r.household_id || `row${r._line}`;
          if (seen.has(n) && seen.get(n).key !== key) fileErrors.push(`Row ${r._line}: envelope ${n} is also on row ${seen.get(n).line}.`);
          else if (!seen.has(n)) seen.set(n, { key, line: r._line });
        }
      }
    } catch (ex) { out.innerHTML = html`<div class="error-box">${ex.message}</div>`; return; }

    const send = async dry => {
      const results = [];
      for (const piece of pieces) results.push(await post(`/import/${kind}`, { rows: piece, dry_run: dry, ...extra() }));
      const sum = k => results.reduce((a, r) => a + (r[k] || 0), 0);
      return {
        dry_run: dry, errors: [...fileErrors, ...results.flatMap(r => r.errors)],
        households: sum('households'), people: sum('people'), envelopes: sum('envelopes'), preview: results[0].preview,
        rows: sum('rows'), total_cents: sum('total_cents'), batches: results.flatMap(r => r.batches || []),
      };
    };
    const show = r => {
      out.innerHTML = html`<div style="margin-top:1rem">
        <p class="small muted">Columns used: ${mapping.matched.join(', ') || 'none'}${mapping.ignored.length ? html`<br>Ignored: ${mapping.ignored.join(', ')}` : ''}</p>
        ${r.errors.length ? html`<div class="error-box"><strong>Fix these rows and choose the file again:</strong><ul>${r.errors.slice(0, 30).map(e => html`<li>${e}</li>`)}</ul>${r.errors.length > 30 ? `…and ${r.errors.length - 30} more` : ''}</div>` : ''}
        ${kind === 'membership' ? html`<p>${r.households} households, ${r.people} people, ${r.envelopes} envelopes.</p>
          ${r.preview?.length ? html`<div class="tablewrap"><table><tbody>${r.preview.map(p => html`<tr><td>${p.household}</td><td>${p.people}</td><td class="num">${p.envelope ? `#${p.envelope}` : ''}</td></tr>`)}</tbody></table></div>` : ''}`
        : html`<p>${r.rows} gifts on ${r.batches.length} dates, ${money(r.total_cents)} total.</p>`}
        ${r.dry_run && !r.errors.length ? html`<button class="primary" id="${kind}-go">Import now</button>` : ''}
        ${!r.dry_run ? html`<div class="note">Imported.</div>` : ''}</div>`;
      $(`#${kind}-go`)?.addEventListener('click', async e => {
        e.target.disabled = true;
        e.target.textContent = 'Importing…';
        try { show(await send(false)); cache.del('directory'); cache.del('people'); toast('Imported'); }
        catch (ex) { toast(ex.message, true); e.target.disabled = false; e.target.textContent = 'Import now'; }
      });
    };
    try { show(await send(true)); } catch (ex) { out.innerHTML = html`<div class="error-box">${ex.message}</div>`; }
  };
  $('#rf')?.addEventListener('change', e => e.target.files[0] && restoreFile(e.target.files[0], $('#rres')));
  $('#mf').onchange = e => e.target.files[0] && run('membership', e.target.files[0], $('#mres'), () => ({}));
  $('#of').onchange = e => e.target.files[0] && run('offerings', e.target.files[0], $('#ores'), () => ({ description: $('#od').value, post: $('#opost').checked }));
}

const TABLE_LABEL = { households: 'households', people: 'people', funds: 'funds', events: 'events', contributors: 'envelopes',
  batches: 'offering dates', offerings: 'gifts', attendance_sessions: 'services', attendance_records: 'attendance marks', settings: 'settings' };

async function restoreFile(file, out) {
  out.innerHTML = html`<p class="muted" style="margin-top:1rem">Reading ${file.name}…</p>`;
  let parsed, status;
  try {
    parsed = readRestoreFile(await file.text());
    status = await get('/restore/status');
  } catch (ex) { out.innerHTML = html`<div class="error-box" style="margin-top:1rem">${ex.message}</div>`; return; }
  const t = parsed.tables;
  const count = k => t[k]?.rows.length || 0;
  const giftTotal = t.offerings ? t.offerings.rows.reduce((a, r) => a + (Number(r[t.offerings.columns.indexOf('amount_cents')]) || 0), 0) : 0;
  const dates = t.batches ? t.batches.rows.map(r => r[t.batches.columns.indexOf('batch_date')]).filter(Boolean).sort() : [];
  const blocked = !status.empty && !status.in_progress;
  out.innerHTML = html`<div style="margin-top:1rem">
    ${parsed.source ? html`<p class="small muted">From ${parsed.source}</p>` : ''}
    <table><tbody>
      ${['households', 'people', 'contributors', 'funds', 'offerings', 'attendance_records'].filter(count).map(k => html`<tr><td>${TABLE_LABEL[k][0].toUpperCase() + TABLE_LABEL[k].slice(1)}</td><td class="num">${count(k).toLocaleString()}</td></tr>`)}
      ${giftTotal ? html`<tr><td>Gifts total${dates.length ? ` (${fmtDate(dates[0])} – ${fmtDate(dates.at(-1))})` : ''}</td><td class="num">${money(giftTotal)}</td></tr>` : ''}
    </tbody></table>
    ${parsed.notes.length ? html`<div class="note"><ul style="margin:0;padding-left:1.1rem">${parsed.notes.map(n => html`<li>${n}</li>`)}</ul></div>` : ''}
    ${blocked ? html`<div class="error-box">This Steward already has records, so a restore can't be done here. A restore only goes into a brand-new, empty Steward.</div>`
      : html`<button class="primary" id="restore-go">Restore now</button> ${status.in_progress ? html`<span class="small muted">An earlier restore didn't finish; this starts it over.</span>` : ''}`}
    <div id="restore-progress"></div></div>`;
  $('#restore-go')?.addEventListener('click', async e => {
    if (!(await confirmBox(`Load ${count('people').toLocaleString()} people and ${count('offerings').toLocaleString()} gifts into this Steward?`, { ok: 'Restore' }))) return;
    e.target.disabled = true;
    const prog = $('#restore-progress');
    const pieces = restorePieces(t);
    const total = pieces.reduce((a, p) => a + p.n, 0);
    let done = 0;
    const show = label => { prog.innerHTML = html`<p style="margin-top:.8rem"><strong>${Math.floor((done / total) * 100)}%</strong> <span class="muted">${label}</span></p>`; };
    try {
      show('Starting…');
      await post('/restore/start');
      for (const p of pieces) {
        show(`Loading ${TABLE_LABEL[p.table] || p.table}…`);
        await post('/restore/chunk', { table: p.table, columns: p.columns, rows_json: p.rows_json });
        done += p.n;
      }
      show('Finishing…');
      const r = await post('/restore/finish');
      ['directory', 'people', 'funds', 'events'].forEach(k => cache.del(k));
      await loadSettings();
      prog.innerHTML = html`<div class="note" style="margin-top:.8rem"><strong>Restored.</strong> ${r.counts.households} households, ${r.counts.people} people, ${r.counts.contributors} envelopes, ${r.counts.offerings.toLocaleString()} gifts, ${r.counts.attendance_records.toLocaleString()} attendance marks.
        <br><a href="#/envelopes">See envelopes</a> · <a href="#/settings">Check church settings</a></div>`;
      $('#rf').value = '';
    } catch (ex) {
      prog.innerHTML = html`<div class="error-box" style="margin-top:.8rem">The restore stopped: ${ex.message}</div>
        <button id="restore-undo">Undo the partial restore</button> <span class="small muted">Then choose the file again.</span>`;
      $('#restore-undo').onclick = async () => {
        try { await post('/restore/abort'); toast('Partial restore removed'); out.innerHTML = ''; $('#rf').value = ''; } catch (x) { toast(x.message, true); }
      };
    }
  });
}

// ---------------- Year-end ----------------
export async function yearEnd() {
  const v = $('#view');
  const thisYear = new Date().getFullYear();
  const [open, plan, thisYearBatches] = await Promise.all([get('/batches?status=open'), get('/contributors/next-year'), get(`/batches?year=${thisYear}`)]);
  const rows = plan.rows;
  const getting = rows.filter(r => !r.upcoming_skip && r.active);
  const numbered = getting.filter(r => r.upcoming_envelope_no);
  const stopping = rows.filter(r => r.upcoming_skip).length;
  const renamed = rows.filter(r => r.upcoming_name && !r.upcoming_skip).length;
  const ready = numbered.length + stopping + renamed > 0;
  const switched = plan.numbers_switched_on;
  // New numbers normally start January 1 of next year; if nothing has been given yet this year, this January 1.
  const defaultStart = thisYearBatches.length ? `${thisYear + 1}-01-01` : `${thisYear}-01-01`;
  const stmtYear = new Date().getMonth() < 3 ? thisYear - 1 : thisYear;
  v.innerHTML = html`
    <a class="back" href="#/settings">← Settings</a>
    <h1>Year-end</h1>
    <p class="muted">Plan next year's envelopes whenever you like; statements and this year's counting aren't affected until you switch.</p>

    <div class="panel"><h2>1. Plan next year's envelopes</h2>
      <p>${numbered.length} of ${getting.length} givers have a number for next year${stopping ? `, ${stopping} stopping` : ''}${renamed ? `, ${renamed} with a new name on the label` : ''}.</p>
      <div class="row"><a class="btn primary" href="#/nextyear">Plan next year</a><a class="btn" href="#/labels">Print box labels</a></div></div>

    <div class="panel"><h2>2. Post every offering</h2>
      ${open.length ? html`<p>${open.length} offering${open.length === 1 ? ' is' : 's are'} still in progress and won't appear on statements:</p>
        <ul>${open.map(b => html`<li><a href="#/batch/${b.id}">${fmtDate(b.batch_date)} — ${money(b.total_cents)}</a></li>`)}</ul>`
        : html`<p class="diff ok">Everything is posted.</p>`}</div>

    <div class="panel"><h2>3. Print giving statements</h2>
      <p>Statements use each giver's name as it stood that year, so you can print them before or after the switch.</p>
      <a class="btn primary" href="#/statements?year=${stmtYear}">Prepare ${stmtYear} statements</a></div>

    <div class="panel"><h2>4. Switch to next year's envelopes</h2>
      ${switched ? html`<p class="small">Last switched: offerings dated from <strong>${fmtDate(switched)}</strong> use the current numbers. Earlier offerings still use the previous year's.</p>` : ''}
      <p class="small">Applies the plan: new numbers, new label names, and stops envelopes for givers marked <em>stopping</em>. Gifts stay with each giver. Offerings dated before the start date below keep using last year's numbers, so a late December envelope still finds the right person.</p>
      <div class="fields"><div class="field"><label for="eff">New numbers start with offerings dated</label><input id="eff" type="date" value="${defaultStart}"></div></div>
      <button class="danger" id="apply" ${ready ? '' : raw('disabled')}>Switch to next year's envelopes</button></div>`;
  $('#apply').onclick = async () => {
    const eff = $('#eff').value;
    if (!eff) return toast('Choose the first offering date that uses the new numbers.', true);
    if (getting.length > numbered.length && !(await confirmBox(`${getting.length - numbered.length} givers have no next-year number and will keep their current one. Continue?`, { ok: 'Continue' }))) return;
    if (!(await confirmBox(`Switch now? Offerings dated ${fmtDate(eff)} or later will use the new numbers.`, { ok: 'Switch', danger: true }))) return;
    try {
      const r = await post('/contributors/apply-upcoming', { effective_date: eff });
      cache.del('directory');
      await loadSettings();
      toast(`${r.count} renumbered${r.dropped ? `, ${r.dropped} stopped` : ''}${r.renamed ? `, ${r.renamed} renamed` : ''}`);
      yearEnd();
    } catch (ex) { toast(ex.message, true); }
  };
}

export { go };
