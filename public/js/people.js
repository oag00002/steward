// Membership (households, people) and envelopes (contributors).
import { html, raw, $, $$, money, fmtDate, toast, modal, confirmBox, formData, field, selectField, checkField } from './ui.js';
import { get, post, put, del, cache } from './api.js';
import { go } from './app.js';

const STATUSES = [['member', 'Member'], ['nonmember', 'Non-member'], ['visitor', 'Visitor'], ['friend', 'Friend'], ['inactive', 'Inactive'], ['deceased', 'Deceased']];
const RELS = [['', '—'], ['head', 'Head of household'], ['spouse', 'Spouse'], ['child', 'Child'], ['other', 'Other']];
const statusLabel = s => (STATUSES.find(x => x[0] === s) || [s, s])[1];

// ---------------- Household list ----------------
export async function list() {
  const v = $('#view');
  const term = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
  v.innerHTML = html`
    <div class="pagehead"><h1>People</h1><button class="primary" id="add">Add a household</button></div>
    <div class="field"><label for="q">Search names, city or phone</label><input id="q" type="search" value="${term}" placeholder="Smith"></div>
    <div class="panel flush" id="results"><p class="empty">Loading…</p></div>`;
  const load = async t => {
    const rows = await get(`/households${t ? `?q=${encodeURIComponent(t)}` : ''}`);
    $('#results').innerHTML = rows.length ? html`<ul class="list">${rows.map(r => html`
      <li><a class="item" href="#/household/${r.id}"><span class="spacer"><strong>${r.name}</strong>${r.active ? '' : html` <span class="pill">Inactive</span>`}<br>
        <span class="small muted">${r.people || 'No people yet'}${r.city ? ` · ${r.city}` : ''}</span></span>
        ${r.envelopes ? html`<span class="pill">#${r.envelopes}</span>` : ''}</a></li>`)}</ul>`
      : html`<p class="empty">${t ? 'No households match that search.' : 'No households yet. Add one, or import your list under Settings → Import.'}</p>`;
  };
  let timer;
  $('#q').oninput = e => { clearTimeout(timer); timer = setTimeout(() => load(e.target.value.trim()), 250); };
  $('#add').onclick = () => go('household/new');
  await load(term);
}

// ---------------- Household page ----------------
export async function household(id) {
  const v = $('#view');
  const isNew = id === 'new';
  const hh = isNew ? { active: true, people: [], contributors: [] } : await get(`/households/${id}`);
  v.innerHTML = html`
    <a class="back" href="#/people">← People</a>
    <div class="pagehead"><h1>${isNew ? 'New household' : hh.name}</h1></div>
    <form class="panel" id="hhf">
      ${isNew ? html`<div class="note">Enter the family's last name and address. You can add the people in it on the next screen, or name the first two here.</div>` : ''}
      <div class="fields">
        ${field('Household name', 'name', hh.name, 'required placeholder="Smith"')}
        ${field('Mailing name', 'mailing_name', hh.mailing_name, 'placeholder="Mr. and Mrs. John Smith"')}
      </div>
      ${isNew ? html`<div class="fields">${field('First person, first name', 'p1', '', 'placeholder="John"')}${field('Their spouse, first name', 'p2', '', 'placeholder="Mary"')}
        ${selectField('Membership status', 'status', STATUSES, 'member')}</div>` : ''}
      ${field('Street address', 'address1', hh.address1, 'autocomplete="address-line1"')}
      ${field('Address line 2', 'address2', hh.address2, 'autocomplete="address-line2"')}
      <div class="fields">${field('City', 'city', hh.city)}${field('State', 'state', hh.state, 'maxlength="20"')}${field('ZIP', 'zip', hh.zip, 'inputmode="numeric"')}</div>
      <div class="fields">${field('Home phone', 'phone', hh.phone, 'type="tel"')}${field('Household email', 'email', hh.email, 'type="email"')}</div>
      <details ${hh.alt_address1 ? raw('open') : ''}><summary class="small" style="margin-bottom:.6rem;cursor:pointer">Seasonal / alternate address</summary>
        ${field('Alternate street address', 'alt_address1', hh.alt_address1)}
        ${field('Alternate line 2', 'alt_address2', hh.alt_address2)}
        <div class="fields">${field('City', 'alt_city', hh.alt_city)}${field('State', 'alt_state', hh.alt_state)}${field('ZIP', 'alt_zip', hh.alt_zip)}</div>
        <div class="fields">${field('Use from', 'alt_begin', hh.alt_begin, 'type="date"')}${field('Use until', 'alt_end', hh.alt_end, 'type="date"')}</div>
        <p class="small muted">Statements mail to the alternate address while today falls between these dates.</p>
      </details>
      <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" name="notes">${hh.notes || ''}</textarea></div>
      ${isNew ? '' : checkField('Active household', 'active', hh.active)}
      <div class="row"><button class="primary" type="submit">${isNew ? 'Create household' : 'Save household'}</button><span class="spacer"></span>
        ${isNew ? '' : html`<button type="button" class="danger" id="del">Delete</button>`}</div>
    </form>
    ${isNew ? '' : html`
    <div class="panel flush">
      <div class="row" style="padding:1rem 1rem 0"><h2 style="margin:0">People</h2><span class="spacer"></span><button id="addp">Add a person</button></div>
      ${hh.people.length ? html`<ul class="list">${hh.people.map(p => html`
        <li><a class="item" href="#" data-pid="${p.id}"><span class="spacer"><strong>${p.first_name} ${p.last_name}${p.suffix ? ` ${p.suffix}` : ''}</strong><br>
          <span class="small muted">${(RELS.find(r => r[0] === p.relationship) || ['', ''])[1]}${p.relationship ? ' · ' : ''}${statusLabel(p.status)}${p.birth_date ? ` · born ${fmtDate(p.birth_date)}` : ''}</span></span></a></li>`)}</ul>`
        : html`<p class="empty">No one is in this household yet.</p>`}
    </div>
    <div class="panel flush">
      <div class="row" style="padding:1rem 1rem 0"><h2 style="margin:0">Envelopes</h2><span class="spacer"></span>${hh.people.length ? html`<button id="adde">Give an envelope</button>` : ''}</div>
      ${hh.contributors.length ? html`<ul class="list">${hh.contributors.map(c => html`
        <li><a class="item" href="#/envelope/${c.id}"><span class="env-no" style="min-width:3.5rem;font-weight:700">#${c.envelope_no ?? '—'}</span><span class="spacer">${c.display_name}${c.active ? '' : html` <span class="pill">Inactive</span>`}</span></a></li>`)}</ul>`
        : html`<p class="empty">No envelope assigned. Give one so this household's giving can be recorded.</p>`}
    </div>`}`;

  $('#hhf').onsubmit = async e => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      if (isNew) {
        const people = [d.p1 && { first_name: d.p1, last_name: d.name, relationship: 'head', status: d.status },
          d.p2 && { first_name: d.p2, last_name: d.name, relationship: 'spouse', status: d.status }].filter(Boolean);
        delete d.p1; delete d.p2; delete d.status;
        const row = await post('/households', { ...d, people });
        toast('Household created');
        go(`household/${row.id}`);
      } else {
        await put(`/households/${id}`, d);
        toast('Saved');
        household(id);
      }
    } catch (ex) { toast(ex.message, true); }
  };
  if (isNew) return;
  $('#del').onclick = async () => {
    if (!(await confirmBox(`Delete the ${hh.name} household and everyone in it? This cannot be undone.`, { ok: 'Delete', danger: true }))) return;
    try { await del(`/households/${id}`); toast('Deleted'); go('people'); } catch (ex) { toast(ex.message, true); }
  };
  $('#addp').onclick = () => personModal({ household_id: hh.id, last_name: hh.name, status: 'member' }, () => household(id));
  $$('[data-pid]').forEach(a => { a.onclick = e => { e.preventDefault(); personModal(hh.people.find(p => String(p.id) === a.dataset.pid), () => household(id)); }; });
  $('#adde')?.addEventListener('click', () => contributorModal({ person_id: hh.people[0]?.id, joint_person_id: hh.people.find(p => p.relationship === 'spouse')?.id }, hh, () => household(id)));
}

function personModal(p, done) {
  const isNew = !p.id;
  modal(html`<h2>${isNew ? 'Add a person' : `${p.first_name} ${p.last_name}`}</h2>
    <form>
      <div class="fields">${field('First name', 'first_name', p.first_name, 'required autofocus')}${field('Last name', 'last_name', p.last_name, 'required')}</div>
      <div class="fields">${field('Goes by', 'nickname', p.nickname)}${field('Suffix', 'suffix', p.suffix, 'placeholder="Jr."')}</div>
      <div class="fields">${selectField('Relationship', 'relationship', RELS, p.relationship)}${selectField('Status', 'status', STATUSES, p.status)}</div>
      <div class="fields">${selectField('Gender', 'gender', [['', '—'], ['M', 'Male'], ['F', 'Female']], p.gender)}${field('Birth date', 'birth_date', p.birth_date, 'type="date"')}</div>
      <div class="fields">${field('Email', 'email', p.email, 'type="email"')}${field('Cell phone', 'phone', p.phone, 'type="tel"')}</div>
      <details ${p.date_received || p.membership_code ? raw('open') : ''}><summary class="small" style="margin-bottom:.6rem;cursor:pointer">Church record</summary>
        <div class="fields">${field('Membership code', 'membership_code', p.membership_code, 'placeholder="Communicant"')}${field('Received by', 'received_by', p.received_by, 'placeholder="Transfer, baptism…"')}</div>
        <div class="fields">${field('Date received', 'date_received', p.date_received, 'type="date"')}${field('Baptism', 'baptism_date', p.baptism_date, 'type="date"')}</div>
        <div class="fields">${field('Confirmation', 'confirmation_date', p.confirmation_date, 'type="date"')}${field('Wedding', 'wedding_date', p.wedding_date, 'type="date"')}</div>
        ${field('Date of death', 'death_date', p.death_date, 'type="date"')}
      </details>
      <div class="field"><label for="f-pn">Notes</label><textarea id="f-pn" name="notes">${p.notes || ''}</textarea></div>
      <div class="actions">${isNew ? '' : html`<button type="button" class="danger" data-del>Delete</button><span class="spacer"></span>`}<button type="button" data-x>Cancel</button><button class="primary" type="submit">Save</button></div>
    </form>`.toString(), (el, close) => {
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmBox(`Delete ${p.first_name} ${p.last_name}?`, { ok: 'Delete', danger: true }))) return;
      try { await del(`/people/${p.id}`); close(); toast('Deleted'); done(); } catch (ex) { toast(ex.message, true); }
    });
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const d = { ...formData(e.target), household_id: p.household_id };
      try { isNew ? await post('/people', d) : await put(`/people/${p.id}`, d); close(); toast('Saved'); done(); }
      catch (ex) { toast(ex.message, true); }
    };
  });
}

// ---------------- Envelope (contributor) form ----------------
async function contributorModal(c, hh, done) {
  const isNew = !c.id;
  const next = await get('/contributors/next-envelope');
  let householdPeople = hh?.people || [];
  if (!hh && c.household_id) householdPeople = (await get(`/households/${c.household_id}`)).people;
  const isOther = !isNew ? !c.person_id : !hh && !c.person_id;
  modal(html`<h2>${isNew ? 'Give an envelope' : `Envelope #${c.envelope_no ?? ''}`}</h2>
    <form>
      ${hh ? '' : html`<div class="field"><label>Who gives with this envelope?</label>
        <label class="check"><input type="radio" name="kind" value="member" ${!isOther ? raw('checked') : ''}> Someone in membership</label>
        <label class="check"><input type="radio" name="kind" value="other" ${isOther ? raw('checked') : ''}> Other giver (not in membership)</label></div>`}
      <div data-member ${isOther ? raw('hidden') : ''}>
        ${hh ? '' : html`<div class="field"><label for="c-find">Find a person</label><input id="c-find" type="search" placeholder="Type a name" autocomplete="off"></div>
          <ul class="list panel flush" id="c-hits" hidden></ul>`}
        <div class="field"><label for="c-person">Primary contributor</label><select id="c-person" name="person_id">
          ${householdPeople.map(p => html`<option value="${p.id}" ${p.id === c.person_id ? raw('selected') : ''}>${p.first_name} ${p.last_name}</option>`)}</select></div>
        <div class="field"><label for="c-joint">Shared with (same household)</label><select id="c-joint" name="joint_person_id"><option value="">Nobody — individual envelope</option>
          ${householdPeople.map(p => html`<option value="${p.id}" ${p.id === c.joint_person_id ? raw('selected') : ''}>${p.first_name} ${p.last_name}</option>`)}</select></div>
      </div>
      <div data-other ${isOther ? '' : raw('hidden')}>
        ${field('Giver name', 'other_name', c.other_name, 'placeholder="Jane Doe or Smith Family Foundation"')}
        ${field('Street address', 'other_address1', c.other_address1)}
        ${field('Address line 2', 'other_address2', c.other_address2)}
        <div class="fields">${field('City', 'other_city', c.other_city)}${field('State', 'other_state', c.other_state)}${field('ZIP', 'other_zip', c.other_zip)}</div>
        ${field('Email', 'other_email', c.other_email, 'type="email"')}
      </div>
      <div class="fields">
        <div class="field"><label for="c-env">Envelope number</label><input id="c-env" name="envelope_no" inputmode="numeric" value="${c.envelope_no ?? (isNew ? next.next_available : '')}"></div>
        <div class="field"><label>&nbsp;</label><div class="row"><button type="button" data-n="${next.next_available}">Lowest free (${next.next_available})</button><button type="button" data-n="${next.next_highest}">Next (${next.next_highest})</button></div></div>
      </div>
      ${field('Name on statements (optional)', 'custom_name', c.custom_name, 'placeholder="Leave blank to use their names"')}
      ${selectField('Send year-end statement by', 'statement_method', [['mail', 'Mail'], ['email', 'Email'], ['none', "Don't send"]], c.statement_method || 'mail')}
      ${checkField('Uses physical envelopes (unchecked gives a number from 100000 up)', 'uses_envelopes', c.uses_envelopes !== false)}
      ${checkField('Keep this number when renumbering for next year', 'skip_renumber', c.skip_renumber)}
      ${isNew ? '' : checkField('Active', 'active', c.active !== false)}
      <div class="field"><label for="c-notes">Notes</label><input id="c-notes" name="notes" value="${c.notes || ''}"></div>
      <div class="actions">${isNew ? '' : html`<button type="button" class="danger" data-del>Delete</button><span class="spacer"></span>`}<button type="button" data-x>Cancel</button><button class="primary" type="submit">Save envelope</button></div>
    </form>`.toString(), (el, close) => {
    const form = el.querySelector('form');
    el.querySelector('[data-x]').onclick = close;
    $$('[data-n]', el).forEach(b => { b.onclick = () => { el.querySelector('#c-env').value = b.dataset.n; }; });
    $$('input[name="kind"]', el).forEach(r => { r.onchange = () => {
      const other = el.querySelector('input[name="kind"]:checked').value === 'other';
      el.querySelector('[data-member]').hidden = other; el.querySelector('[data-other]').hidden = !other;
    }; });
    const find = el.querySelector('#c-find');
    if (find) {
      let t;
      find.oninput = () => { clearTimeout(t); t = setTimeout(async () => {
        const hits = find.value.trim() ? await get(`/people?q=${encodeURIComponent(find.value.trim())}`) : [];
        const ul = el.querySelector('#c-hits');
        ul.hidden = !hits.length;
        ul.innerHTML = html`${hits.slice(0, 8).map(p => html`<li><a class="item" href="#" data-h="${p.household_id}" data-p="${p.id}">${p.first_name} ${p.last_name} <span class="small muted">· ${p.household_name}</span></a></li>`)}`;
        $$('[data-h]', ul).forEach(a => { a.onclick = async e => {
          e.preventDefault();
          const h2 = await get(`/households/${a.dataset.h}`);
          const opts = h2.people.map(p => `<option value="${p.id}">${html`${p.first_name} ${p.last_name}`}</option>`).join('');
          el.querySelector('#c-person').innerHTML = opts;
          el.querySelector('#c-person').value = a.dataset.p;
          el.querySelector('#c-joint').innerHTML = '<option value="">Nobody — individual envelope</option>' + opts;
          const sp = h2.people.find(p => p.relationship === 'spouse' && String(p.id) !== a.dataset.p);
          el.querySelector('#c-joint').value = sp ? sp.id : '';
          ul.hidden = true; find.value = `${h2.name} household`;
        }; });
      }, 250); };
    }
    el.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmBox(`Delete envelope #${c.envelope_no}?`, { ok: 'Delete', danger: true }))) return;
      try { await del(`/contributors/${c.id}`); close(); toast('Deleted'); go('envelopes'); } catch (ex) { toast(ex.message, true); }
    });
    form.onsubmit = async e => {
      e.preventDefault();
      const d = formData(form);
      const other = hh ? false : el.querySelector('input[name="kind"]:checked').value === 'other';
      if (other) { d.person_id = null; d.joint_person_id = null; } else { d.other_name = null; }
      if (!d.person_id && !other) return toast('Choose a person first.', true);
      try {
        isNew ? await post('/contributors', d) : await put(`/contributors/${c.id}`, d);
        cache.del('directory');
        close(); toast('Envelope saved'); done();
      } catch (ex) { toast(ex.message, true); }
    };
  });
}

// ---------------- Envelope list ----------------
export async function envelopes() {
  const v = $('#view');
  const year = new Date().getFullYear();
  const rows = await get(`/contributors?year=${year}`);
  v.innerHTML = html`
    <div class="pagehead"><h1>Envelopes</h1><button class="primary" id="add">Add an envelope</button></div>
    <div class="row" style="margin-bottom:.8rem"><input id="q" type="search" placeholder="Filter by number or name" style="flex:1;min-width:200px">
      <label class="check" style="margin:0"><input type="checkbox" id="inact"> Show inactive</label></div>
    <div class="panel flush"><div class="tablewrap"><table>
      <thead><tr><th class="num">#</th><th>Name</th><th>Statement</th><th class="num">${year} giving</th></tr></thead>
      <tbody id="tb"></tbody></table></div></div>`;
  const draw = () => {
    const t = $('#q').value.trim().toLowerCase();
    const showInactive = $('#inact').checked;
    const list = rows.filter(r => (showInactive || r.active) && (!t || String(r.envelope_no).startsWith(t) || r.display_name.toLowerCase().includes(t)));
    $('#tb').innerHTML = list.length ? html`${list.map(r => html`<tr class="click" data-id="${r.id}">
      <td class="num"><strong>${r.envelope_no ?? '—'}</strong>${r.upcoming_envelope_no && r.upcoming_envelope_no !== r.envelope_no ? html`<br><span class="small muted">→ ${r.upcoming_envelope_no}</span>` : ''}</td>
      <td>${r.display_name}${r.is_other_giver ? html` <span class="pill">Other giver</span>` : ''}${r.active ? '' : html` <span class="pill">Inactive</span>`}</td>
      <td class="small">${{ mail: 'Mail', email: 'Email', none: "Don't send" }[r.statement_method]}</td>
      <td class="num">${money(r.year_total_cents, { blankZero: true })}</td></tr>`)}`
      : html`<tr><td colspan="4" class="empty">No envelopes match.</td></tr>`;
    $$('#tb tr[data-id]').forEach(tr => { tr.onclick = () => go(`envelope/${tr.dataset.id}`); });
  };
  $('#q').oninput = draw; $('#inact').onchange = draw;
  $('#add').onclick = () => contributorModal({}, null, () => envelopes());
  draw();
}

// ---------------- One envelope: giving history ----------------
export async function envelope(id) {
  const v = $('#view');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const year = Number(params.get('year')) || new Date().getFullYear();
  const [c, lines] = await Promise.all([get(`/contributors/${id}`), get(`/contributors/${id}/giving?from=${year}-01-01&to=${year}-12-31`)]);
  const posted = lines.filter(l => l.status === 'posted');
  const total = posted.reduce((a, l) => a + l.amount_cents, 0);
  const years = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 6; y--) years.push(y);
  v.innerHTML = html`
    <a class="back" href="#/envelopes">← Envelopes</a>
    <div class="pagehead"><div><h1>#${c.envelope_no ?? '—'} ${c.display_name}</h1>
      <span class="small muted">${c.household_name ? html`<a href="#/household/${c.household_id}">${c.household_name} household</a>` : 'Other giver'}
      ${c.prior_envelope_no ? ` · last year #${c.prior_envelope_no}` : ''}</span></div>
      <div class="row"><button id="edit">Edit envelope</button><a class="btn" href="#/statements?contributor_id=${c.id}&year=${year}">Statement</a></div></div>
    <div class="row" style="margin-bottom:1rem"><label for="yr" style="margin:0">Year</label><select id="yr" style="width:auto">${years.map(y => html`<option ${y === year ? raw('selected') : ''}>${y}</option>`)}</select>
      <span class="spacer"></span><strong class="money">${money(total)}</strong></div>
    <div class="panel flush"><div class="tablewrap"><table>
      <thead><tr><th>Date</th><th>Fund</th><th>Check</th><th class="num">Amount</th></tr></thead>
      <tbody>${lines.length ? lines.map(l => html`<tr class="click" data-b="${l.batch_id}"><td>${fmtDate(l.batch_date)}${l.status === 'open' ? html` <span class="pill open">not posted</span>` : ''}</td>
        <td>${l.fund_code} · ${l.fund_name}</td><td>${l.check_no || ''}</td><td class="num">${money(l.amount_cents)}</td></tr>`) : html`<tr><td colspan="4" class="empty">No gifts recorded in ${year}.</td></tr>`}</tbody>
      ${lines.length ? html`<tfoot><tr><td colspan="3">Posted total</td><td class="num">${money(total)}</td></tr></tfoot>` : ''}
    </table></div></div>`;
  $('#yr').onchange = e => go(`envelope/${id}?year=${e.target.value}`);
  $$('tr[data-b]').forEach(tr => { tr.onclick = () => go(`batch/${tr.dataset.b}`); });
  $('#edit').onclick = () => contributorModal(c, null, () => envelope(id));
}
