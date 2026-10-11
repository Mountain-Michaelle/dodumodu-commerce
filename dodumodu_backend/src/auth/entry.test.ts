// Entry routing integration tests — spec §5.1.
// Skipped when DATABASE_URL is absent. Fixtures: one staff user and one admin
// user created with random emails, deleted in t.after along with all aa_ rows.
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
const tag = `entry:${Date.now().toString(36)}`;
const CTX = { ip: "10.9.8.7", prefix: "10.9.8", country: "NG", ua: "itest" };

function secrets(): EntrySecrets {
  return {
    otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
    throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
  };
}

async function makeUser(db: Db, role: "staff" | "admin"): Promise<string> {
  const email = normalizeEmail(`${tag}-${role}-${Math.random().toString(36).slice(2)}@example.com`)!;
  await q(
    db, sql`INSERT INTO aa_users (email, role) VALUES (${email}, ${role})`);
  return email;
}

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

test("entry: staff gets code, unknown gets dummy flow, denied admin gets alert", { skip: !databaseUrl }, async (t) => {
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

  // Admin with no device and closed window: denied — dummy flow + ONE alert.
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
