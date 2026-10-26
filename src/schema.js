// Database schema. The Worker applies any missing steps itself on first use, so a new
// Cloudflare account needs no command-line setup. To change the schema later, append a new
// entry to MIGRATIONS — never edit an entry that has already been deployed.
// Statements are separated by a semicolon at the end of a line.

export const MIGRATIONS = [
  // 1 — initial schema
  `
-- Steward schema (Cloudflare D1 / SQLite).
-- Money is stored in whole cents. Dates are 'YYYY-MM-DD' text. Booleans are 0/1.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','finance','counter')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,          -- unix seconds
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE login_failures (
  key TEXT PRIMARY KEY,                 -- username|ip
  first_at INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  mailing_name TEXT,
  address1 TEXT, address2 TEXT, city TEXT, state TEXT, zip TEXT,
  alt_address1 TEXT, alt_address2 TEXT, alt_city TEXT, alt_state TEXT, alt_zip TEXT,
  alt_begin TEXT, alt_end TEXT,
  phone TEXT, email TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  suffix TEXT,
  nickname TEXT,
  relationship TEXT,
  gender TEXT,
  birth_date TEXT,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'member',
  membership_code TEXT,
  received_by TEXT,
  date_received TEXT,
  baptism_date TEXT,
  confirmation_date TEXT,
  wedding_date TEXT,
  death_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX people_household_idx ON people(household_id);
CREATE INDEX people_name_idx ON people(last_name COLLATE NOCASE, first_name COLLATE NOCASE);

CREATE TABLE funds (
  id INTEGER PRIMARY KEY,
  code INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  deductible INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);

-- A contributor is one envelope: a person (optionally with a joint contributor in the same
-- household), or an "other giver" with their own name and address.
CREATE TABLE contributors (
  id INTEGER PRIMARY KEY,
  envelope_no INTEGER UNIQUE,
  upcoming_envelope_no INTEGER,
  prior_envelope_no INTEGER,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  joint_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  custom_name TEXT,
  other_name TEXT,
  other_address1 TEXT, other_address2 TEXT, other_city TEXT, other_state TEXT, other_zip TEXT,
  other_email TEXT,
  statement_method TEXT NOT NULL DEFAULT 'mail' CHECK (statement_method IN ('mail','email','none')),
  uses_envelopes INTEGER NOT NULL DEFAULT 1,
  skip_renumber INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  batch_date TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted')),
  counted_cash_cents INTEGER,
  counted_checks_cents INTEGER,
  deposit_date TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  posted_at TEXT
);
CREATE INDEX batches_date_idx ON batches(batch_date);

-- Offering lines. contributor_id NULL = loose offering (no statement).
CREATE TABLE offerings (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  contributor_id INTEGER REFERENCES contributors(id) ON DELETE RESTRICT,
  fund_id INTEGER NOT NULL REFERENCES funds(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  check_no TEXT,
  memo TEXT,
  client_id TEXT UNIQUE,                -- idempotency key from the phone's offline queue
  entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX offerings_batch_idx ON offerings(batch_id);
CREATE INDEX offerings_contrib_idx ON offerings(contributor_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  attendance_type TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE attendance_sessions (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  headcount INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (event_id, session_date)
);

CREATE TABLE attendance_records (
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, person_id)
);
CREATE INDEX attendance_person_idx ON attendance_records(person_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- One row per envelope with the name and address used on statements.
CREATE VIEW contributor_view AS
SELECT c.*,
  COALESCE(NULLIF(c.custom_name,''), NULLIF(c.other_name,''),
    CASE
      WHEN p.id IS NULL THEN '(unassigned)'
      WHEN j.id IS NULL THEN p.first_name || ' ' || p.last_name
      WHEN j.last_name = p.last_name THEN p.first_name || ' & ' || j.first_name || ' ' || p.last_name
      ELSE p.first_name || ' ' || p.last_name || ' & ' || j.first_name || ' ' || j.last_name
    END) AS display_name,
  COALESCE(p.last_name || ', ' || p.first_name, c.other_name, c.custom_name, '') AS sort_name,
  p.household_id,
  hh.name AS household_name,
  (p.id IS NULL) AS is_other_giver,
  (p.id IS NOT NULL AND hh.alt_address1 IS NOT NULL
    AND date('now') BETWEEN COALESCE(hh.alt_begin, date('now')) AND COALESCE(hh.alt_end, date('now'))) AS use_alt,
  CASE WHEN p.id IS NULL THEN c.other_address1 ELSE hh.address1 END AS home_address1,
  CASE WHEN p.id IS NULL THEN c.other_address2 ELSE hh.address2 END AS home_address2,
  CASE WHEN p.id IS NULL THEN c.other_city ELSE hh.city END AS home_city,
  CASE WHEN p.id IS NULL THEN c.other_state ELSE hh.state END AS home_state,
  CASE WHEN p.id IS NULL THEN c.other_zip ELSE hh.zip END AS home_zip,
  hh.alt_address1, hh.alt_address2, hh.alt_city, hh.alt_state, hh.alt_zip,
  COALESCE(NULLIF(c.other_email,''), NULLIF(p.email,''), NULLIF(hh.email,'')) AS mail_email
FROM contributors c
LEFT JOIN people p ON p.id = c.person_id
LEFT JOIN people j ON j.id = c.joint_person_id
LEFT JOIN households hh ON hh.id = p.household_id;

INSERT INTO funds (code, name, deductible) VALUES
  (1, 'General Offering', 1),
  (2, 'Building Fund', 1),
  (3, 'Missions', 1);

INSERT INTO events (name, attendance_type) VALUES ('Sunday Worship', 'Worship');

INSERT INTO settings (key, value) VALUES
  ('church_name', 'Our Church'),
  ('statement_message', 'Thank you for your faithful support of our ministry this year. No goods or services were provided in exchange for these contributions other than intangible religious benefits.'),
  ('signer_name', ''),
  ('signer_title', 'Financial Secretary');
`,
];

export const splitStatements = sql => sql.split(/;\s*\n/).map(s => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
