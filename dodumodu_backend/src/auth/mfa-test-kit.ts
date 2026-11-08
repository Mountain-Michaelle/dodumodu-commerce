// Shared fixtures for the MFA / session integration suites (NOT a test file, so
// importing it never re-registers tests — the old totp-backup.test.ts imported
// totp.test.ts and silently re-ran it).
//
// Rules this kit enforces for every suite that uses it:
//  * FAIL FAST, never skip: no DATABASE_URL = the suite throws (a silently skipped
//    security regression suite is worse than a red one).
//  * LOCALHOST ONLY: a production URL must never reach these tests, which insert and
//    delete rows. Only localhost / 127.0.0.1 / ::1 are accepted.
//  * ISOLATION: every run uses a unique tag + unique IPs, creates its own users, and
//    cleans up everything it created INCLUDING the blocks its failures produced (a
//    leftover 24h ip block from one suite used to cascade into the next).
import assert from "node:assert/strict";
import { registerDbDriver, type Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "./sql";
import { loadKey, newTotpSecret, encryptSecret, sha256, toHex, hotp } from "./crypto";
import { tokenHashHex } from "./keys";
import { vidHashHex } from "./blocks";
import { normalizeBackupCode } from "./totp";
import { requestCode, type EntrySecrets, type RequestCtx } from "./entry";
import { verifyCode } from "./factors";

export type TestSecrets = EntrySecrets & { totpEncKey: Uint8Array };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The one place a suite learns its DB URL. Throws unless it is set AND local. */
export function requireLocalTestDb(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL must be set for MFA integration tests — do not silently skip these critical regression tests.");
  }
  let host: string;
  try { host = new URL(url).hostname; } catch { throw new Error("DATABASE_URL is not a valid URL"); }
  // A non-local database is accepted ONLY when its exact hostname is named in
  // ALLOW_REMOTE_TEST_DB (e.g. a disposable Neon branch). Never a blanket flag.
  if (!LOCAL_HOSTS.has(host) && process.env.ALLOW_REMOTE_TEST_DB !== host) {
    throw new Error(
      `Refusing to run MFA integration tests against non-local host "${host}". ` +
      `Use a throwaway localhost database, or for a disposable remote branch set ALLOW_REMOTE_TEST_DB=${host}.`);
  }
  return url;
}

export function openTestDb(): Db {
  const url = requireLocalTestDb();
  registerDbDriver(pgDriver);
  return pgDriver(url);
}

export { closePools };

export function testSecrets(): TestSecrets {
  return {
    otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
    throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
    totpEncKey: loadKey("DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=", "totp-enc"),
  };
}

export const makeTag = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

let ipCounter = 0;
const ipBase = 100 + Math.floor(Math.random() * 150);
/**
 * A request context with a VALID, run-unique IPv4 (so throttles and ip blocks never
 * collide across suites/runs). It must be a real IPv4: an unparseable address hashes
 * to one shared "invalid" block key and would make every test block every other.
 */
export function freshCtx(): RequestCtx {
  ipCounter += 1;
  const hi = 1 + Math.floor(ipCounter / 250);
  const lo = 1 + (ipCounter % 250);
  return { ip: `10.${ipBase}.${hi}.${lo}`, prefix: `10.${ipBase}.${hi}`, country: "NG", ua: "itest" };
}

/** A random browser id (the __Host-vid cookie value). */
export const newVid = () => `vid-${crypto.randomUUID()}`;

/** Remove EVERYTHING a run created, blocks included. Safe to call twice. */
export async function cleanupTag(db: Db, tag: string): Promise<void> {
  const like = `${tag}%`;
  await q(db, sql`DELETE FROM aa_blocks WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like})
    OR reason IN (SELECT 'auth_failures:' || id::text FROM aa_auth_flows WHERE email LIKE ${like})
    OR reason IN (SELECT 'recovery_fails:' || id::text FROM aa_auth_flows WHERE email LIKE ${like})
    OR block_ref LIKE ${like}`);
  await q(db, sql`DELETE FROM aa_alert_outbox WHERE dedupe_key IN
    (SELECT 'recovery_block:' || id::text FROM aa_auth_flows WHERE email LIKE ${like})`).catch(() => {});
  // Append-only table: set the maintenance flag inside the SAME statement (pooler-safe).
  await q(db, sql`WITH m AS (SELECT set_config('aa.maint', 'on', true)) DELETE FROM aa_auth_log
    WHERE EXISTS (SELECT 1 FROM m) AND user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like})`);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like})`);
  await q(db, sql`DELETE FROM aa_admin_devices WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like})`);
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${like}`);
  await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like})`);
  await q(db, sql`DELETE FROM aa_backup_codes WHERE set_id IN
    (SELECT id FROM aa_backup_code_sets WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like}))`);
  await q(db, sql`DELETE FROM aa_backup_code_sets WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like})`);
  await q(db, sql`DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${like})`).catch(() => {});
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${like}`);
}

export interface EnrolledUser {
  id: string; email: string; secret: string; backupCodes: string[];
}

/**
 * A fully enrolled user: authenticator confirmed, phrase set, and an ACKED backup
 * generation holding `nCodes` known codes — i.e. a "true configured user".
 */
export async function createEnrolledUser(
  db: Db, s: TestSecrets, email: string,
  opts: { role?: "admin" | "staff"; nCodes?: number; lastStep?: number | null } = {},
): Promise<EnrolledUser> {
  const secret = newTotpSecret();
  const enc = await encryptSecret(s.totpEncKey, secret);
  const id = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_users (email, role, totp_secret_enc, totp_enabled_at, totp_last_step)
         VALUES (${email}, ${opts.role ?? "staff"}, ${enc}, now(), ${opts.lastStep ?? null})
         RETURNING id::text AS id`))!.id;
  await q(db, sql`UPDATE aa_users SET phrase_hash = md5('fixture') WHERE id = ${id}::uuid AND phrase_hash IS NULL`);
  await q(db, sql`INSERT INTO aa_backup_code_sets (user_id, generation, acked_at) VALUES (${id}::uuid, 1, now())`);
  const n = opts.nCodes ?? 8;
  const backupCodes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.getRandomValues(new Uint8Array(5));
    const code = `${Array.from(raw.slice(0, 2)).map((b) => b.toString(36).toUpperCase().padStart(2, "0")).join("")}${i}-` +
      `${Array.from(raw.slice(2)).map((b) => b.toString(36).toUpperCase().padStart(2, "0")).join("")}${i}`;
    backupCodes.push(code);
    const hashHex = toHex(await sha256(normalizeBackupCode(code)));
    await q(db, sql`INSERT INTO aa_backup_codes (set_id, code_hash)
      SELECT id, decode(${hashHex}, 'hex') FROM aa_backup_code_sets WHERE user_id = ${id}::uuid`);
  }
  return { id, email, secret, backupCodes };
}

export interface TestFlow { token: string; id: string }

/** Insert a flow already at stage 'totp' (as if the email OTP had just been verified). */
export async function newTotpFlow(
  db: Db, s: TestSecrets, u: { id: string; email: string },
  o: { vid?: string | null; via?: "email" | "device"; trusted?: boolean; stage?: string; ttl?: string } = {},
): Promise<TestFlow> {
  const token = `flow-${crypto.randomUUID()}`;
  const fh = await tokenHashHex(token);
  const vidH = o.vid ? await vidHashHex(s.throttleKey, o.vid) : null;
  const id = (await q1<{ id: string }>(db,
    sql`INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, via, trusted, vid_hash, expires_at)
         VALUES (decode(${fh}, 'hex'), ${u.email}, ${u.id}::uuid, ${o.stage ?? "totp"}, ${o.via ?? "email"},
           ${o.trusted ?? false},
           ${vidH === null ? sql`NULL::bytea` : sql`decode(${vidH}, 'hex')`},
           now() + (${o.ttl ?? "15 minutes"})::interval)
         RETURNING id::text AS id`))!.id;
  return { token, id };
}

/** An ACTIVE admin device (the first-configured / trusted browser). Returns its raw __Host-did cookie value. */
export async function createActiveDevice(db: Db, userId: string): Promise<string> {
  const token = `did-${crypto.randomUUID()}`;
  const hashHex = await tokenHashHex(token);
  await q(db, sql`INSERT INTO aa_admin_devices
    (user_id, token_hash, status, label, created_via, expires_at, last_ip_prefix, last_country)
    VALUES (${userId}::uuid, decode(${hashHex}, 'hex'), 'active', 'itest', 'first_login',
      now() + interval '30 days', NULL, NULL)`);
  return token;
}

export const stepNow = (nowMs = Date.now()) => Math.floor(nowMs / 30000);

/** The code a phone would show for `step`. */
export const codeFor = (secret: string, step: number) => hotp(secret, step);

export async function flowState(db: Db, flowId: string) {
  const r = await q1<{ stage: string; totp_fails: number; recovery_unlocked: boolean }>(db,
    sql`SELECT stage, totp_fails, recovery_unlocked FROM aa_auth_flows WHERE id = ${flowId}::uuid`);
  assert.ok(r, "flow row exists");
  return r;
}

export async function activeBlocks(db: Db, flowId: string) {
  return q<{ kind: string; expires_at: Date | null }>(db,
    sql`SELECT kind, expires_at FROM aa_blocks
         WHERE reason = ${"auth_failures:" + flowId} AND lifted_at IS NULL ORDER BY kind`);
}

/** Full email path up to stage 'totp': requestCode -> verifyCode. */
export async function loginToTotpStage(
  db: Db, s: TestSecrets, email: string, ctx: RequestCtx,
  o: { vid?: string | null; deviceToken?: string | null } = {},
): Promise<string> {
  const req = await requestCode(db, s, email, ctx, o.deviceToken ?? null, o.vid ?? null);
  assert.ok(req.sendCode, "entry issued a code (real path)");
  const v = await verifyCode(db, s, req.flowToken, req.sendCode.code, ctx.ip);
  assert.equal(v.next, "totp");
  return req.flowToken;
}

/** Wrap a Db so tests can count network round trips (statements) a call makes. */
export function countingDb(db: Db): { db: Db; count: () => number; reset: () => void } {
  let n = 0;
  const proxy = new Proxy(db as object, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return (...a: unknown[]) => { n += 1; return (target as { execute: (...x: unknown[]) => unknown }).execute(...a); };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
  return { db: proxy, count: () => n, reset: () => { n = 0; } };
}
