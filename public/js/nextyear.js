// Next year's envelopes: plan numbers, label names and who drops off, then print labels and the
// envelope-company spreadsheet — all without changing this year's records or statements.
import { html, raw, $, $$, fmtDate, toast, confirmBox, selectField, field } from './ui.js';
import { get, post, put, cache } from './api.js';
import { toCsv, saveFile } from './csv.js';
import { go } from './app.js';
import { contributorModal } from './people.js';

const gone = s => s === 'deceased' || s === 'inactive';
const fullName = (first, last) => [first, last].filter(Boolean).join(' ');
const labelName = r => r.upcoming_name || r.display_name;

// What Steward thinks should change for each giver, based on membership records and giving.
function suggestionFor(r, sinceYear) {
  if (r.upcoming_skip || r.is_other_giver) return null;
  const has2 = !!r.p2_first;
  const why = (s, d) => (s === 'deceased' ? `died${d ? ` ${fmtDate(d)}` : ''}` : 'inactive');
  if (gone(r.p1_status) && (!has2 || gone(r.p2_status))) {
    return { kind: 'stop', text: has2 ? `${r.p1_first} ${why(r.p1_status, r.p1_death)} and ${r.p2_first} ${why(r.p2_status, r.p2_death)}` : `${fullName(r.p1_first, r.p1_last)} ${why(r.p1_status, r.p1_death)}`, change: { upcoming_skip: true } };
  }
  if (has2 && (gone(r.p1_status) || gone(r.p2_status))) {
    const [goneFirst, status, death] = gone(r.p1_status) ? [r.p1_first, r.p1_status, r.p1_death] : [r.p2_first, r.p2_status, r.p2_death];
    const survivor = gone(r.p1_status) ? fullName(r.p2_first, r.p2_last) : fullName(r.p1_first, r.p1_last);
    if (labelName(r) === survivor) return null;
    return { kind: 'rename', text: `${goneFirst} ${why(status, death)}`, name: survivor, change: { upcoming_name: survivor } };
  }
  if (!r.last_gift || r.last_gift < `${sinceYear}-01-01`) {
    return { kind: 'quiet', text: r.last_gift ? `No gifts since ${r.last_gift.slice(0, 4)}` : 'Has never given', change: { upcoming_skip: true } };
  }
  return null;
}

export async function nextYear() {
  const v = $('#view');
  const data = await get('/contributors/next-year');
  const rows = data.rows;
  const sinceYear = new Date().getFullYear() - 2; // "quiet" = nothing given in the last two full years
  const sugg = new Map(rows.map(r => [r.id, suggestionFor(r, sinceYear)]).filter(([, s]) => s));
  const strong = [...sugg.entries()].filter(([, s]) => s.kind !== 'quiet');
  const quiet = [...sugg.entries()].filter(([, s]) => s.kind === 'quiet');
  const looksBad = r => !r.address.length || !r.zip || /\?|^0+$/.test(r.zip) || /\?/.test(r.city_line);
  const badAddress = rows.filter(r => !r.upcoming_skip && r.active && r.statement_method !== 'none' && looksBad(r));
  const suggTable = list => html`<div class="tablewrap"><table><tbody>${list.map(([id, s]) => {
    const r = rows.find(x => x.id === id);
    return html`<tr><td><strong>#${r.envelope_no ?? '—'}</strong> ${r.display_name}<br><span class="small muted">${s.text}</span></td>
      <td>${s.kind === 'rename' ? html`Print as <strong>${s.name}</strong>` : 'Stop envelopes'}</td>
      <td class="num"><button type="button" data-apply="${id}">Apply</button></td></tr>`;
  })}</tbody></table></div>`;
  const getting = rows.filter(r => !r.upcoming_skip && r.active);
  const numbered = getting.filter(r => r.upcoming_envelope_no);
  const filter = new URLSearchParams(location.hash.split('?')[1] || '').get('show') || 'all';

  v.innerHTML = html`
    <a class="back noprint" href="#/yearend">← Year-end</a>
    <div class="pagehead"><h1>Next year's envelopes</h1></div>
    <div class="note">Plan next year here at any time. Nothing on this page changes this year's names, numbers or statements; it all takes effect when you <a href="#/yearend">switch</a>.</div>
    <div class="stats">
      <div class="stat"><div class="v">${getting.length}</div><div class="l">Getting envelopes</div></div>
      <div class="stat"><div class="v">${numbered.length}</div><div class="l">Have a number</div></div>
      <div class="stat"><div class="v">${rows.filter(r => r.upcoming_skip).length}</div><div class="l">Stopping</div></div>
      <div class="stat"><div class="v">${rows.filter(r => r.upcoming_name && !r.upcoming_skip).length}</div><div class="l">New name on label</div></div>
    </div>

    ${strong.length ? html`<div class="panel"><h2>From membership changes</h2>
      <p class="small muted">Deaths and status changes recorded under People. Nothing changes until you apply it.</p>
      ${suggTable(strong)}
      <p style="margin-top:.8rem"><button class="primary" id="apply-all">Apply all ${strong.length}</button></p></div>` : ''}
    ${quiet.length ? html`<details class="panel"><summary style="cursor:pointer"><strong>${quiet.length} givers with no gifts since before ${sinceYear}</strong> <span class="small muted">— review if you like</span></summary>
      <p class="small muted" style="margin-top:.6rem">Children's envelopes and occasional givers often show up here, so these are left for you to decide one at a time.</p>
      ${suggTable(quiet)}</details>` : ''}
    ${badAddress.length ? html`<details class="panel"><summary style="cursor:pointer"><strong>${badAddress.length} addresses need checking</strong> <span class="small muted">— before labels are printed</span></summary>
      <ul class="list" style="margin-top:.6rem">${badAddress.map(r => html`<li class="item">#${r.upcoming_envelope_no ?? r.envelope_no ?? '—'} ${r.display_name}: <span class="muted">${[...r.address, r.city_line].filter(Boolean).join(', ') || 'no address'}</span>
        ${r.household_id ? html` <a href="#/household/${r.household_id}">Fix</a>` : html` <a href="#/envelope/${r.id}">Fix</a>`}</li>`)}</ul></details>` : ''}

    <div class="panel"><h2>Numbers</h2>
      <div class="fields">
        ${selectField('Order', 'mode', [['alphabetical', 'Alphabetical by last name'], ['keep_order', 'Keep current order, close gaps']], 'alphabetical')}
        ${field('Start numbering at', 'start', '1', 'inputmode="numeric"')}
      </div>
      <div class="row"><button class="primary" id="renumber">Fill in next year's numbers</button>
        <button type="button" id="add-new">Add a new giver for next year</button></div>
      <p class="small muted" style="margin-top:.5rem">Skips anyone marked <em>stop</em> and anyone set to keep their number. You can also type numbers in the list below.</p>
    </div>

    <div class="panel noprint"><h2>Print and order</h2>
      <div class="row"><a class="btn primary" href="#/labels">Print box labels</a>
        <button type="button" id="vendor">Spreadsheet for the envelope company</button></div></div>

    <div class="row" style="margin-bottom:.6rem"><input id="q" type="search" placeholder="Find a name or number" style="flex:1;min-width:180px">
      <select id="show" style="width:auto">${[['all', 'Everyone'], ['getting', 'Getting envelopes'], ['stopping', 'Stopping'], ['missing', 'No number yet']].map(([k, t]) => html`<option value="${k}" ${k === filter ? raw('selected') : ''}>${t}</option>`)}</select></div>
    <div class="panel flush"><div class="tablewrap"><table>
      <thead><tr><th class="num">Next year</th><th>Name on envelopes</th><th class="num">Now</th><th>Envelopes</th></tr></thead>
      <tbody id="plan"></tbody></table></div></div>`;

  const draw = () => {
    const t = $('#q').value.trim().toLowerCase();
    const show = $('#show').value;
    const list = rows.filter(r => (show === 'all' || (show === 'getting' && !r.upcoming_skip) || (show === 'stopping' && r.upcoming_skip) || (show === 'missing' && !r.upcoming_skip && !r.upcoming_envelope_no))
      && (!t || r.display_name.toLowerCase().includes(t) || labelName(r).toLowerCase().includes(t) || String(r.envelope_no ?? '').startsWith(t) || String(r.upcoming_envelope_no ?? '').startsWith(t)));
    $('#plan').innerHTML = list.length ? html`${list.map(r => html`<tr data-id="${r.id}" ${r.upcoming_skip ? raw('style="opacity:.55"') : ''}>
      <td class="num"><input data-f="upcoming_envelope_no" inputmode="numeric" value="${r.upcoming_envelope_no ?? ''}" style="width:5.5rem;text-align:right" ${r.upcoming_skip ? raw('disabled') : ''} aria-label="Next year's number"></td>
      <td><input data-f="upcoming_name" value="${r.upcoming_name ?? ''}" placeholder="${r.display_name}" ${r.upcoming_skip ? raw('disabled') : ''} aria-label="Name on next year's envelopes">
        ${sugg.get(r.id) ? html`<span class="small muted">${sugg.get(r.id).text}</span>` : ''}</td>
      <td class="num">${r.envelope_no ?? 'new'}</td>
      <td><label class="check" style="margin:0"><input type="checkbox" data-f="keep" ${r.upcoming_skip ? '' : raw('checked')}> ${r.upcoming_skip ? 'Stopping' : 'Yes'}</label></td></tr>`)}`
      : html`<tr><td colspan="4" class="empty">Nobody matches.</td></tr>`;
    $$('#plan tr[data-id]').forEach(tr => {
      const r = rows.find(x => String(x.id) === tr.dataset.id);
      tr.querySelectorAll('[data-f]').forEach(inp => {
        inp.onchange = async () => {
          const f = inp.dataset.f;
          const body = f === 'keep' ? { upcoming_skip: !inp.checked } : { [f]: inp.value };
          try {
            Object.assign(r, await put(`/contributors/${r.id}/next`, body));
            if (f === 'keep') { nextYear(); return; }
            toast('Saved');
          } catch (ex) { toast(ex.message, true); inp.value = r[f] ?? ''; }
        };
      });
    });
  };
  $('#q').oninput = draw;
  $('#show').onchange = draw;
  draw();

  $$('[data-apply]').forEach(b => { b.onclick = async () => {
    const id = Number(b.dataset.apply);
    try { await post('/contributors/next/bulk', { changes: [{ id, ...sugg.get(id).change }] }); nextYear(); } catch (ex) { toast(ex.message, true); }
  }; });
  $('#apply-all')?.addEventListener('click', async () => {
    try { const r = await post('/contributors/next/bulk', { changes: strong.map(([id, s]) => ({ id, ...s.change })) }); toast(`${r.count} updated`); nextYear(); }
    catch (ex) { toast(ex.message, true); }
  });
  $('#renumber').onclick = async () => {
    if (numbered.length && !(await confirmBox(`Replace the ${numbered.length} next-year numbers already filled in?`, { ok: 'Replace' }))) return;
    try { const r = await post('/contributors/renumber', { mode: $('#f-mode').value, start: $('#f-start').value }); toast(`${r.count} numbered`); nextYear(); }
    catch (ex) { toast(ex.message, true); }
  };
  $('#add-new').onclick = () => contributorModal({ uses_envelopes: true }, null, () => nextYear());
  $('#vendor').onclick = () => {
    const list = rows.filter(r => !r.upcoming_skip && r.upcoming_envelope_no).sort((a, b) => a.upcoming_envelope_no - b.upcoming_envelope_no);
    saveFile(`envelopes-next-year-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(list.map(r => ({
      envelope: r.upcoming_envelope_no, name: labelName(r), address: r.address[0] || '', address2: r.address[1] || '',
      city: r.city || '', state: r.state || '', zip: r.zip || '', last_year_envelope: r.envelope_no ?? '',
    }))));
  };
}

// ---------- Printable box labels (Avery sheets) ----------
const SHEETS = {
  5160: { name: 'Avery 5160 / 8160 — 30 per sheet (1" × 2⅝")', cols: 3, rows: 10, w: 2.625, h: 1, top: 0.5, left: 0.1875, gapX: 0.125, gapY: 0 },
  5163: { name: 'Avery 5163 / 8163 — 10 per sheet (2" × 4")', cols: 2, rows: 5, w: 4, h: 2, top: 0.5, left: 0.15625, gapX: 0.1875, gapY: 0 },
};

export async function labels() {
  const v = $('#view');
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  const sheetKey = SHEETS[p.get('sheet')] ? p.get('sheet') : (cache.get('labelSheet') || '5160');
  const sheet = SHEETS[sheetKey];
  const skip = Math.max(0, Math.min(sheet.cols * sheet.rows - 1, Number(p.get('skip')) || 0));
  const withAddress = p.get('address') !== '0';
  const source = p.get('numbers') === 'current' ? 'current' : 'next';
  const data = await get('/contributors/next-year');
  const list = source === 'next'
    ? data.rows.filter(r => !r.upcoming_skip && r.upcoming_envelope_no).map(r => ({ ...r, no: r.upcoming_envelope_no, label: labelName(r) }))
    : data.rows.filter(r => r.active && r.envelope_no && r.uses_envelopes).map(r => ({ ...r, no: r.envelope_no, label: r.display_name }));
  list.sort((a, b) => a.no - b.no);
  const missing = source === 'next' ? data.rows.filter(r => !r.upcoming_skip && r.active && !r.upcoming_envelope_no && !r.is_other_giver).length : 0;

  // Page geometry for printing on label stock: no browser margins.
  let style = document.getElementById('page-style');
  if (!style) { style = document.createElement('style'); style.id = 'page-style'; document.head.appendChild(style); }
  style.textContent = `@media print { @page { size: letter; margin: 0; } .label-sheet { border: 0 !important; margin: 0 !important; box-shadow: none !important; } }
    .label-sheet { position: relative; width: 8.5in; height: 11in; background: #fff; color: #111; margin: 0 auto 1rem; border: 1px solid var(--line); break-after: page; page-break-after: always; overflow: hidden; }
    .label-sheet:last-child { break-after: auto; page-break-after: auto; }
    .lbl { position: absolute; box-sizing: border-box; padding: .08in .14in; overflow: hidden; font-family: system-ui, -apple-system, Arial, sans-serif; line-height: 1.2; }
    .lbl .no { float: right; font-weight: 800; font-size: ${sheet.h >= 2 ? 22 : 15}pt; margin-left: .08in; line-height: 1; }
    .lbl .nm { font-weight: 700; font-size: ${sheet.h >= 2 ? 13 : 9.5}pt; }
    .lbl .ad { font-size: ${sheet.h >= 2 ? 11 : 8}pt; }
    @media screen { .lbl { outline: 1px dashed #ccc; } }`;

  const per = sheet.cols * sheet.rows;
  const cells = [...Array(skip).fill(null), ...list];
  const sheets = [];
  for (let i = 0; i < cells.length; i += per) sheets.push(cells.slice(i, i + per));
  const pos = i => {
    const c = i % sheet.cols, r = Math.floor(i / sheet.cols);
    return `left:${sheet.left + c * (sheet.w + sheet.gapX)}in;top:${sheet.top + r * (sheet.h + sheet.gapY)}in;width:${sheet.w}in;height:${sheet.h}in`;
  };

  v.innerHTML = html`
    <a class="back noprint" href="#/nextyear">← Next year's envelopes</a>
    <div class="pagehead noprint"><h1>Box labels</h1></div>
    <form class="panel noprint" id="lf">
      <div class="fields">
        ${selectField('Numbers', 'numbers', [['next', "Next year's plan"], ['current', "This year's (current) numbers"]], source)}
        ${selectField('Label sheet', 'sheet', Object.entries(SHEETS).map(([k, s]) => [k, s.name]), sheetKey)}
        ${field('Skip labels already used on the first sheet', 'skip', String(skip), 'inputmode="numeric"')}
      </div>
      <label class="check"><input type="checkbox" name="address" ${withAddress ? raw('checked') : ''}> Include mailing address</label>
      <div class="row"><button class="primary" type="button" id="prt" ${list.length ? '' : raw('disabled')}>Print ${list.length} labels</button><button type="submit">Update preview</button></div>
      ${missing ? html`<p class="small" style="margin-top:.6rem">${missing} giver${missing === 1 ? ' has' : 's have'} no next-year number yet and won't print. <a href="#/nextyear?show=missing">Fix that</a></p>` : ''}
      <p class="small muted" style="margin-top:.4rem">In the print window, choose <strong>Actual size / 100%</strong> (not "Fit to page") and no headers or footers.</p>
    </form>
    ${list.length ? '' : html`<div class="panel"><p class="empty">${source === 'next' ? html`Nobody has a next-year number yet. <a href="#/nextyear">Fill in next year's numbers</a> first.` : 'No active envelopes have a number.'}</p></div>`}
    <div class="tablewrap">${sheets.map(cs => html`<div class="label-sheet">${cs.map((r, i) => r ? html`<div class="lbl" style="${pos(i)}">
      <div class="no">${r.no}</div><div class="nm">${r.label}</div>
      ${withAddress ? html`<div class="ad">${r.address.map(a => html`${a}<br>`)}${r.city_line}</div>` : ''}</div>` : '')}</div>`)}</div>`;

  $('#prt').onclick = () => window.print();
  $('#lf').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    cache.set('labelSheet', f.sheet.value);
    go(`labels?numbers=${f.numbers.value}&sheet=${f.sheet.value}&skip=${Number(f.skip.value) || 0}&address=${f.address.checked ? 1 : 0}`);
  };
}
