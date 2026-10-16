// Entry routing integration tests — spec §5.1 (realigned M9). REAL requires
// an enrolled TOTP OR an open enrollment window. Skipped when DATABASE_URL is
// absent. Fixtures: one staff user and one admin user with random emails,
// deleted in t.after along with all aa_ rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { loadKey, normalizeEmail } from "./crypto";
import { emailTag } from "./keys";
import { AuthLockedError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `entry-${Date.now().toString(36)}`;
const CTX = { ip: "10.9.8.7", prefix: "10.9.8", country: "NG", ua: "itest" };

function secrets(): EntrySecrets {
  return {
    otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
    throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
  };
}

async function makeUser(db: Db, role: "staff" | "admin", openWindow = true): Promise<string> {
  const email = normalizeEmail(`${tag}-${role}-${Math.random().toString(36).slice(2)}@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, enroll_window_until)
    VALUES (${email}, ${role},
      ${openWindow ? sql`now() + interval '72 hours'` : sql`NULL`})`);
  return email;
}

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

test("entry: enrolled/window user gets code, unknown gets dummy, denied admin gets alert", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();

  const staff = await makeUser(db, "staff");
  const out = await requestCode(db, s, staff, CTX, null);
  assert.ok(out.flowToken.length > 20);
  assert.ok(out.sendCode && out.sendCode.to === staff && out.sendCode.code.length === 10);
  assert.equal(out.sendDeniedAlert, null);

  // Resend within cooldown: same 202 shape, no new email.
  const out2 = await requestCode(db, s, staff, CTX, null);
  assert.ok(out2.flowToken.length > 20);
  assert.equal(out2.sendCode, null);

  // Unknown email: dummy flow, no email, no alert — same 202 shape.
  const unk = await requestCode(db, s, `${tag}-nobody@example.com`, CTX, null);
  assert.ok(unk.flowToken.length > 20);
  assert.equal(unk.sendCode, null);
  assert.equal(unk.sendDeniedAlert, null);

  // Admin with enrollment in order but no device and closed device window:
  // denied — dummy flow + ONE alert.
  const admin = await makeUser(db, "admin");
  const denied = await requestCode(db, s, admin, CTX, null);
  assert.ok(denied.flowToken.length > 20);
  assert.equal(denied.sendCode, null);
  assert.deepEqual(denied.sendDeniedAlert, { to: admin });
  // Second denial within 6 h: no second alert.
  const tagEmail = await emailTag(s.throttleKey, admin);
  const denied2 = await requestCode(db, s, admin, CTX, null);
  assert.equal(denied2.sendDeniedAlert, null);
  void tagEmail;

  // Admin who can never log in (no TOTP, no open window): dummy, NO alert —
  // the alert is for the device gate only, not an enrollment failure (M9).
  const stuck = await makeUser(db, "admin", false);
  const stuckOut = await requestCode(db, s, stuck, CTX, null);
  assert.equal(stuckOut.sendCode, null);
  assert.equal(stuckOut.sendDeniedAlert, null);

  // Locked pair: reserve 3 on a fresh email, 4th request throws AuthLockedError.
  const spam = `${tag}-spam@example.com`;
  await requestCode(db, s, spam, CTX, null);
  await requestCode(db, s, spam, CTX, null);
  await requestCode(db, s, spam, CTX, null);
  await assert.rejects(requestCode(db, s, spam, CTX, null), (e: unknown) => {
    assert.ok(e instanceof AuthLockedError);
    return true;
  });
});