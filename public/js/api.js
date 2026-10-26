// Server calls, a small offline cache, and the offering outbox.
// Offering lines are written to the phone first (localStorage) and then sent to the
// server, so nothing typed during counting is lost if the signal drops.

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Steward': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'No connection to the server.');
  }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('steward:signedout'));
  if (!res.ok) throw new ApiError(res.status, (isJson && data.error) || `Request failed (${res.status})`);
  return data;
}
export const get = p => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = p => api('DELETE', p);

// ---------- cache ----------
const K = 'steward.';
export const cache = {
  get(k) { try { return JSON.parse(localStorage.getItem(K + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
  del(k) { try { localStorage.removeItem(K + k); } catch { /* ignore */ } },
};

// Fetch with fallback to the last good copy (for counting with poor signal).
export async function cachedGet(path, key) {
  try {
    const data = await get(path);
    cache.set(key, data);
    return data;
  } catch (e) {
    const c = cache.get(key);
    if (c && e.status === 0) return c;
    throw e;
  }
}

// ---------- outbox ----------
const OUT = 'outbox';
export const outbox = {
  all() { return cache.get(OUT) || []; },
  save(list) { cache.set(OUT, list); window.dispatchEvent(new CustomEvent('steward:outbox')); },
  add(item) { const l = this.all(); l.push({ ...item, status: 'pending' }); this.save(l); },
  remove(clientId) { this.save(this.all().filter(x => x.client_id !== clientId)); },
  update(clientId, patch) { this.save(this.all().map(x => (x.client_id === clientId ? { ...x, ...patch } : x))); },
  forBatch(id) { return this.all().filter(x => String(x.batch_id) === String(id)); },
  pendingCount() { return this.all().filter(x => x.status === 'pending').length; },
};

let flushing = false;
export const net = { online: navigator.onLine };

export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (const item of outbox.all()) {
      if (item.status !== 'pending') continue;
      try {
        await post(`/batches/${item.batch_id}/lines`, { ...item.payload, client_id: item.client_id });
        outbox.remove(item.client_id);
        setOnline(true);
      } catch (e) {
        if (e.status === 0) { setOnline(false); break; }
        if (e.status === 401) break;
        outbox.update(item.client_id, { status: 'failed', error: e.message });
      }
    }
  } finally {
    flushing = false;
    window.dispatchEvent(new CustomEvent('steward:flushed'));
  }
}

function setOnline(v) {
  if (net.online !== v) { net.online = v; window.dispatchEvent(new CustomEvent('steward:outbox')); }
}

window.addEventListener('online', () => { net.online = true; flush(); });
window.addEventListener('offline', () => setOnline(false));
setInterval(() => { if (outbox.pendingCount()) flush(); }, 6000);
