// Add a person who can sign in, or reset their password, directly in the database.
//   npm run create-user                    (asks for everything; uses the live database)
//   npm run create-user -- owen admin      (username and role up front)
//   npm run create-user -- owen admin --local   (the local test database used by `npm run dev`)
import { wrangler, ask } from './wrangler.mjs';
import { hashPassword } from '../src/password.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const local = process.argv.includes('--local');
let [username, role] = args;
username = (username || await ask('Username (e.g. owen): ')).toLowerCase();
if (!/^[a-z0-9._@-]{2,60}$/.test(username)) { console.error('Usernames use letters, numbers, dots, dashes or underscores.'); process.exit(1); }
role = role || (await ask('Access — admin, finance or counter [admin]: ')) || 'admin';
if (!['admin', 'finance', 'counter'].includes(role)) { console.error('Role must be admin, finance or counter.'); process.exit(1); }
const password = process.env.STEWARD_PASSWORD || await ask('Password (10+ characters): ', { hidden: true });
if (password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
const confirm = process.env.STEWARD_PASSWORD || await ask('Type it again: ', { hidden: true });
if (confirm !== password) { console.error('The passwords did not match.'); process.exit(1); }

const hash = await hashPassword(password);
// Username is restricted to [a-z0-9._@-] and the hash to base64 + '$', so neither can break out of the quotes.
const sql = `INSERT INTO users (username, full_name, password_hash, role) VALUES ('${username}', '${username}', '${hash}', '${role}')
  ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role, active = 1;
  DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = '${username}');`;
wrangler(['d1', 'execute', 'steward', local ? '--local' : '--remote', '--command', sql], { capture: true });
console.log(`\n"${username}" can now sign in with ${role} access${local ? ' (local test database)' : ''}.`);
