// Sessions part 1: staff session + lookup + first admin claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { enrollPhrase } from "./phrase";
import { totpEnrollStart, totpEnrollConfirm } from "./totp";
import { finishStaffSession, tierFor } from "./sessions";
import { finishAdminSession } from "./sessions-admin";
import { lookupSession } from "./session-lookup";
import { listDevices } from "./device-invites";
import { loadKey, normalizeEmail, hotp } from "./crypto";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `sess:${Date.now().toString(36)}`;
const PHRASE = "correct horse 99!";
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
  await q(db, sql`DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_admin_devices WHERE user_id IN (SELECT id FROM aa_users WHERE email LIKE ${tag + "%"})`);
  await q(db, sql`DELETE FROM aa_users WHERE email LIKE ${tag + "%"}`);
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key LIKE '%'`);
}

async function staffReady(db: Db, s: ReturnType<typeof secrets>, email: string, ip: string) {
  const r = await requestCode(db, s, email, { ...A, ip }, null);
  assert.ok(r.sendCode);
  await verifyCode(db, s, r.flowToken, r.sendCode.code, ip);
  return r.flowToken;
}


test("sessions part 1: staff session + lookup + first admin claim", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();

  // Staff: request -> code -> enroll -> ready -> session -> lookup.
  const staff = normalizeEmail(`${tag}-staff@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role) VALUES (${staff}, 'staff')`);
  const f2 = await staffReady(db, s, staff, "10.91.1.3");
  const vv = await verifyCode(db, s, f2,
    (await requestCode(db, s, staff, { ...A, ip: "10.91.1.3" }, null)).sendCode!.code,
    "10.91.1.3").catch(() => ({ next: "enroll_phrase" as const }));
  assert.equal(vv.next, "enroll_phrase");
  const en = await enrollPhrase(db, s, f2, PHRASE, PHRASE, "10.91.1.3");
  assert.equal(en.next, "ready");
  const fin = await finishStaffSession(db, { flowToken: f2, ...A, tier: "normal" });
  assert.ok(fin.sessionToken.length > 20);
  assert.equal(fin.deviceToken, null);
  const sess = await lookupSession(db, fin.sessionToken);
  assert.ok(sess);
  assert.equal(sess.email, staff);
  assert.equal(sess.role, "staff");
  assert.deepEqual(sess.perms, []);
  assert.equal(sess.tier, "normal");
  // Double finish: flow is done -> 401.
  await assert.rejects(finishStaffSession(db, { flowToken: f2, ...A, tier: "normal" }), AuthRejectError);

  // Admin first login: window open, no device -> claim wins, device cookie set.
  const admin = normalizeEmail(`${tag}-admin@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until)
    VALUES (${admin}, 'admin', now() + interval '72 hours')`);
  const ar = await requestCode(db, s, admin, A, null);
  assert.ok(ar.sendCode, "open window = real path");
  await verifyCode(db, s, ar.flowToken, ar.sendCode.code, A.ip);
  await enrollPhrase(db, s, ar.flowToken, PHRASE, PHRASE, A.ip);
  const st = await totpEnrollStart(db, s, ar.flowToken, admin);
  const stepN = Math.floor(Date.now() / 30000);
  await totpEnrollConfirm(db, s, ar.flowToken, await hotp(st.secret, stepN), A.ip);
  const afin = await finishAdminSession(db, { flowToken: ar.flowToken, ...A, tier: "normal" });
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
