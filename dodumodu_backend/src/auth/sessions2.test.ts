// Sessions part 1 (realigned): staff session + lookup + first admin claim.
// First login order: otp -> totp_enroll -> enroll_phrase -> backup_codes ->
// ack -> ready -> session. 'ready' now always implies a proven TOTP (Slice 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { enrollPhrase } from "./phrase";
import { totpEnrollStart, totpEnrollConfirm, ackBackupCodes } from "./totp";
import { finishStaffSession, tierFor } from "./sessions";
import { finishAdminSession } from "./sessions-admin";
import { lookupSession } from "./session-lookup";
import { listDevices } from "./device-invites";
import { loadKey, normalizeEmail, hotp } from "./crypto";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `sess-${Date.now().toString(36)}`;
const PHRASE = "correct-horse-99!";        // §5.2.1: no spaces
const A = { ip: "10.91.1.1", prefix: "10.91.1", country: "NG", ua: "itest" };

function secrets(): EntrySecrets & { totpEncKey: Uint8Array } {
  return {
    otpKey: loadKey("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", "otp"),
    throttleKey: loadKey("CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=", "throttle"),
    totpEncKey: loadKey("DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=", "totp-enc"),
  };
}

async function cleanup(db: Db) {
  await q(db, sql`DELETE FROM aa_auth_flows WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_login_challenges WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_backup_codes WHERE set_id IN
    (SELECT id FROM aa_backup_code_sets WHERE user_id IN
      (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"}))`);
  await q(db, sql`DELETE FROM aa_backup_code_sets WHERE user_id IN
    (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_admin_devices WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

/** Full first-login enrollment to 'ready'. Returns the flow token. */
async function firstLoginToReady(db: Db, s: ReturnType<typeof secrets>, email: string, ip: string) {
  const r = await requestCode(db, s, email, { ...A, ip }, null);
  assert.ok(r.sendCode);
  await verifyCode(db, s, r.flowToken, r.sendCode.code, ip);
  const start = await totpEnrollStart(db, s, r.flowToken, email);
  const step = Math.floor(Date.now() / 30000);
  const conf = await totpEnrollConfirm(db, s, r.flowToken, await hotp(start.secret, step), ip);
  assert.equal(conf.next, "enroll_phrase");
  const e = await enrollPhrase(db, s, r.flowToken, PHRASE, PHRASE, ip);
  assert.equal(e.next, "backup_codes");
  const a = await ackBackupCodes(db, r.flowToken);
  assert.equal(a.next, "ready");
  return r.flowToken;
}

test("sessions part 1: staff session + lookup + first admin claim", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();

  // Staff: full v2 enrollment -> ready -> session -> lookup.
  const staff = normalizeEmail(`${tag}-staff@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, enroll_window_until)
    VALUES (${staff}, 'staff', now() + interval '72 hours')`);
  const f2 = await firstLoginToReady(db, s, staff, "10.91.1.3");
  const fin = await finishStaffSession(db, { flowToken: f2, ...A, ip: "10.91.1.3", tier: "normal" });
  assert.ok(fin.sessionToken.length > 20);
  assert.equal(fin.deviceToken, null);
  const sess = await lookupSession(db, fin.sessionToken);
  assert.ok(sess);
  assert.equal(sess.email, staff);
  assert.equal(sess.role, "staff");
  assert.deepEqual(sess.perms, []);
  assert.equal(sess.tier, "normal");
  // Double finish: flow is done -> 401.
  await assert.rejects(finishStaffSession(db, { flowToken: f2, ...A, ip: "10.91.1.3", tier: "normal" }), AuthRejectError);

  // Admin first login: window open, no device -> claim wins, device cookie set.
  const admin = normalizeEmail(`${tag}-admin@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until, enroll_window_until)
    VALUES (${admin}, 'admin', now() + interval '72 hours', now() + interval '72 hours')`);
  const arFlow = await firstLoginToReady(db, s, admin, A.ip);
  const afin = await finishAdminSession(db, { flowToken: arFlow, ...A, tier: "normal" });
  assert.ok(afin.sessionToken.length > 20);
  assert.ok(afin.deviceToken, "first login issues a device cookie");
  const asess = await lookupSession(db, afin.sessionToken);
  assert.ok(asess);
  assert.equal(asess.role, "admin");
  assert.ok(asess.deviceId);
  const devs = await listDevices(db, asess.userId);
  assert.equal(devs.length, 1);
  assert.equal(devs[0].status, "active");
  void tierFor;
});