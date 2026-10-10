// scripts/auth/unlock-email.mjs — operator only (spec §5.10).
// Deletes EVERY aa_auth_throttle row for one email (pair, device, strict, fuse
// and send keys all share the HMAC(email) tag). Audited. This is the escape
// hatch for R-NOLOCK residual risk: it can only ever UNLOCK, never lock.
//
//   THROTTLE_KEY=<base64 32B> DATABASE_URL=... \
//     node scripts/auth/unlock-email.mjs user@example.com
import { Client } from "pg";

const b64ToBytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));

async function emailTag(throttleKey, email) {
  const norm = email.trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw", throttleKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(norm)));
  return Buffer.from(sig).toString("base64url");
}

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email) { console.error("usage: node scripts/auth/unlock-email.mjs <email>"); process.exit(2); }
if (!process.env.THROTTLE_KEY) { console.error("THROTTLE_KEY is required"); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(2); }

const tag = await emailTag(b64ToBytes(process.env.THROTTLE_KEY), email);
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
try {
  // Every throttle key for this email contains the tag as a substring.
  const del = await c.query(
    "delete from aa_auth_throttle where key like '%' || $1 || '%'",
    [tag],
  );
  const target = await c.query("select id from aa_users where email = $1", [email]);
  await c.query(
    `insert into aa_audit_events (actor_id, target_id, event, meta)
     values (NULL, $1, 'admin_unlock', $2::jsonb)`,
    [target.rows[0]?.id ?? null, JSON.stringify({ keys_deleted: del.rowCount })],
  );
  console.log(`unlocked ${email}: deleted ${del.rowCount} throttle key(s).`);
} finally {
  await c.end();
}
