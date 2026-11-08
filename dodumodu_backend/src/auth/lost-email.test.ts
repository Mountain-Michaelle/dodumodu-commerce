// Slice 6: lost-email (spec §4.6 Option A, live DB). Uniform behavior for
// registered/unknown/malformed input; a registered handle enqueues ONE open
// account request per 24 h and at most one alert per cooldown; the per-IP
// lockout fires identically for every input shape.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver, createDb, type Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "./sql";
import { requestLostEmail } from "./lost-email";
import { loadKey } from "./crypto";
import { emailTag } from "./keys";
import { AuthLockedError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
registerDbDriver(pgDriver);
const db: Db = databaseUrl ? createDb(databaseUrl) : (null as unknown as Db);
const tag = `lost:${Date.now().toString(36)}`;
const throttleKey = loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle");

after(async () => {
  if (!databaseUrl) return;
  // Append-only table: the maintenance flag is set INSIDE the same statement, so it
  // works through any pooler (a session-level SET can land on a different connection).
  await q(db, sql`WITH m AS (SELECT set_config('aa.maint', 'on', true)) DELETE FROM aa_auth_log WHERE EXISTS (SELECT 1 FROM m) AND username_attempted LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_account_requests WHERE username_attempted LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  for (const ip of ["10.81.1.1", "10.81.2.2"]) {
    const t = await emailTag(throttleKey, `lostip:${ip}`);
    await q(db, sql`DELETE FROM aa_auth_throttle WHERE key = ${`lost:${t}`}`);
  }
  await closePools();
});

test("lost-email: uniform answers, one open request, capped alert, IP lockout", { skip: !databaseUrl }, async () => {
  const email = `${tag}-user@example.com`;
  const username = `${tag}-handle`;
  await q(db, sql`INSERT INTO aa_users (email, username, role)
    VALUES (${email}, ${username}, 'staff')`);

  const IP = "10.81.1.1";
  // 1st: registered handle -> alert target; one open account request.
  const a1 = await requestLostEmail(db, throttleKey, username, IP);
  assert.equal(a1.alertTo, email);
  const reqs = await q(db,
    sql`SELECT 1 FROM aa_account_requests WHERE username_attempted = ${username} AND status = 'open'`);
  assert.equal(reqs.length, 1);

  // 2nd: same handle -> alert suppressed by the cooldown; still ONE request.
  const a2 = await requestLostEmail(db, throttleKey, username, IP);
  assert.equal(a2.alertTo, null);
  assert.equal((await q(db,
    sql`SELECT 1 FROM aa_account_requests WHERE username_attempted = ${username}`)).length, 1);

  // 3rd: unknown handle -> same shape, no request row, no alert.
  const a3 = await requestLostEmail(db, throttleKey, `${tag}-ghost`, IP);
  assert.equal(a3.alertTo, null);
  assert.equal((await q(db,
    sql`SELECT 1 FROM aa_account_requests WHERE username_attempted LIKE ${tag + "%-ghost"}`)).length, 0);

  // 4th from the same IP: locked out regardless of input shape.
  await assert.rejects(
    requestLostEmail(db, throttleKey, username, IP), AuthLockedError);

  // A different IP is unaffected by the lockout; matching also works by email.
  // The alert cooldown is PER-ACCOUNT (a1 already sent this account's alert),
  // so no second alert fires regardless of the IP.
  const a4 = await requestLostEmail(db, throttleKey, email, "10.81.2.2");
  assert.equal(a4.alertTo, null, "per-account alert cooldown, not per-IP");
  const a5 = await requestLostEmail(db, throttleKey, email, "10.81.2.2");
  assert.equal(a5.alertTo, null);
  // Malformed shapes still answer (no throw beyond the IP lockout itself).
  const a6 = await requestLostEmail(db, throttleKey, undefined, "10.81.2.2");
  assert.equal(a6.alertTo, null);
  void q1;
});