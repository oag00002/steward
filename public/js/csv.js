// Spreadsheet helpers that run in the browser, so the server stays inside Cloudflare's
// free-plan CPU budget: CSV parsing for imports, CSV building for exports, file downloads.
import { get } from './api.js';

// RFC-4180 CSV parser (quotes, embedded commas/newlines). First row = headers.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  text = String(text).replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(v => v.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map(h => h.trim());
  return nonEmpty.slice(1).map(r => Object.fromEntries(header.map((h, j) => [h, (r[j] ?? '').trim()])));
}

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9#]/g, '');

// Column names we recognise, so exports from Shepherd's Staff or Excel import without renaming.
const ALIASES = {
  household_id: ['householdid', 'familyid', 'hhid', 'householdnumber', 'familynumber', 'householdno', 'household#', 'family#'],
  household_name: ['household', 'householdname', 'familyname', 'family'],
  first_name: ['firstname', 'first', 'givenname'],
  last_name: ['lastname', 'last', 'surname'],
  relationship: ['relationship', 'role', 'position', 'familyposition'],
  spouse_first: ['spousefirstname', 'spousefirst', 'spouse', 'spousename'],
  spouse_last: ['spouselastname', 'spouselast'],
  address1: ['address', 'address1', 'street', 'streetaddress', 'addressline1', 'mailingaddress'],
  address2: ['address2', 'addressline2', 'apt', 'unit'],
  city: ['city', 'town'],
  state: ['state', 'st', 'province'],
  zip: ['zip', 'zipcode', 'postalcode', 'postcode'],
  phone: ['phone', 'homephone', 'phonenumber', 'telephone'],
  cell: ['cell', 'cellphone', 'mobile', 'mobilephone'],
  email: ['email', 'emailaddress'],
  envelope: ['envelope', 'envelopeno', 'envelopenumber', 'env', 'envno', 'envelope#', 'env#'],
  status: ['status', 'membershipstatus', 'memberstatus', 'membertype'],
  birth_date: ['birthdate', 'birthday', 'dob', 'dateofbirth'],
  date: ['date', 'offeringdate', 'batchdate', 'giftdate', 'contributiondate'],
  fund: ['fund', 'fundname', 'fundcode', 'fundnumber', 'category'],
  amount: ['amount', 'total', 'gift', 'contribution'],
  check_no: ['check', 'checkno', 'checknumber', 'check#'],
  memo: ['memo', 'note', 'notes', 'description'],
};
const LOOKUP = new Map();
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) LOOKUP.set(norm(n), field);

// Turn rows with the file's own headings into rows with our field names. Returns { rows, matched, ignored }.
export function canonicalRows(rows) {
  if (!rows.length) return { rows: [], matched: [], ignored: [] };
  const headerMap = {};
  const matched = [], ignored = [];
  for (const h of Object.keys(rows[0])) {
    const f = LOOKUP.get(norm(h));
    if (f && !Object.values(headerMap).includes(f)) { headerMap[h] = f; matched.push(`${h} → ${f.replace(/_/g, ' ')}`); }
    else ignored.push(h);
  }
  const out = rows.map(r => {
    const o = {};
    for (const [h, f] of Object.entries(headerMap)) if (r[h] !== '') o[f] = r[h];
    return o;
  });
  return { rows: out, matched, ignored };
}

export function toCsv(rows, columns) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // stop spreadsheets running formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

export function saveFile(name, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Fetch every page of an export as row objects.
export async function fetchExport(name) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await get(`/export/${name}?offset=${offset}`);
    for (const r of page.rows) out.push(Object.fromEntries(page.columns.map((c, i) => [c, r[i]])));
    if (page.next_offset == null) break;
    offset = page.next_offset;
  }
  return out;
}

export async function downloadExport(name) {
  const rows = await fetchExport(name);
  saveFile(`${name}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows));
  return rows.length;
}

export const BACKUP_TABLES = ['settings', 'households', 'people', 'funds', 'contributors', 'batches', 'offerings', 'events', 'attendance_sessions', 'attendance_records'];
export async function downloadBackup() {
  const out = { exported_at: new Date().toISOString(), app: 'steward', tables: {} };
  for (const t of BACKUP_TABLES) out.tables[t] = await fetchExport(`table/${t}`);
  saveFile(`steward-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(out), 'application/json');
}
