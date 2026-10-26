// Attendance: pick an event and date, then tick off who was there.
import { html, raw, $, $$, fmtDate, toast, lastSunday, modal, confirmBox } from './ui.js';
import { get, post, put, del, cachedGet } from './api.js';
import { go, isFinance } from './app.js';

export async function start() {
  const v = $('#view');
  const [events, sessions] = await Promise.all([cachedGet('/events', 'events'), get('/attendance/sessions')]);
  const active = events.filter(e => e.active);
  v.innerHTML = html`
    <div class="pagehead"><h1>Attendance</h1>${isFinance() ? html`<button id="ev">Manage events</button>` : ''}</div>
    <form class="panel" id="f">
      <div class="fields">
        <div class="field"><label for="e">Event</label><select id="e">${active.map(e => html`<option value="${e.id}">${e.name}</option>`)}</select></div>
        <div class="field"><label for="d">Date</label><input id="d" type="date" value="${lastSunday()}"></div>
      </div>
      <button class="primary" type="submit" ${active.length ? '' : raw('disabled')}>Take attendance</button>
    </form>
    <div class="panel flush"><h2 style="padding:1rem 1rem 0">Recent</h2>
      ${sessions.length ? html`<ul class="list">${sessions.slice(0, 30).map(s => html`<li><a class="item" href="#/attendance/${s.id}">
        <span class="spacer"><strong>${s.event_name}</strong> <span class="muted">${fmtDate(s.session_date)}</span></span>
        <span class="small muted">${s.recorded} named${s.headcount ? ` · ${s.headcount} counted` : ''}</span></a></li>`)}</ul>`
        : html`<p class="empty">No attendance taken yet.</p>`}</div>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    try { const s = await post('/attendance/sessions', { event_id: $('#e').value, session_date: $('#d').value }); go(`attendance/${s.id}`); }
    catch (ex) { toast(ex.message, true); }
  };
  $('#ev')?.addEventListener('click', () => manageEvents(events));
}

function manageEvents(events) {
  modal(html`<h2>Events</h2>
    <ul class="list">${events.map(e => html`<li class="item"><span class="spacer">${e.name} <span class="small muted">${e.attendance_type || ''}${e.active ? '' : ' · inactive'}</span></span>
      <button type="button" data-t="${e.id}">${e.active ? 'Retire' : 'Restore'}</button></li>`)}</ul>
    <form style="margin-top:1rem"><div class="fields">
      <div class="field"><label for="n">New event</label><input id="n" placeholder="Wednesday Bible Study" required></div>
      <div class="field"><label for="t">Attendance type</label><input id="t" placeholder="Bible Study"></div></div>
      <div class="actions"><button type="button" data-x>Close</button><button class="primary" type="submit">Add event</button></div></form>`.toString(), (el, close) => {
    el.querySelector('[data-x]').onclick = () => { close(); start(); };
    $$('[data-t]', el).forEach(b => { b.onclick = async () => {
      const ev = events.find(x => String(x.id) === b.dataset.t);
      await put(`/events/${ev.id}`, { ...ev, active: !ev.active }); close(); start();
    }; });
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      try { await post('/events', { name: el.querySelector('#n').value, attendance_type: el.querySelector('#t').value }); close(); start(); }
      catch (ex) { toast(ex.message, true); }
    };
  });
}

export async function session(id) {
  const v = $('#view');
  const [s, people] = await Promise.all([get(`/attendance/sessions/${id}`), cachedGet('/people', 'people')]);
  const present = new Set(s.present);
  // Group by household
  const groups = new Map();
  for (const p of people) {
    if (!groups.has(p.household_id)) groups.set(p.household_id, { name: p.household_name, people: [] });
    groups.get(p.household_id).people.push(p);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  v.innerHTML = html`
    <a class="back" href="#/attendance">← Attendance</a>
    <div class="pagehead"><div><h1>${s.event_name}</h1><span class="muted">${fmtDate(s.session_date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span></div>
      ${isFinance() ? html`<button class="danger" id="delete">Delete</button>` : ''}</div>
    <div class="tally"><span class="big" id="cnt">${present.size}</span><span class="muted">named present</span>
      <span class="spacer"></span><label for="hc" style="margin:0">Head count</label><input id="hc" inputmode="numeric" style="width:6rem" value="${s.headcount ?? ''}"></div>
    <div class="field"><input id="q" type="search" placeholder="Find a name or household"></div>
    <div class="panel flush"><ul class="list att-list" id="ppl">
      ${ordered.length ? ordered.map(([hid, g]) => html`
        <li class="hh" data-h="${hid}"><div class="item">${g.name}<button type="button" data-all="${hid}">All here</button></div></li>
        ${g.people.map(p => html`<li data-p="${p.id}" data-s="${(p.first_name + ' ' + p.last_name + ' ' + (p.nickname || '') + ' ' + g.name).toLowerCase()}" data-hh="${hid}">
          <label><input type="checkbox" value="${p.id}" ${present.has(p.id) ? raw('checked') : ''}> ${p.nickname || p.first_name} ${p.last_name}
          ${p.status !== 'member' ? html`<span class="pill">${p.status}</span>` : ''}</label></li>`)}`)
        : html`<li class="empty">Add people under People first.</li>`}
    </ul></div>`;

  const mark = async (ids, on) => {
    try { await post(`/attendance/sessions/${id}/mark`, { person_ids: ids, present: on }); ids.forEach(i => (on ? present.add(i) : present.delete(i))); $('#cnt').textContent = present.size; }
    catch (ex) { toast(ex.message, true); ids.forEach(i => { const cb = $(`#ppl input[value="${i}"]`); if (cb) cb.checked = !on; }); }
  };
  $$('#ppl input[type=checkbox]').forEach(cb => { cb.onchange = () => mark([Number(cb.value)], cb.checked); });
  $$('[data-all]').forEach(b => { b.onclick = () => {
    const boxes = $$(`#ppl li[data-hh="${b.dataset.all}"] input`);
    const allOn = boxes.every(x => x.checked);
    boxes.forEach(x => { x.checked = !allOn; });
    mark(boxes.map(x => Number(x.value)), !allOn);
  }; });
  $('#q').oninput = e => {
    const t = e.target.value.trim().toLowerCase();
    const visibleHh = new Set();
    $$('#ppl li[data-p]').forEach(li => { const show = !t || li.dataset.s.includes(t); li.hidden = !show; if (show) visibleHh.add(li.dataset.hh); });
    $$('#ppl li[data-h]').forEach(li => { li.hidden = !visibleHh.has(li.dataset.h); });
  };
  $('#hc').onchange = async e => { try { await put(`/attendance/sessions/${id}`, { headcount: e.target.value, notes: s.notes }); toast('Head count saved'); } catch (ex) { toast(ex.message, true); } };
  $('#delete')?.addEventListener('click', async () => { if (!(await confirmBox('Delete this attendance record?', { ok: 'Delete', danger: true }))) return; await del(`/attendance/sessions/${id}`); go('attendance'); });
}
