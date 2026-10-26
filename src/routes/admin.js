// Users, church settings, activity log.
import { bad, notFound, blank, all, first, run, stmt, batch, isUnique, audit } from '../lib.js';
import { hashPassword } from '../password.js';

const ROLES = ['admin', 'finance', 'counter'];
const SETTING_KEYS = ['church_name', 'church_address1', 'church_address2', 'church_city_line', 'church_phone', 'church_ein',
  'statement_message', 'signer_name', 'signer_title'];

export default function (r) {
  r.get('/api/settings', 'counter', async c =>
    Object.fromEntries((await all(c.db, 'SELECT key, value FROM settings')).map(x => [x.key, x.value])));

  r.put('/api/settings', 'finance', async c => {
    const body = await c.body();
    const keys = SETTING_KEYS.filter(k => k in body);
    if (keys.length) {
      await batch(c.db, keys.map(k => stmt(c.db, 'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', k, blank(body[k]))));
    }
    await audit(c, 'settings_update', keys.join(','));
    return { ok: true };
  });

  r.get('/api/users', 'admin', c => all(c.db, 'SELECT id, username, full_name, role, active, created_at FROM users ORDER BY username'));

  r.post('/api/users', 'admin', async c => {
    const body = await c.body();
    const username = blank(body.username)?.toLowerCase();
    const password = String(body.password || '');
    if (!username || !/^[a-z0-9._@-]{2,60}$/.test(username)) throw bad('Usernames use letters, numbers, dots, dashes or underscores.');
    if (password.length < 10) throw bad('Passwords must be at least 10 characters.');
    if (!ROLES.includes(body.role)) throw bad('Choose a role.');
    try {
      const m = await run(c.db, 'INSERT INTO users (username, full_name, password_hash, role) VALUES (?,?,?,?)',
        username, blank(body.full_name), await hashPassword(password), body.role);
      await audit(c, 'user_create', `${username} (${body.role})`);
      return first(c.db, 'SELECT id, username, full_name, role, active FROM users WHERE id = ?', m.last_row_id);
    } catch (e) {
      if (isUnique(e)) throw bad('That username is taken.');
      throw e;
    }
  });

  r.put('/api/users/:id', 'admin', async c => {
    const body = await c.body();
    const u = await first(c.db, 'SELECT * FROM users WHERE id = ?', c.params.id);
    if (!u) throw notFound('User');
    const role = ROLES.includes(body.role) ? body.role : u.role;
    const active = body.active !== false;
    if (u.id === c.user.id && (role !== 'admin' || !active)) throw bad('You cannot remove your own admin access.');
    if (body.password && String(body.password).length < 10) throw bad('Passwords must be at least 10 characters.');
    const statements = [stmt(c.db, 'UPDATE users SET full_name=?, role=?, active=? WHERE id=?', blank(body.full_name), role, active, u.id)];
    if (body.password) statements.push(stmt(c.db, 'UPDATE users SET password_hash=? WHERE id=?', await hashPassword(String(body.password)), u.id));
    // A reset password or a disabled account signs that person out everywhere.
    if (body.password || !active) statements.push(stmt(c.db, 'DELETE FROM sessions WHERE user_id = ?', u.id));
    await batch(c.db, statements);
    await audit(c, 'user_update', `${u.username} role=${role} active=${active}${body.password ? ' password reset' : ''}`);
    return { ok: true };
  });

  r.get('/api/audit', 'admin', c => all(c.db, `SELECT a.id, a.action, a.detail, a.at, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT 300`));
}
