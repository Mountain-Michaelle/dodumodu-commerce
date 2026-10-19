// Sessions part 3b: EMAIL-path admin re-login binds the presented __Host-did.
// The one-time first-device window (device_window_until) is spent by setup, so
// every later email flow carries device_id NULL — the finish hash-matches the
// browser's device cookie instead (Appendix F4 exception). Without a cookie,
// with a forged one, the finish still rejects neutrally, and this path never
// issues a second device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "./sql";
import { requestCode, type EntrySecrets } from "./entry";
import { verifyCode } from "./factors";
import { totpEnrollStart, totpEnrollConfirm, ackBackupCodes } from "./totp";
import { verifyTotp } from "./totp-verify";
import { finishAdminSession } from "./sessions-admin";
import { lookupSession } from "./session-lookup";
import { loadKey, normalizeEmail, hotp, decryptSecret } from "./crypto";
import { tokenHashHex } from "./keys";
import { AuthRejectError } from "./errors";

const databaseUrl = process.env.DATABASE_URL;
const tag = `sess3b-${Date.now().toString(36)}`;
const A = { ip: "10.94.1.1", prefix: "10.94.1", country: "NG", ua: "itest" };

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

/** Full email-path ADMIN first login to ready + finish. Returns the device cookie. */
async function firstLogin(db: Db, s: ReturnType<typeof secrets>, email: string): Promise<string> {
  const r = await requestCode(db, s, email, A, null);
  assert.ok(r.sendCode);
  await verifyCode(db, s, r.flowToken, r.sendCode.code, A.ip);
  const start = await totpEnrollStart(db, s, r.flowToken, email);
  const step = Math.floor(Date.now() / 30000);
  const conf = await totpEnrollConfirm(db, s, r.flowToken, await hotp(start.secret, step), A.ip);
  assert.equal(conf.next, "backup_codes");
  assert.equal(conf.backupCodes.length, 8);
  await ackBackupCodes(db, r.flowToken);
  const fin = await finishAdminSession(db, { flowToken: r.flowToken, ...A, tier: "normal" });
  assert.ok(fin.deviceToken, "first login issues a device cookie");
  return fin.deviceToken!;
}

/** Email-path login to 'ready' for an ALREADY enrolled user. Returns the flow token. */
async function loginToReady(db: Db, s: ReturnType<typeof secrets>, email: string): Promise<string> {
  const r = await requestCode(db, s, email, A, null);
  assert.ok(r.sendCode, "requestCode always issues a code (forceNew)");
  await verifyCode(db, s, r.flowToken, r.sendCode.code, A.ip);
  const secRow = await q1<{ e: string }>(db,
    sql`SELECT totp_secret_enc AS e FROM aa_users WHERE email = ${email}`);
  assert.ok(secRow?.e, "user is enrolled");
  const secret = await decryptSecret(s.totpEncKey, secRow.e);
  const step = Math.floor(Date.now() / 30000);
  const tv = await verifyTotp(db, s, r.flowToken, { code: await hotp(secret, step) }, A.ip, true);
  assert.equal(tv.next, "ready");
  // The bug precondition: the email path NEVER carries a device on the flow.
  const flowHash = await tokenHashHex(r.flowToken);
  const fl = await q1<{ device_id: string | null }>(db,
    sql`SELECT device_id FROM aa_auth_flows WHERE token_hash = decode(${flowHash}, 'hex')`);
  assert.equal(fl?.device_id, null, "email-path flow carries device_id NULL");
  return r.flowToken;
}

test("sessions part 3b: email-path admin re-login binds the presented __Host-did", { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const s = secrets();
  const email = normalizeEmail(`${tag}-admin@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until, enroll_window_until)
    VALUES (${email}, 'admin', now() + interval '72 hours', now() + interval '72 hours')`);

  // Setup: first login claims the one-time window and issues the device cookie.
  const deviceToken = await firstLogin(db, s, email);
  const win = await q1<{ open: boolean }>(db,
    sql`SELECT COALESCE(device_window_until > now(), false) AS open
         FROM aa_users WHERE email = ${email}`);
  assert.equal(win!.open, false, "device_window_until consumed (NULL) after the first login");
  const dev = await q1<{ id: string }>(db, sql`
    SELECT d.id FROM aa_admin_devices d JOIN aa_users u ON u.id = d.user_id
     WHERE u.email = ${email} AND d.status = 'active'`);
  assert.ok(dev?.id, "the first-login device is active");

  // 1) Re-login with NO device cookie -> still rejected (the original bug).
  const fNo = await loginToReady(db, s, email);
  await assert.rejects(
    finishAdminSession(db, { flowToken: fNo, ...A, tier: "normal" }),
    AuthRejectError);

  // 2) A forged cookie hash-matches nothing -> still rejected (attack guarantee).
  const fBad = await loginToReady(db, s, email);
  await assert.rejects(
    finishAdminSession(db, { flowToken: fBad, ...A, tier: "normal", deviceToken: "forged-device-token" }),
    AuthRejectError);

  // 3) The real cookie binds the existing device -> session, no second device.
  const fOk = await loginToReady(db, s, email);
  const fin = await finishAdminSession(db,
    { flowToken: fOk, ...A, tier: "normal", deviceToken });
  assert.ok(fin.sessionToken.length > 20, "session issued");
  assert.equal(fin.deviceToken, null, "no second device is issued on this path");
  const sess = await lookupSession(db, fin.sessionToken);
  assert.ok(sess, "email-path re-login session resolves");
  assert.equal(sess.role, "admin");
  assert.equal(sess.deviceId, dev.id, "session binds the existing first_login device");
  const n = await q<{ c: number }>(db, sql`
    SELECT count(*)::int AS c FROM aa_admin_devices d JOIN aa_users u ON u.id = d.user_id
     WHERE u.email = ${email}`);
  assert.equal(n[0].c, 1, "still exactly one device");
});