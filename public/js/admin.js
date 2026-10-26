// Settings, funds, users, imports and year-end tools.
import { html, raw, $, $$, money, fmtDate, toast, modal, confirmBox, formData, field, selectField, checkField } from './ui.js';
import { get, post, put, cache } from './api.js';
import { parseCsv, canonicalRows, downloadExport } from './csv.js';
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
      <div id="ores"></div></div>`;

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
  $('#mf').onchange = e => e.target.files[0] && run('membership', e.target.files[0], $('#mres'), () => ({}));
  $('#of').onchange = e => e.target.files[0] && run('offerings', e.target.files[0], $('#ores'), () => ({ description: $('#od').value, post: $('#opost').checked }));
}

// ---------------- Year-end ----------------
export async function yearEnd() {
  const v = $('#view');
  const [open, rows] = await Promise.all([get('/batches?status=open'), get('/contributors')]);
  const active = rows.filter(r => r.active && r.uses_envelopes);
  const planned = active.filter(r => r.upcoming_envelope_no);
  const y = new Date().getMonth() < 3 ? new Date().getFullYear() - 1 : new Date().getFullYear();
  v.innerHTML = html`
    <a class="back" href="#/settings">← Settings</a>
    <h1>Year-end</h1>
    <div class="panel"><h2>1. Post every offering</h2>
      ${open.length ? html`<p>${open.length} offering${open.length === 1 ? ' is' : 's are'} still in progress and won't appear on statements:</p>
        <ul>${open.map(b => html`<li><a href="#/batch/${b.id}">${fmtDate(b.batch_date)} — ${money(b.total_cents)}</a></li>`)}</ul>`
        : html`<p class="diff ok">Everything is posted.</p>`}</div>
    <div class="panel"><h2>2. Print giving statements</h2>
      <p>Statements cover January 1 through December 31 and are printed in envelope or name order.</p>
      <a class="btn primary" href="#/statements?year=${y}">Prepare ${y} statements</a></div>
    <div class="panel"><h2>3. Next year's envelope numbers</h2>
      <p class="small">Give everyone their number for the new box of envelopes. Gifts stay with the giver, not the number, so history and statements are unaffected. Givers marked “keep this number” are skipped.</p>
      <div class="fields">
        ${selectField('Order', 'mode', [['alphabetical', 'Alphabetical by last name'], ['keep_order', 'Keep current order, close gaps']], 'alphabetical')}
        ${field('Start numbering at', 'start', '1', 'inputmode="numeric"')}
      </div>
      <div class="row"><button class="primary" id="plan">Fill in next year's numbers</button>${planned.length ? html`<button id="clear">Clear them</button>` : ''}
        <button type="button" id="envcsv">Spreadsheet for the envelope company</button></div>
      ${planned.length ? html`<div class="tablewrap" style="margin-top:1rem;max-height:340px;overflow:auto"><table>
        <thead><tr><th>Name</th><th class="num">Now</th><th class="num">Next year</th></tr></thead>
        <tbody>${planned.sort((a, b) => a.upcoming_envelope_no - b.upcoming_envelope_no).map(r => html`<tr><td>${r.display_name}</td><td class="num">${r.envelope_no ?? ''}</td><td class="num"><strong>${r.upcoming_envelope_no}</strong></td></tr>`)}</tbody></table></div>` : ''}
    </div>
    <div class="panel"><h2>4. Switch to next year's numbers</h2>
      <p class="small">Do this after the last offering of the year is entered and the new envelopes are handed out. Each giver's old number is kept as “last year's number.”</p>
      <button class="danger" id="apply" ${planned.length ? '' : raw('disabled')}>Switch ${planned.length} envelopes to next year's numbers</button></div>`;
  $('#plan').onclick = async () => {
    if (planned.length && !(await confirmBox('Replace the next-year numbers already filled in?', { ok: 'Replace' }))) return;
    try { const r = await post('/contributors/renumber', { mode: $('#f-mode').value, start: $('#f-start').value }); toast(`${r.count} numbered`); yearEnd(); } catch (ex) { toast(ex.message, true); }
  };
  $('#envcsv').onclick = () => downloadExport('contributors').catch(ex => toast(ex.message, true));
  $('#clear')?.addEventListener('click', async () => { await post('/contributors/clear-upcoming'); yearEnd(); });
  $('#apply').onclick = async () => {
    if (open.length && !(await confirmBox(`${open.length} offerings are still in progress. Switch numbers anyway?`, { ok: 'Continue' }))) return;
    if (!(await confirmBox('Switch everyone to next year\'s envelope numbers now? Counters will need to use the new numbers from now on.', { ok: 'Switch numbers', danger: true }))) return;
    try { const r = await post('/contributors/apply-upcoming'); cache.del('directory'); toast(`${r.count} envelopes switched`); yearEnd(); } catch (ex) { toast(ex.message, true); }
  };
}

export { go };
