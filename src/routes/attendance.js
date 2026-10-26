// Events and attendance.
import { bad, notFound, blank, dateOrNull, intOrNull, all, first, run, audit } from '../lib.js';

export default function (r) {
  r.get('/api/events', 'counter', c => all(c.db, 'SELECT * FROM events ORDER BY active DESC, name'));

  const saveEvent = async (c, id) => {
    const body = await c.body();
    const name = blank(body.name);
    if (!name) throw bad('Give the event a name.');
    if (id) {
      const m = await run(c.db, 'UPDATE events SET name=?, attendance_type=?, active=? WHERE id=?', name, blank(body.attendance_type), body.active !== false, id);
      if (!m.changes) throw notFound('Event');
    } else {
      id = (await run(c.db, 'INSERT INTO events (name, attendance_type, active) VALUES (?,?,?)', name, blank(body.attendance_type), body.active !== false)).last_row_id;
    }
    await audit(c, 'event_save', name);
    return first(c.db, 'SELECT * FROM events WHERE id = ?', id);
  };
  r.post('/api/events', 'finance', c => saveEvent(c, null));
  r.put('/api/events/:id', 'finance', c => saveEvent(c, c.params.id));

  r.get('/api/attendance/sessions', 'counter', async c => {
    const ev = intOrNull(c.query.get('event_id'));
    return all(c.db, `
      SELECT s.*, e.name AS event_name, e.attendance_type,
        (SELECT count(*) FROM attendance_records ar WHERE ar.session_id = s.id) AS recorded
      FROM attendance_sessions s JOIN events e ON e.id = s.event_id
      ${ev ? 'WHERE s.event_id = ?' : ''}
      ORDER BY s.session_date DESC, e.name LIMIT 200`, ...(ev ? [ev] : []));
  });

  // Open (or create) the session for an event on a date.
  r.post('/api/attendance/sessions', 'counter', async c => {
    const body = await c.body();
    const ev = intOrNull(body.event_id);
    const date = dateOrNull(body.session_date);
    if (!ev || !date) throw bad('Choose an event and a date.');
    if (!(await first(c.db, 'SELECT id FROM events WHERE id = ?', ev))) throw bad('That event does not exist.');
    await run(c.db, 'INSERT INTO attendance_sessions (event_id, session_date) VALUES (?,?) ON CONFLICT (event_id, session_date) DO NOTHING', ev, date);
    return first(c.db, 'SELECT * FROM attendance_sessions WHERE event_id = ? AND session_date = ?', ev, date);
  });

  r.get('/api/attendance/sessions/:id', 'counter', async c => {
    const s = await first(c.db, 'SELECT s.*, e.name AS event_name FROM attendance_sessions s JOIN events e ON e.id = s.event_id WHERE s.id = ?', c.params.id);
    if (!s) throw notFound('Attendance record');
    const present = (await all(c.db, 'SELECT person_id FROM attendance_records WHERE session_id = ?', c.params.id)).map(x => x.person_id);
    return { ...s, present };
  });

  r.put('/api/attendance/sessions/:id', 'counter', async c => {
    const body = await c.body();
    const m = await run(c.db, 'UPDATE attendance_sessions SET headcount=?, notes=? WHERE id=?', intOrNull(body.headcount), blank(body.notes), c.params.id);
    if (!m.changes) throw notFound('Attendance record');
    return first(c.db, 'SELECT * FROM attendance_sessions WHERE id = ?', c.params.id);
  });

  r.delete('/api/attendance/sessions/:id', 'finance', async c => {
    await run(c.db, 'DELETE FROM attendance_sessions WHERE id = ?', c.params.id);
    await audit(c, 'attendance_delete', c.params.id);
    return { ok: true };
  });

  // Mark people present/absent. Body: { person_ids: [..], present: true|false }
  r.post('/api/attendance/sessions/:id/mark', 'counter', async c => {
    const body = await c.body();
    const ids = (body.person_ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!ids.length) throw bad('No people selected.');
    if (!(await first(c.db, 'SELECT id FROM attendance_sessions WHERE id = ?', c.params.id))) throw notFound('Attendance record');
    if (body.present === false) {
      await run(c.db, 'DELETE FROM attendance_records WHERE session_id = ? AND person_id IN (SELECT value FROM json_each(?))', c.params.id, JSON.stringify(ids));
    } else {
      await run(c.db, `INSERT INTO attendance_records (session_id, person_id)
        SELECT ?, p.id FROM people p WHERE p.id IN (SELECT value FROM json_each(?)) ON CONFLICT DO NOTHING`, c.params.id, JSON.stringify(ids));
    }
    return { ok: true };
  });
}
