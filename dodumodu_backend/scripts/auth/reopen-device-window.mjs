// scripts/auth/reopen-device-window.mjs — operator break-glass only (spec §5.4/§5.10).
// Use when an admin has NO usable device and no other admin can invite. Reopens
// the first-device window, revokes that admin's existing devices and ends their
// sessions. Audited. The next full login claims the window and registers a new
// device. Dev branch only.
//
//   DATABASE_URL=... node scripts/auth/reopen-device-window.mjs admin@example.com [window_hours]
import { Client } from "pg";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) { console.error("usage: node scripts/auth/reopen-device-window.mjs <email> [hours]"); process.exit(2); }
const hours = Number(process.argv[3] ?? 72);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(2); }

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  await c.query("begin");
  // Serialize against concurrent device operations for this admin.
  const u = await c.query(
    `update aa_users set device_window_until = now() + make_interval(hours => $2::int),
                         session_version = session_version + 1
      where email = $1 and role = 'admin'
      returning id::text AS id`,
    [email, hours],
  );
  if (!u.rows[0]) { await c.query("rollback"); console.error(`no admin with email ${email}`); process.exit(1); }
  const id = u.rows[0].id;
  const revoked = await c.query(
    `update aa_admin_devices set status = 'revoked', revoked_at = now()
      where user_id = $1 and status <> 'revoked' returning id`,
    [id],
  );
  const sessions = await c.query("delete from aa_sessions where user_id = $1", [id]);
  await c.query(
    `insert into aa_audit_events (actor_id, target_id, event, meta)
     values (NULL, $1, 'device_window_reopened', $2::jsonb)`,
    [id, JSON.stringify({ devices_revoked: revoked.rowCount, sessions_ended: sessions.rowCount, window_hours: hours })],
  );
  await c.query("commit");
  console.log(`reopened device window for ${email}: ${revoked.rowCount} device(s) revoked, ` +
    `${sessions.rowCount} session(s) ended, window open ${hours}h.`);
} catch (e) {
  await c.query("rollback");
  throw e;
} finally {
  await c.end();
}
