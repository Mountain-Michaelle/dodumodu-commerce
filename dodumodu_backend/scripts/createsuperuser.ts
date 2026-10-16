// scripts/createsuperuser.ts — ONE-TIME first-admin bootstrap (spec §3).
//
//   npm run createsuperuser -- admin@example.com [--username=admin]
//
// Grammar: exactly one required positional <email> and at most one optional
// --username=<value> (default = email local-part). Extra positionals, unknown or
// duplicate flags, empty/malformed values and invalid emails all exit non-zero
// and create nothing.
//
// Runs ONLY if no superuser exists, enforced atomically: inside one transaction
// take pg_advisory_xact_lock(ADVISORY_KEY_ADMINS), then INSERT ... WHERE NOT
// EXISTS (a superuser). 0 rows inserted -> "Admin already exists. Aborting."
//
// NOT reachable over HTTP, NOT imported by the Hono app, sends no email, prints
// no secret. Preflight verifies flag/DB/keys/migration/email before inserting.
//
// Lockout-safe re-run (the only exception to "once"): if the sole superuser has
// never enrolled (no TOTP, never logged in, no session) AND the email matches,
// refresh the enroll + device windows (+72h) instead of aborting — otherwise a
// first admin who misses the 72h window is locked out forever.
import { Client } from "pg";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADVISORY_KEY_ADMINS } from "../src/auth/config.js";
import { parseSuperuserArgs } from "./auth/superuser.js";

const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(here, "..", "..", ".env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const ENROLL_HOURS = 72;
const die = (msg: string): never => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

// ---------------------------------------------------------------- preflight
function b64Key(env: Record<string, string | undefined>, name: string): Buffer | null {
  const raw = env[name];
  if (!raw) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return buf.length === 32 ? buf : null; // 256-bit keys only
}

function preflight(env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  if (env.ADMIN_AUTH_V2 !== "1") missing.push("ADMIN_AUTH_V2=1");
  const otp = b64Key(env, "OTP_KEY");
  const thr = b64Key(env, "THROTTLE_KEY");
  const totp = b64Key(env, "TOTP_ENC_KEY");
  if (!otp) missing.push("OTP_KEY (base64, 32 bytes)");
  if (!thr) missing.push("THROTTLE_KEY (base64, 32 bytes)");
  if (!totp) missing.push("TOTP_ENC_KEY (base64, 32 bytes)");
  if (otp && thr && totp) {
    const set = new Set([otp.toString("hex"), thr.toString("hex"), totp.toString("hex")]);
    if (set.size !== 3) missing.push("OTP_KEY/THROTTLE_KEY/TOTP_ENC_KEY must be DISTINCT");
  }
  // Email delivery: required in production; the dev test mailbox (ALLOW_TEST_IP)
  // reads the code in-memory, so Resend is not needed there.
  if (env.ALLOW_TEST_IP !== "1") {
    if (!env.RESEND_API_KEY) missing.push("RESEND_API_KEY (or set ALLOW_TEST_IP=1 for the dev mailbox)");
    if (!env.ADMIN_ALERT_EMAILS) missing.push("ADMIN_ALERT_EMAILS (comma-separated admin recipients)");
  }
  return missing;
}

// ---------------------------------------------------------------- main
let parsed: { email: string; username?: string };
try {
  parsed = parseSuperuserArgs(process.argv.slice(2));
} catch (e) {
  die((e as Error).message);
}
const { email, username } = parsed;
const env = process.env as Record<string, string | undefined>;

if (!env.DATABASE_URL) die("DATABASE_URL is not set (repository-root .env or environment).");
const missing = preflight(env);
if (missing.length) {
  console.error("\n  Preflight failed — the following are required before creating the first admin:");
  for (const m of missing) console.error(`    - ${m}`);
  console.error("\n  Nothing was created.\n");
  process.exit(1);
}

const c = new Client({ connectionString: env.DATABASE_URL });
await c.connect();
try {
  // Confirm migration 0019 is applied (the columns this insert relies on).
  const mig = await c.query("select 1 from schema_migrations where name = $1", ["0019_admin_auth_v2.sql"]);
  if (mig.rowCount === 0) die("Migration 0019_admin_auth_v2.sql is not applied. Run: npm run db:migrate");

  const uname = username ?? email.split("@")[0];
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_KEY_ADMINS]);

  const existing = await c.query(
    "select id, totp_secret_enc is not null as has_totp, last_login from aa_users where is_superuser");

  if (existing.rowCount === 0) {
    // No superuser at all -> create the first admin.
    await c.query(
      `insert into aa_users
         (email, username, role, is_active, is_staff, is_superuser,
          phrase_hash, totp_secret_enc, enroll_window_until, device_window_until, perms_version)
       values ($1, $2, 'admin', true, true, true,
               NULL, NULL, now() + ($3 || ' hours')::interval, now() + ($3 || ' hours')::interval, 1)`,
      [email, uname, String(ENROLL_HOURS)],
    );
    await c.query("COMMIT");
    console.log(
      `\n  Admin created: ${email} (username: ${uname}).\n` +
        `  Open /auth, log in with the email OTP, then enroll TOTP + your secret phrase\n` +
        `  and claim your first device within ${ENROLL_HOURS}h.\n`,
    );
  } else if (
    existing.rowCount === 1 &&
    existing.rows[0].has_totp === false &&
    existing.rows[0].last_login === null
  ) {
    // Lockout-safe re-run: sole superuser, never enrolled/logged in.
    const sess = await c.query(
      "select 1 from aa_sessions where user_id = $1 limit 1", [existing.rows[0].id]);
    const byEmail = await c.query("select 1 from aa_users where is_superuser and email = $1", [email]);
    if (sess.rowCount !== 0 || byEmail.rowCount === 0) {
      await c.query("ROLLBACK");
      die("Admin already exists. Aborting.");
    }
    await c.query(
      `update aa_users set enroll_window_until = now() + ($1 || ' hours')::interval,
                          device_window_until = now() + ($1 || ' hours')::interval
        where id = $2`,
      [String(ENROLL_HOURS), existing.rows[0].id],
    );
    await c.query("COMMIT");
    console.log(`\n  Refreshed the enroll + device windows (+${ENROLL_HOURS}h) for the un-enrolled admin ${email}.\n`);
  } else {
    await c.query("ROLLBACK");
    die("Admin already exists. Aborting.");
  }
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await c.end();
}

