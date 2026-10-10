// scripts/auth/_seed_e2e.ts — one-shot E2E fixtures (NOT committed to prod).
// staff@example.com: phrase pre-enrolled (goes to 'phrase' stage).
// admin2@example.com: fresh admin, window open, NO phrase/NO totp
// (goes enroll_phrase -> totp_enroll, i.e. spec §10 case 2).
// Usage: $env:DATABASE_URL=...; npx tsx scripts/auth/_seed_e2e.ts
import { Client } from "pg";
import { hashPhrase } from "../../src/auth/argon2.js";

const STAFF_EMAIL = "staff@example.com";
const ADMIN_EMAIL = "admin2@example.com";
export const STAFF_PHRASE = "correct-horse-battery-staple-99";

const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  for (const email of [STAFF_EMAIL, ADMIN_EMAIL]) {
    await c.query("delete from aa_users where email = $1", [email]);
  }
  const staffHash = await hashPhrase(STAFF_PHRASE);
  await c.query(
    "insert into aa_users (email, role, is_active, phrase_hash) values ($1,'staff',true,$2)",
    [STAFF_EMAIL, staffHash],
  );
  await c.query(
    `insert into aa_users (email, role, is_active, device_window_until)
     values ($1,'admin',true, now() + interval '72 hours')`,
    [ADMIN_EMAIL],
  );
  const rows = await c.query(
    "select email, role, (phrase_hash is not null) as has_phrase, (totp_enabled_at is not null) as has_totp, (device_window_until > now()) as window_open from aa_users where email = any($1)",
    [[STAFF_EMAIL, ADMIN_EMAIL]],
  );
  console.log(JSON.stringify(rows.rows, null, 1));
} finally {
  await c.end();
}
