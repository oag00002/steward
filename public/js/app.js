// App shell: sign-in, navigation, routing.
import { html, raw, esc, $, money, fmtDate, toast, lastSunday } from './ui.js';
import { get, post, outbox, flush, net, cache } from './api.js';
import * as offerings from './offerings.js';
import * as people from './people.js';
import * as attendance from './attendance.js';
import * as reports from './reports.js';
import * as admin from './admin.js';

export const state = { user: null, settings: {}, setup: null };
export const isFinance = () => state.user && state.user.role !== 'counter';
export const isAdmin = () => state.user?.role === 'admin';

const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  offering: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 7l9 6 9-6"/>',
  attendance: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.6c2.6.2 4.4 1.8 5 4.6"/>',
  envelopes: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
};
const icon = n => raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`);

function navItems() {
  const items = [
    ['', 'Home', 'home'],
    ['offerings', 'Offerings', 'offering'],
    ['attendance', 'Attendance', 'attendance'],
  ];
  if (isFinance()) items.push(['people', 'People', 'people'], ['envelopes', 'Envelopes', 'envelopes'], ['reports', 'Reports', 'reports']);
  items.push(['settings', 'Settings', 'settings']);
  return items;
}

const ROUTES = [
  [/^$/, () => home()],
  [/^offerings$/, () => offerings.list()],
  [/^batch\/(\d+)$/, m => offerings.batch(m[1])],
  [/^attendance$/, () => attendance.start()],
  [/^attendance\/(\d+)$/, m => attendance.session(m[1])],
  [/^people$/, () => people.list()],
  [/^household\/(new|\d+)$/, m => people.household(m[1])],
  [/^envelopes$/, () => people.envelopes()],
  [/^envelope\/(\d+)$/, m => people.envelope(m[1])],
  [/^reports$/, () => reports.index()],
  [/^statements$/, () => reports.statements()],
  [/^report\/(funds|contributors|attendance|directory)$/, m => reports.report(m[1])],
  [/^settings$/, () => admin.settings()],
  [/^import$/, () => admin.importPage()],
  [/^yearend$/, () => admin.yearEnd()],
  [/^more$/, () => more()],
];

const route = () => location.hash.replace(/^#\/?/, '').split('?')[0];
export const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
export const go = path => { location.hash = '#/' + path; };

function shell() {
  const r = route();
  const top = r.split('/')[0];
  const current = { batch: 'offerings', household: 'people', envelope: 'envelopes', statements: 'reports', report: 'reports', import: 'settings', yearend: 'settings' }[top] ?? top;
  const items = navItems();
  const bottom = isFinance()
    ? [items[0], items[1], items[2], items[3], ['more', 'More', 'more']]
    : items;
  const link = ([path, label, ic], cls = '') => html`<a href="#/${path}" class="${cls}" ${current === path || (path === 'more' && ['envelopes', 'reports', 'settings'].includes(current)) ? raw('aria-current="page"') : ''}>${icon(ic)}<span>${label}</span></a>`;
  return html`
    <header class="topbar">
      <a class="brand" href="#/">${state.settings.church_name || 'Steward'}</a>
      <span class="sync" id="sync" hidden></span>
      <span class="who noprint">${state.user.full_name || state.user.username}</span>
    </header>
    <div class="shell">
      <nav class="nav sidenav" aria-label="Main">${items.map(i => link(i))}</nav>
      <main id="view"></main>
    </div>
    <nav class="nav bottomnav" aria-label="Main">${bottom.map(i => link(i))}</nav>`;
}

export function updateSync() {
  const el = $('#sync');
  if (!el) return;
  const pending = outbox.pendingCount();
  const failed = outbox.all().filter(x => x.status === 'failed').length;
  if (!net.online) { el.hidden = false; el.className = 'sync offline'; el.textContent = pending ? `Offline · ${pending} saved on this phone` : 'Offline'; }
  else if (pending) { el.hidden = false; el.className = 'sync pending'; el.textContent = `Sending ${pending}…`; }
  else if (failed) { el.hidden = false; el.className = 'sync offline'; el.textContent = `${failed} need fixing`; }
  else el.hidden = true;
}
window.addEventListener('steward:outbox', updateSync);
window.addEventListener('steward:signedout', () => { if (state.user) { state.user = null; render(); } });

export async function render() {
  const app = $('#app');
  if (!state.user) return state.setup ? setupView(app) : loginView(app);
  app.innerHTML = shell();
  updateSync();
  const view = $('#view');
  const r = route();
  const hit = ROUTES.find(([re]) => re.test(r));
  if (!hit) { view.innerHTML = html`<p>That page does not exist. <a href="#/">Go home</a></p>`; return; }
  try {
    await hit[1](r.match(hit[0]));
  } catch (e) {
    view.innerHTML = html`<div class="error-box">${e.message}</div><p><a href="#/">Go home</a></p>`;
  }
  window.scrollTo(0, 0);
}

// First visit to a brand-new site: create the administrator, protected by the SETUP_CODE secret.
function setupView(app) {
  app.innerHTML = html`
    <div class="login">
      <form class="envelope" id="setup">
        <h1>Set up Steward</h1>
        ${state.setup.codeSet ? html`<p class="small">Create the first administrator sign-in. You'll need the setup code you entered when you deployed to Cloudflare.</p>`
          : html`<div class="error-box">This site doesn't have a setup code yet. In the Cloudflare dashboard open <strong>Workers &amp; Pages → steward → Settings → Variables and Secrets</strong>, add a secret named <strong>SETUP_CODE</strong> (8+ characters), then reload this page.</div>`}
        <div class="field"><label for="sc">Setup code</label><input id="sc" type="password" autocomplete="off" required></div>
        <div class="field"><label for="fn">Your name</label><input id="fn" autocomplete="name"></div>
        <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" autocapitalize="none" required></div>
        <div class="field"><label for="p">Password (10+ characters)</label><input id="p" type="password" autocomplete="new-password" minlength="10" required></div>
        <div class="error-box" id="err" hidden></div>
        <button class="add primary" type="submit">Create administrator</button>
      </form>
    </div>`;
  $('#sc').focus();
  $('#setup').onsubmit = async e => {
    e.preventDefault();
    const err = $('#err');
    err.hidden = true;
    try {
      const { user } = await post('/auth/setup', { setup_code: $('#sc').value, full_name: $('#fn').value, username: $('#u').value, password: $('#p').value });
      state.user = user;
      state.setup = null;
      cache.set('user', user);
      await loadSettings();
      location.hash = '#/settings';
      render();
      toast('Welcome. Start by entering your church name and address.');
    } catch (ex) {
      if (ex.status === 409) { state.setup = null; render(); return; }
      err.textContent = ex.message; err.hidden = false;
    }
  };
}

function loginView(app) {
  app.innerHTML = html`
    <div class="login">
      <form class="envelope" id="login">
        <h1>${state.settings.church_name || 'Steward'}</h1>
        <p class="small">Sign in to enter offerings and attendance.</p>
        <div class="field"><label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" required></div>
        <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
        <div class="error-box" id="err" hidden></div>
        <button class="add primary" type="submit">Sign in</button>
      </form>
    </div>`;
  $('#u').focus();
  $('#login').onsubmit = async e => {
    e.preventDefault();
    const err = $('#err');
    err.hidden = true;
    try {
      const { user } = await post('/auth/login', { username: $('#u').value, password: $('#p').value });
      state.user = user;
      cache.set('user', user);
      await loadSettings();
      render();
      flush();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

export async function loadSettings() {
  try { state.settings = await get('/settings'); cache.set('settings', state.settings); }
  catch { state.settings = cache.get('settings') || {}; }
}

async function home() {
  const v = $('#view');
  const d = await get('/dashboard');
  const max = Math.max(1, ...(d.recent || []).map(x => x.total_cents));
  v.innerHTML = html`
    <div class="pagehead"><h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}</h1>
      <button class="primary" id="start">Count an offering</button></div>
    ${d.open_batches.length ? html`
      <div class="panel flush"><h2 style="padding:1rem 1rem 0">Offerings in progress</h2>
        <ul class="list">${d.open_batches.map(b => html`
          <li><a class="item" href="#/batch/${b.id}"><span class="spacer"><strong>${fmtDate(b.batch_date)}</strong> ${b.description ? html`<span class="muted">${b.description}</span>` : ''}<br>
            <span class="small muted">${b.line_count} ${b.line_count === 1 ? "entry" : "entries"}</span></span><span class="money"><strong>${money(b.total_cents)}</strong></span></a></li>`)}</ul></div>` : ''}
    ${isFinance() ? html`
      <div class="stats">
        <div class="stat"><div class="v">${money(d.ytd_cents)}</div><div class="l">Posted giving in ${new Date().getFullYear()}</div></div>
        <div class="stat"><div class="v">${(d.members.find(m => m.status === 'member') || { n: 0 }).n}</div><div class="l">Members</div></div>
        <div class="stat"><div class="v">${d.attendance[0]?.n ?? '—'}</div><div class="l">${d.attendance[0] ? `${d.attendance[0].name}, ${fmtDate(d.attendance[0].session_date, { month: 'short', day: 'numeric' })}` : 'Attendance'}</div></div>
      </div>
      ${d.recent.length ? html`<div class="panel"><h3>Last ${d.recent.length} offerings</h3>
        <div class="bars" role="img" aria-label="Recent offering totals">${d.recent.map(x => html`<div style="height:${Math.round((x.total_cents / max) * 100)}%" title="${fmtDate(x.batch_date)}: ${money(x.total_cents)}"></div>`)}</div>
        <div class="row small muted" style="margin-top:.3rem"><span>${fmtDate(d.recent[0].batch_date)}</span><span class="spacer"></span><span>${fmtDate(d.recent.at(-1).batch_date)} · ${money(d.recent.at(-1).total_cents)}</span></div></div>` : ''}
    ` : ''}`;
  $('#start').onclick = () => offerings.newBatch(lastSunday());
}

function more() {
  $('#view').innerHTML = html`<h1>More</h1>
    <div class="panel flush"><ul class="list">
      <li><a class="item" href="#/envelopes">${icon('envelopes')} Envelopes and givers</a></li>
      <li><a class="item" href="#/reports">${icon('reports')} Reports and year-end statements</a></li>
      <li><a class="item" href="#/settings">${icon('settings')} Settings, funds, users</a></li>
    </ul></div>`;
  $$('#view svg').forEach(s => { s.style.width = '22px'; s.style.height = '22px'; s.style.fill = 'none'; s.style.stroke = 'currentColor'; s.style.strokeWidth = '1.8'; });
}
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

window.addEventListener('hashchange', render);

(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  state.settings = cache.get('settings') || {};
  try {
    const me = await get('/auth/me');
    const user = me.user;
    state.user = user;
    state.setup = me.needs_setup ? { codeSet: me.setup_code_set } : null;
    if (user) cache.set('user', user);
    await loadSettings();
  } catch (e) {
    // Offline at start: trust the last signed-in user so counting can continue; the server re-checks on sync.
    if (e.status === 0) state.user = cache.get('user');
  }
  render();
  flush();
})();

export { toast, esc };
