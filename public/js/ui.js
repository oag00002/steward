// Small DOM + formatting helpers shared by all views.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, c => ESC[c]));

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(s);

// Tagged template that escapes interpolations; arrays are joined; raw() passes through.
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (Array.isArray(v)) out += v.map(x => (x instanceof Raw ? x.s : esc(x))).join('');
    else if (v instanceof Raw) out += v.s;
    else if (v === false || v === null || v === undefined) out += '';
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function money(cents, { blankZero = false } = {}) {
  if (cents === null || cents === undefined) return '';
  if (blankZero && !cents) return '';
  const n = Number(cents) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// "20" -> 2000; "20.5" -> 2050; "$1,234.5" -> 123450; invalid -> null
export function toCents(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[$,\s]/g, '');
  if (!t || !/^-?\d*(\.\d{0,2})?$/.test(t) || t === '.' || t === '-') return null;
  const neg = t.startsWith('-');
  const [w, f = ''] = t.replace('-', '').split('.');
  const c = Number(w || 0) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -c : c;
}
export const centsToInput = c => (c === null || c === undefined ? '' : (c / 100).toFixed(2));

export function fmtDate(d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', opts);
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Most recent Sunday (today if Sunday) — the usual offering date.
export function lastSunday() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let toastTimer;
export function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 4500 : 2200);
}

// Modal: content is html; returns { el, close }. onMount receives the modal element.
export function modal(content, onMount) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${content}</div>`;
  document.body.appendChild(back);
  const prevFocus = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  const el = back.firstElementChild;
  onMount?.(el, close);
  setTimeout(() => (el.querySelector('[autofocus]') || el.querySelector('input,select,textarea,button'))?.focus(), 30);
  return { el, close };
}

export function confirmBox(message, { ok = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    modal(`<p>${esc(message)}</p><div class="actions"><button data-x>Cancel</button><button data-ok class="${danger ? 'danger solid' : 'primary'}">${esc(ok)}</button></div>`,
      (el, close) => {
        el.querySelector('[data-x]').onclick = () => { close(); resolve(false); };
        el.querySelector('[data-ok]').onclick = () => { close(); resolve(true); };
      });
  });
}

// Read a form into an object. Checkboxes -> booleans.
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else out[el.name] = el.value;
  }
  return out;
}

export function field(label, name, value = '', attrs = '') {
  return html`<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${value ?? ''}" ${raw(attrs)}></div>`;
}
export function selectField(label, name, options, value, attrs = '') {
  return html`<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}" ${raw(attrs)}>${options.map(([v, t]) =>
    html`<option value="${v}" ${String(v) === String(value ?? '') ? raw('selected') : ''}>${t}</option>`)}</select></div>`;
}
export function checkField(label, name, checked) {
  return html`<label class="check"><input type="checkbox" name="${name}" ${checked ? raw('checked') : ''}> ${label}</label>`;
}

export function downloadLink(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
