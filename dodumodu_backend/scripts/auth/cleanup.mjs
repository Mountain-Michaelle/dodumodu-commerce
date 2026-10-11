// scripts/auth/cleanup.mjs — batched janitor (spec §5.10). Wired to the
// scheduler that already exists (not a Cron Trigger). Deletes only expired/
// revoked rows, in batches, and never an active lock or session. Run repeatedly
// until each counter is 0.
//
//   DATABASE_URL=... node scripts/auth/cleanup.mjs [batch_limit]
import { Client } from "pg";

const BATCH = Number(process.argv[2] ?? 500);
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(2); }

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

// Each entry: [label, sql]. The SQL deletes a bounded batch and RETURNS the
// rows removed so we can loop. Ordering + LIMIT keep it cheap and safe.
const TASKS = [
  ["flows", `delete from aa_auth_flows where id in (
     select id from aa_auth_flows where expires_at < now() - interval '1 day'
     order by expires_at limit $1) returning 1`],
  ["sessions", `delete from aa_sessions where id_hash in (
     select id_hash from aa_sessions where absolute_expires_at < now()
     order by absolute_expires_at limit $1) returning 1`],
  ["challenges", `delete from aa_login_challenges where user_id in (
     select user_id from aa_login_challenges where expires_at < now() - interval '1 day'
     limit $1) returning 1`],
  ["throttle", `delete from aa_auth_throttle where key in (
     select key from aa_auth_throttle
      where last_fail_at < now() - interval '48 hours'
        and (locked_until is null or locked_until < now())
      limit $1) returning 1`],
  ["resets", `delete from aa_phrase_resets where token_hash in (
     select token_hash from aa_phrase_resets where expires_at < now() - interval '7 days'
     limit $1) returning 1`],
  ["devices", `delete from aa_admin_devices where id in (
     select id from aa_admin_devices
      where (status = 'revoked' and revoked_at < now() - interval '30 days')
         or (status = 'pending' and pending_until < now() - interval '1 day')
      limit $1) returning 1`],
  ["invites", `delete from aa_device_invites where token_hash in (
     select token_hash from aa_device_invites where expires_at < now() - interval '7 days'
     limit $1) returning 1`],
];

try {
  for (const [label, sql] of TASKS) {
    let total = 0;
    for (;;) {
      const r = await c.query(sql, [BATCH]);
      total += r.rowCount;
      if (r.rowCount < BATCH) break; // drained
    }
    if (total > 0) console.log(`  ${label}: ${total}`);
  }
  console.log("cleanup complete");
} finally {
  await c.end();
}
