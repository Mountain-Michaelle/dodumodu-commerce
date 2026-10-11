// scripts/auth/bootstrap-admin.mjs — operator only (spec §5.10).
// Creates the FIRST admin and opens the 72h first-device window. Refuses if any
// admin already exists. Never run against production by this feature.
//
//   DATABASE_URL=... node scripts/auth/bootstrap-admin.mjs admin@example.com [window_hours]
import { Client } from "pg";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("usage: node scripts/auth/bootstrap-admin.mjs <email> [window_hours]");
  process.exit(2);
}
const windowHours = Number(process.argv[3] ?? 72);

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  // Refuse if any admin exists (bootstrap is one-shot).
  const existing = await c.query(
    "select count(*)::int AS n from aa_users where role = 'admin'",
  );
  if (existing.rows[0].n > 0) {
    console.error("refused: an admin already exists. Bootstrap is one-shot.");
    process.exit(1);
  }
  // Idempotent-ish: if this exact email exists as staff, promote it; else insert.
  const found = await c.query("select id from aa_users where email = $1", [email]);
  let id;
  if (found.rows[0]) {
    const up = await c.query(
      `update aa_users set role = 'admin',
         device_window_until = now() + make_interval(hours => $2::int)
       where id = $1 returning id::text AS id`,
      [found.rows[0].id, windowHours],
    );
    id = up.rows[0].id;
    console.log(`promoted existing user to admin: ${email}`);
  } else {
    const ins = await c.query(
      `insert into aa_users (email, role, device_window_until)
       values ($1, 'admin', now() + make_interval(hours => $2::int))
       returning id::text AS id`,
      [email, windowHours],
    );
    id = ins.rows[0].id;
    console.log(`created admin: ${email}`);
  }
  await c.query(
    `insert into aa_audit_events (actor_id, target_id, event, meta)
     values ($1, $1, 'admin_bootstrapped', $2::jsonb)`,
    [id, JSON.stringify({ window_hours: windowHours })],
  );
  console.log(`first-device window open for ${windowHours}h. The admin's first full`);
  console.log("login on any browser claims it and registers that device.");
} finally {
  await c.end();
}
