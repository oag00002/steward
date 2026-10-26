// Offering batches: list, fast envelope entry, reconciliation, posting.
import { html, raw, $, $$, money, toCents, centsToInput, fmtDate, toast, modal, confirmBox, uuid, lastSunday } from './ui.js';
import { get, post, put, del, cache, cachedGet, outbox, flush, net } from './api.js';
import { isFinance, go, state, updateSync } from './app.js';

// ---------------- Batch list ----------------
export async function list() {
  const v = $('#view');
  const year = new URLSearchParams(location.hash.split('?')[1] || '').get('year') || new Date().getFullYear();
  const batches = await get(`/batches${isFinance() ? `?year=${year}` : ''}`);
  const years = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 6; y--) years.push(y);
  v.innerHTML = html`
    <div class="pagehead"><h1>Offerings</h1><button class="primary" id="new">Count an offering</button></div>
    ${isFinance() ? html`<div class="row" style="margin-bottom:1rem"><label for="yr" style="margin:0">Year</label>
      <select id="yr" style="width:auto">${years.map(y => html`<option ${String(y) === String(year) ? raw('selected') : ''}>${y}</option>`)}</select></div>` : ''}
    <div class="panel flush">
      ${batches.length ? html`<div class="tablewrap"><table>
        <thead><tr><th>Date</th><th>Description</th><th>Status</th><th class="num">Entries</th><th class="num">Total</th></tr></thead>
        <tbody>${batches.map(b => html`<tr class="click" data-id="${b.id}"><td>${fmtDate(b.batch_date)}</td><td>${b.description || ''}</td>
          <td><span class="pill ${b.status}">${b.status === 'open' ? 'In progress' : 'Posted'}</span></td>
          <td class="num">${b.line_count}</td><td class="num">${money(b.total_cents)}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="4">Total</td><td class="num">${money(batches.reduce((a, b) => a + b.total_cents, 0))}</td></tr></tfoot>
      </table></div>` : html`<p class="empty">No offerings recorded${isFinance() ? ` in ${year}` : ' in progress'}. Start one with “Count an offering.”</p>`}
    </div>`;
  $('#new').onclick = () => newBatch(lastSunday());
  $('#yr')?.addEventListener('change', e => go(`offerings?year=${e.target.value}`));
  $$('tr[data-id]').forEach(tr => { tr.onclick = () => go(`batch/${tr.dataset.id}`); });
}

export function newBatch(date) {
  modal(html`<h2>Count an offering</h2>
    <form id="nb">
      <div class="field"><label for="nb-d">Offering date</label><input id="nb-d" type="date" name="batch_date" value="${date}" required></div>
      <div class="field"><label for="nb-x">Description (optional)</label><input id="nb-x" name="description" placeholder="Sunday worship"></div>
      <div class="actions"><button type="button" data-x>Cancel</button><button class="primary" type="submit">Start entering</button></div>
    </form>`.toString(), (el, close) => {
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try {
        const b = await post('/batches', { batch_date: el.querySelector('#nb-d').value, description: el.querySelector('#nb-x').value });
        close();
        go(`batch/${b.id}`);
      } catch (ex) { toast(ex.message, true); }
    };
  });
}

// ---------------- One batch ----------------
const opt = {
  get showCheck() { return cache.get('opt.showCheck') === true; },
  set showCheck(v) { cache.set('opt.showCheck', v); },
  get skipFund() { return cache.get('opt.skipFund') === true; },
  set skipFund(v) { cache.set('opt.skipFund', v); },
};

let ctx = null; // current batch screen state

export async function batch(id) {
  const v = $('#view');
  const [b, dir, funds] = await Promise.all([
    cachedGet(`/batches/${id}`, `batch.${id}`),
    cachedGet('/contributors/directory', 'directory'),
    cachedGet('/funds', 'funds'),
  ]);
  ctx = { id: String(id), b, dir, funds, byEnv: new Map(dir.filter(d => d.envelope_no != null).map(d => [d.envelope_no, d])) };
  const open = b.status === 'open';
  const activeFunds = funds.filter(f => f.active);
  const lastFund = cache.get('lastFund');
  const defaultFund = activeFunds.find(f => f.id === lastFund) || activeFunds[0];

  v.innerHTML = html`
    <a class="back noprint" href="#/offerings">← Offerings</a>
    <div class="pagehead">
      <div><h1>${fmtDate(b.batch_date, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}</h1>
        <span class="pill ${b.status}">${open ? 'In progress' : 'Posted'}</span> ${b.description ? html`<span class="muted">${b.description}</span>` : ''}
        ${b.posted_at ? html`<span class="small muted">· posted by ${b.posted_by_name}</span>` : ''}</div>
      <div class="row noprint">
        ${open ? html`<button id="edit-head">Edit date</button>` : ''}
        <button id="print">Print</button>
        ${open && isFinance() ? html`<button class="primary" id="post">Post…</button>` : ''}
        ${!open && isFinance() ? html`<button id="reopen">Reopen</button>` : ''}
      </div>
    </div>

    ${open ? html`
    <form class="envelope noprint" id="entry" autocomplete="off">
      <p class="who-line" id="who" aria-live="polite">Type an envelope number</p>
      <div class="entry">
        <div><label for="env">Envelope #</label><input id="env" inputmode="numeric" pattern="[0-9]*" enterkeyhint="next" autocomplete="off"></div>
        <div><label for="fund">Fund</label><select id="fund" ${opt.skipFund ? raw('tabindex="-1"') : ''}>${activeFunds.map(f => html`<option value="${f.id}" ${f.id === defaultFund?.id ? raw('selected') : ''}>${f.code} · ${f.name}</option>`)}</select></div>
        <div class="chk" ${opt.showCheck ? '' : raw('hidden')}><label for="chk">Check #</label><input id="chk" inputmode="numeric" enterkeyhint="next"></div>
        <div class="amt"><label for="amt">Amount</label><input id="amt" inputmode="decimal" enterkeyhint="done" placeholder="0.00"></div>
        <div class="amt"><button class="add" type="submit">Add</button></div>
      </div>
      <div class="opts">
        <label><input type="checkbox" id="o-chk" ${opt.showCheck ? raw('checked') : ''}> Record check numbers</label>
        <label><input type="checkbox" id="o-fund" ${opt.skipFund ? raw('checked') : ''}> Tab skips fund</label>
        <span class="muted">Envelope 0 = loose offering</span>
      </div>
    </form>` : ''}

    <div class="tally" id="tally"></div>
    <div class="panel flush"><ul class="list lines" id="lines"></ul></div>
    <div class="grid2">
      <div class="panel" id="recon"></div>
      <div class="panel" id="byfund"></div>
    </div>
    ${open && isFinance() ? html`<p class="noprint"><button class="danger" id="delete">Delete this offering</button></p>` : ''}`;

  renderLines();
  if (open) wireEntry();
  $('#print').onclick = () => window.print();
  $('#post')?.addEventListener('click', postBatch);
  $('#reopen')?.addEventListener('click', async () => {
    if (!(await confirmBox('Reopen this offering for changes? Its gifts will stay on statements, but it must be posted again.', { ok: 'Reopen' }))) return;
    await post(`/batches/${id}/reopen`); toast('Reopened'); batch(id);
  });
  $('#delete')?.addEventListener('click', async () => {
    if (!(await confirmBox('Delete this offering and every entry in it?', { ok: 'Delete', danger: true }))) return;
    await del(`/batches/${id}`); outbox.save(outbox.all().filter(x => String(x.batch_id) !== ctx.id)); toast('Deleted'); go('offerings');
  });
  $('#edit-head')?.addEventListener('click', editHeader);
}

function nameFor(envNo) {
  if (envNo === 0) return { loose: true, display_name: 'Loose offering (no envelope)' };
  return ctx.byEnv.get(envNo) || null;
}

function wireEntry() {
  const env = $('#env'), amt = $('#amt'), fund = $('#fund'), chk = $('#chk'), who = $('#who');
  let current = null;
  const updateWho = () => {
    const txt = env.value.trim();
    who.className = 'who-line';
    current = null;
    if (!txt) { who.textContent = 'Type an envelope number'; return; }
    const n = Number(txt);
    if (!Number.isInteger(n)) { who.textContent = 'Envelope numbers are whole numbers'; who.classList.add('miss'); return; }
    const hit = nameFor(n);
    if (hit) {
      current = { n, ...hit };
      who.textContent = hit.loose ? hit.display_name : `#${n}  ${hit.display_name}${hit.active === false ? ' (inactive)' : ''}`;
      if (hit.loose) who.classList.add('loose');
    } else { who.textContent = `No envelope #${n}`; who.classList.add('miss'); }
  };
  env.addEventListener('input', updateWho);
  env.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (current) (opt.showCheck ? chk : amt).focus(); else refreshDirIfMissing(env, updateWho); }
  });
  env.addEventListener('blur', () => { if (env.value && !current) refreshDirIfMissing(env, updateWho, true); });
  if (opt.skipFund) env.addEventListener('keydown', e => { if (e.key === 'Tab' && !e.shiftKey && current) { e.preventDefault(); (opt.showCheck ? chk : amt).focus(); } });
  chk.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); amt.focus(); } });
  fund.addEventListener('change', () => cache.set('lastFund', Number(fund.value)));
  $('#o-chk').onchange = e => { opt.showCheck = e.target.checked; $('.chk').hidden = !e.target.checked; };
  $('#o-fund').onchange = e => { opt.skipFund = e.target.checked; batch(ctx.id); };

  $('#entry').onsubmit = e => {
    e.preventDefault();
    if (!current) { toast(env.value ? `No envelope #${env.value}. Add it under Envelopes first.` : 'Type an envelope number first.', true); env.focus(); return; }
    const cents = toCents(amt.value);
    if (!cents) { toast('Enter an amount.', true); amt.focus(); return; }
    const f = ctx.funds.find(x => String(x.id) === fund.value);
    const payload = current.loose
      ? { anonymous: true, fund_id: f.id, amount: centsToInput(cents), check_no: opt.showCheck ? chk.value.trim() : '' }
      : { contributor_id: current.id, envelope_no: current.n, fund_id: f.id, amount: centsToInput(cents), check_no: opt.showCheck ? chk.value.trim() : '' };
    const id = uuid();
    outbox.add({
      client_id: id, batch_id: ctx.id, payload,
      display: { envelope_no: current.loose ? null : current.n, display_name: current.display_name, fund_code: f.code, fund_name: f.name, amount_cents: cents, check_no: payload.check_no },
    });
    ctx.flashId = id;
    env.value = ''; amt.value = ''; chk.value = '';
    updateWho();
    env.focus();
    renderLines();
    flush();
  };
}

async function refreshDirIfMissing(envInput, updateWho, quiet = false) {
  if (!net.online) return;
  try {
    const dir = await get('/contributors/directory');
    cache.set('directory', dir);
    ctx.dir = dir;
    ctx.byEnv = new Map(dir.filter(d => d.envelope_no != null).map(d => [d.envelope_no, d]));
    updateWho();
    if (!quiet && ctx.byEnv.has(Number(envInput.value))) $('#amt').focus();
  } catch { /* keep the local list */ }
}

// Combine saved lines with lines still on this phone and redraw totals.
function renderLines() {
  const saved = ctx.b.lines;
  const local = outbox.forBatch(ctx.id);
  const savedIds = new Set(saved.map(l => l.client_id).filter(Boolean));
  const pending = local.filter(x => !savedIds.has(x.client_id));
  const all = [
    ...pending.map(p => ({ ...p.display, local: p })),
    ...saved,
  ];
  const open = ctx.b.status === 'open';
  const ul = $('#lines');
  ul.innerHTML = all.length ? html`${[...pending.slice().reverse().map(p => ({ ...p.display, local: p })), ...saved.slice().reverse()].map(l => html`
    <li class="${l.local ? l.local.status : ''} ${l.local && l.local.client_id === ctx.flashId ? 'flash' : ''}" data-id="${l.id || ''}" data-cid="${l.local?.client_id || ''}">
      <div class="item" ${open ? raw('role="button" tabindex="0"') : ''}>
        <span class="env-no">${l.envelope_no ?? '—'}</span>
        <span class="nm">${l.display_name}<small>${l.fund_code} · ${l.fund_name}${l.check_no ? ` · check ${l.check_no}` : ''}${l.local ? (l.local.status === 'failed' ? ` · not saved: ${l.local.error}` : ' · saving…') : ''}</small></span>
        <span class="amt">${money(l.amount_cents)}</span>
      </div></li>`)}` : html`<li class="empty">No entries yet.</li>`;
  if (open) $$('#lines li[data-id], #lines li[data-cid]').forEach(li => {
    const item = li.querySelector('.item');
    if (!item) return;
    const act = () => editLine(li.dataset.id, li.dataset.cid);
    item.onclick = act;
    item.onkeydown = e => { if (e.key === 'Enter') act(); };
  });

  const total = all.reduce((a, l) => a + l.amount_cents, 0);
  const checks = all.filter(l => l.check_no).reduce((a, l) => a + l.amount_cents, 0);
  const envs = new Set(all.filter(l => l.envelope_no != null).map(l => l.envelope_no)).size;
  $('#tally').innerHTML = html`<span class="big">${money(total)}</span><span class="muted">${all.length} entries · ${envs} envelopes</span>
    ${pending.length ? html`<span class="pill open">${pending.length} not yet on server</span>` : ''}`;

  // Reconciliation against what was physically counted.
  const b = ctx.b;
  const counted = (b.counted_cash_cents ?? null) === null && (b.counted_checks_cents ?? null) === null ? null : (b.counted_cash_cents || 0) + (b.counted_checks_cents || 0);
  const diff = counted === null ? null : total - counted;
  const anyChecks = all.some(l => l.check_no);
  $('#recon').innerHTML = html`<h3>Check against the count</h3>
    <div class="fields">
      <div class="field"><label for="cc">Counted cash</label><input id="cc" inputmode="decimal" value="${centsToInput(b.counted_cash_cents)}" ${open ? '' : raw('disabled')}></div>
      <div class="field"><label for="ck">Counted checks</label><input id="ck" inputmode="decimal" value="${centsToInput(b.counted_checks_cents)}" ${open ? '' : raw('disabled')}></div>
    </div>
    <table><tbody>
      <tr><td>Entered</td><td class="num">${money(total)}</td></tr>
      ${anyChecks ? html`<tr><td class="small muted">…cash (no check #)</td><td class="num small">${money(total - checks)}</td></tr><tr><td class="small muted">…checks</td><td class="num small">${money(checks)}</td></tr>` : ''}
      <tr><td>Counted</td><td class="num">${counted === null ? '—' : money(counted)}</td></tr>
      <tr><td>Difference</td><td class="num diff ${diff === null ? '' : diff === 0 ? 'ok' : 'off'}">${diff === null ? '—' : diff === 0 ? 'Balanced' : money(diff)}</td></tr>
    </tbody></table>`;
  if (open) {
    const saveCount = async () => {
      const cash = toCents($('#cc').value), chk = toCents($('#ck').value);
      if (cash === ctx.b.counted_cash_cents && chk === ctx.b.counted_checks_cents) return;
      ctx.b.counted_cash_cents = cash; ctx.b.counted_checks_cents = chk;
      try { await put(`/batches/${ctx.id}`, { counted_cash_cents: cash, counted_checks_cents: chk }); } catch (e) { toast(e.message, true); }
      renderLines();
    };
    $('#cc').onchange = saveCount; $('#ck').onchange = saveCount;
  }

  const byFund = {};
  for (const l of all) {
    byFund[l.fund_code] = byFund[l.fund_code] || { name: l.fund_name, code: l.fund_code, t: 0, n: 0 };
    byFund[l.fund_code].t += l.amount_cents; byFund[l.fund_code].n++;
  }
  const rows = Object.values(byFund).sort((a, b2) => a.code - b2.code);
  $('#byfund').innerHTML = html`<h3>By fund</h3>${rows.length ? html`<table><tbody>${rows.map(r => html`<tr><td>${r.code} · ${r.name} <span class="small muted">(${r.n})</span></td><td class="num">${money(r.t)}</td></tr>`)}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${money(total)}</td></tr></tfoot></table>` : html`<p class="muted">Nothing entered yet.</p>`}`;
}

// When the outbox empties, pull the server's copy so line ids are real.
window.addEventListener('steward:flushed', async () => {
  updateSync();
  if (!ctx || !document.getElementById('lines') || !location.hash.startsWith(`#/batch/${ctx.id}`)) return;
  try {
    ctx.b = await get(`/batches/${ctx.id}`);
    cache.set(`batch.${ctx.id}`, ctx.b);
  } catch { /* offline — keep showing local copy */ }
  ctx.flashId = null;
  renderLines();
});

function editLine(id, cid) {
  const local = cid ? outbox.all().find(x => x.client_id === cid) : null;
  const line = local ? { ...local.display, fund_id: local.payload.fund_id, memo: local.payload.memo } : ctx.b.lines.find(l => String(l.id) === String(id));
  if (!line) return;
  const funds = ctx.funds.filter(f => f.active || f.id === line.fund_id);
  modal(html`<h2>Edit entry</h2>
    ${local?.status === 'failed' ? html`<div class="error-box">Not saved: ${local.error}</div>` : ''}
    <form>
      <div class="fields">
        <div class="field"><label for="e-env">Envelope # (0 = loose)</label><input id="e-env" inputmode="numeric" value="${line.envelope_no ?? 0}"></div>
        <div class="field"><label for="e-amt">Amount</label><input id="e-amt" inputmode="decimal" value="${centsToInput(line.amount_cents)}"></div>
      </div>
      <div class="field"><label for="e-fund">Fund</label><select id="e-fund">${funds.map(f => html`<option value="${f.id}" ${f.id === line.fund_id || (!line.fund_id && f.code === line.fund_code) ? raw('selected') : ''}>${f.code} · ${f.name}</option>`)}</select></div>
      <div class="fields">
        <div class="field"><label for="e-chk">Check #</label><input id="e-chk" value="${line.check_no || ''}"></div>
        <div class="field"><label for="e-memo">Note</label><input id="e-memo" value="${line.memo || ''}"></div>
      </div>
      <p class="small muted" id="e-who"></p>
      <div class="actions"><button type="button" class="danger" data-del>Delete</button><span class="spacer"></span><button type="button" data-x>Cancel</button><button class="primary" type="submit">Save</button></div>
    </form>`.toString(), (el, close) => {
    const envI = el.querySelector('#e-env');
    const who = el.querySelector('#e-who');
    const show = () => { const h = nameFor(Number(envI.value)); who.textContent = h ? h.display_name : `No envelope #${envI.value}`; };
    envI.oninput = show; show();
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('[data-del]').onclick = async () => {
      if (local) outbox.remove(cid);
      else { try { await del(`/batches/${ctx.id}/lines/${id}`); ctx.b.lines = ctx.b.lines.filter(l => String(l.id) !== String(id)); } catch (e) { return toast(e.message, true); } }
      close(); renderLines(); toast('Entry deleted');
    };
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const n = Number(envI.value);
      const hit = nameFor(n);
      if (!hit) return toast(`No envelope #${envI.value}`, true);
      const cents = toCents(el.querySelector('#e-amt').value);
      if (!cents) return toast('Enter an amount.', true);
      const f = ctx.funds.find(x => String(x.id) === el.querySelector('#e-fund').value);
      const payload = hit.loose ? { anonymous: true } : { contributor_id: hit.id, envelope_no: n };
      Object.assign(payload, { fund_id: f.id, amount: centsToInput(cents), check_no: el.querySelector('#e-chk').value.trim(), memo: el.querySelector('#e-memo').value.trim() });
      if (local) {
        outbox.update(cid, { status: 'pending', error: null, payload, display: { envelope_no: hit.loose ? null : n, display_name: hit.display_name, fund_code: f.code, fund_name: f.name, amount_cents: cents, check_no: payload.check_no } });
        close(); renderLines(); flush(); return;
      }
      try { await put(`/batches/${ctx.id}/lines/${id}`, payload); } catch (ex) { return toast(ex.message, true); }
      close();
      ctx.b = await get(`/batches/${ctx.id}`);
      renderLines(); toast('Saved');
    };
  });
}

function editHeader() {
  modal(html`<h2>Offering details</h2><form>
    <div class="field"><label for="h-d">Offering date</label><input id="h-d" type="date" value="${ctx.b.batch_date}" required></div>
    <div class="field"><label for="h-x">Description</label><input id="h-x" value="${ctx.b.description || ''}"></div>
    <div class="actions"><button type="button" data-x>Cancel</button><button class="primary" type="submit">Save</button></div></form>`.toString(), (el, close) => {
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { await put(`/batches/${ctx.id}`, { batch_date: el.querySelector('#h-d').value, description: el.querySelector('#h-x').value }); close(); batch(ctx.id); }
      catch (ex) { toast(ex.message, true); }
    };
  });
}

async function postBatch() {
  if (outbox.forBatch(ctx.id).length) return toast('Some entries are still on this phone. Wait for them to send (or fix them) before posting.', true);
  const fresh = await get(`/batches/${ctx.id}`);
  ctx.b = fresh;
  const s = fresh.summary;
  const counted = fresh.counted_cash_cents == null && fresh.counted_checks_cents == null ? null : (fresh.counted_cash_cents || 0) + (fresh.counted_checks_cents || 0);
  const events = await get('/events');
  const lastEv = cache.get('postEvent');
  modal(html`<h2>Post this offering</h2>
    <p>${s.line_count} entries totaling <strong>${money(s.total_cents)}</strong>. Posting adds these gifts to each giver's record and statement.</p>
    ${counted !== null && counted !== s.total_cents ? html`<div class="error-box">Entered total differs from the count by ${money(s.total_cents - counted)}.</div>` : ''}
    ${counted === null ? html`<div class="note">You haven't entered the counted cash and checks, so this hasn't been checked against the count.</div>` : ''}
    <form>
      <div class="field"><label for="p-dep">Deposit date (optional)</label><input id="p-dep" type="date" value="${fresh.batch_date}"></div>
      <div class="field"><label for="p-ev">Also mark givers present at</label><select id="p-ev"><option value="">Don't record attendance</option>
        ${events.filter(x => x.active).map(x => html`<option value="${x.id}" ${x.id === lastEv ? raw('selected') : ''}>${x.name} on ${fmtDate(fresh.batch_date)}</option>`)}</select></div>
      <div class="actions"><button type="button" data-x>Cancel</button><button class="primary" type="submit">Post ${money(s.total_cents)}</button></div>
    </form>`.toString(), (el, close) => {
    el.querySelector('[data-x]').onclick = close;
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const ev = el.querySelector('#p-ev').value;
      cache.set('postEvent', ev ? Number(ev) : null);
      try {
        const r = await post(`/batches/${ctx.id}/post`, { deposit_date: el.querySelector('#p-dep').value, attendance_event_id: ev || null });
        close();
        toast(`Posted${r.attendance_marked ? ` · ${r.attendance_marked} marked present` : ''}`);
        batch(ctx.id);
      } catch (ex) { toast(ex.message, true); }
    };
  });
}

export { state };
